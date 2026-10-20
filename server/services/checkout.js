import crypto from "node:crypto";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { imageUrls } from "../lib/images.js";
import { pixPayload } from "../lib/pix.js";
import { shippingOptions } from "../lib/shipping.js";
import { trackingUrl } from "../lib/tracking.js";
import { evaluateCoupon } from "./coupons.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I

const brl = (cents) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function newOrderCode() {
  const bytes = crypto.randomBytes(6);
  return "US-" + [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** Soma quantidades repetidas do mesmo SKU. Ordena por SKU (evita deadlock entre pedidos simultâneos). */
function mergeItems(items, maxQty) {
  const map = new Map();
  for (const { sku, qty } of items) map.set(sku, (map.get(sku) || 0) + qty);
  for (const [sku, qty] of map) if (qty > maxQty) throw badRequest(`Máximo de ${maxQty} unidades por item`, { sku });
  return [...map].map(([sku, qty]) => ({ sku, qty })).sort((a, b) => a.sku - b.sku);
}

/** Busca os SKUs no banco: preço SEMPRE vem do servidor, nunca do cliente. */
async function resolveLines(db, items) {
  const ids = items.map((i) => i.sku);
  const rows = await db.all(`
    SELECT s.id AS sku, s.size, s.qty AS stock, v.color, v.images, p.slug, p.name, p.line, p.price_cents
    FROM skus s JOIN variants v ON v.id = s.variant_id JOIN products p ON p.id = v.product_id
    WHERE p.active = 1 AND s.id IN (${ids.map(() => "?").join(",")})`, ids);
  const bySku = new Map(rows.map((r) => [r.sku, r]));
  return items.map(({ sku, qty }) => {
    const r = bySku.get(sku);
    if (!r) return { sku, qty, missing: true };
    const img = JSON.parse(r.images)[0];
    return {
      sku, qty,
      slug: r.slug, name: r.name, line: r.line, color: r.color, size: r.size,
      image: img ? imageUrls(img).sm : null,
      unitPriceCents: r.price_cents,
      lineTotalCents: r.price_cents * qty,
      stock: r.stock,
      available: r.stock >= qty,
    };
  });
}

/** Cotação do carrinho (não reserva estoque). Problemas voltam em `issues` para o front exibir. */
export async function quote(db, config, { items, cep, coupon }) {
  const merged = mergeItems(items, config.maxQtyPerItem);
  const lines = await resolveLines(db, merged);
  const valid = lines.filter((l) => !l.missing);
  const issues = [];
  for (const l of lines) {
    if (l.missing) issues.push({ sku: l.sku, type: "missing", message: "Produto indisponível" });
    else if (!l.available) issues.push({
      sku: l.sku, type: "stock",
      message: l.stock === 0 ? `${l.name} (${l.color}, ${l.size}) esgotou` : `Só restam ${l.stock} un. de ${l.name} (${l.color}, ${l.size})`,
      maxQty: l.stock,
    });
  }
  // mantém a ordem em que o cliente adicionou
  const order = new Map(items.map((i, k) => [i.sku, k]));
  valid.sort((a, b) => order.get(a.sku) - order.get(b.sku));
  const subtotal = valid.reduce((s, l) => s + l.lineTotalCents, 0);
  const { coupon: couponInfo, discount, freeShipping } = await evaluateCoupon(db, coupon, { lines: valid });
  const afterDiscount = subtotal - discount;
  const shipping = cep ? shippingOptions(cep, afterDiscount, config.freeShippingCents, { freeCoupon: freeShipping }) : null;
  return {
    lines: valid.map(({ stock, ...l }) => ({ ...l, maxQty: Math.min(stock, config.maxQtyPerItem) })),
    issues,
    subtotalCents: subtotal,
    discountCents: discount,
    coupon: couponInfo,
    shipping,
    freeShippingCents: config.freeShippingCents,
    remainingForFreeCents: freeShipping ? 0 : Math.max(0, config.freeShippingCents - afterDiscount),
  };
}

function paymentInfo(config, order, items) {
  const store = config.store;
  const summary = [
    `Olá, US! Acabei de fazer o pedido *${order.code}* no site.`,
    ...items.map((i) => `• ${i.qty}x ${i.name} — ${i.color} / ${i.size}`),
    `Total: *${brl(order.total_cents)}*`,
    `Pagamento: ${order.payment_method === "pix" ? "Pix" : order.payment_method === "cartao" ? "Cartão (link de pagamento)" : "Combinar pelo WhatsApp"}`,
  ].join("\n");
  const info = {
    method: order.payment_method,
    whatsappUrl: `https://wa.me/${store.whatsapp}?text=${encodeURIComponent(summary)}`,
  };
  if (order.payment_method === "pix") {
    info.pix = {
      key: store.pixKey,
      copyPaste: pixPayload({
        key: store.pixKey, name: store.pixMerchantName, city: store.pixMerchantCity,
        amountCents: order.total_cents, txid: order.code.replace("-", ""),
      }),
      expiresInHours: config.orderTtlHours,
    };
  }
  return info;
}

export async function serializeOrder(db, config, order, { withPayment = false } = {}) {
  const [items, events] = await Promise.all([
    db.all("SELECT * FROM order_items WHERE order_id = ? ORDER BY id", [order.id]),
    db.all("SELECT status, note, at FROM order_events WHERE order_id = ? ORDER BY id", [order.id]),
  ]);
  const address = JSON.parse(order.address);
  const out = {
    code: order.code,
    status: order.status,
    createdAt: order.created_at,
    customer: { name: order.customer_name, email: order.email },
    address: { city: address.city, state: address.state, district: address.district },
    items: items.map((i) => ({
      name: i.name, slug: i.product_slug, color: i.color, size: i.size, image: i.image,
      qty: i.qty, unitPriceCents: i.unit_price_cents, lineTotalCents: i.unit_price_cents * i.qty,
    })),
    shippingMethod: order.shipping_method,
    subtotalCents: order.subtotal_cents,
    discountCents: order.discount_cents,
    shippingCents: order.shipping_cents,
    totalCents: order.total_cents,
    couponCode: order.coupon_code,
    paymentMethod: order.payment_method,
    tracking: order.tracking_code
      ? { code: order.tracking_code, carrier: order.carrier, url: trackingUrl(order.tracking_code), shippedAt: order.shipped_at }
      : null,
    timeline: events,
  };
  if (withPayment && order.status === "aguardando_pagamento") out.payment = paymentInfo(config, order, items);
  return out;
}

const isUniqueViolation = (err, constraint) => err?.code === "23505" && (!constraint || String(err.constraint).includes(constraint));

export async function createOrder(db, config, input, idempotencyKey) {
  const replay = async () => {
    const existing = await db.one("SELECT * FROM orders WHERE idempotency_key = ?", [idempotencyKey]);
    return existing ? { order: await serializeOrder(db, config, existing, { withPayment: true }), replay: true } : null;
  };
  if (idempotencyKey) {
    const r = await replay();
    if (r) return r;
  }

  let order;
  try {
    order = await db.tx(async (t) => {
      const merged = mergeItems(input.items, config.maxQtyPerItem);
      const lines = await resolveLines(t, merged);

      const missing = lines.filter((l) => l.missing);
      if (missing.length) throw badRequest("Há produtos indisponíveis no carrinho", { skus: missing.map((m) => m.sku) });
      const short = lines.filter((l) => !l.available);
      if (short.length) {
        throw conflict("Estoque insuficiente para alguns itens", {
          issues: short.map((l) => ({ sku: l.sku, maxQty: l.stock, message: `Só restam ${l.stock} un. de ${l.name} (${l.color}, ${l.size})` })),
        });
      }

      const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
      const { coupon, discount, freeShipping } = await evaluateCoupon(t, input.coupon, { lines, customer: input.customer });
      if (coupon && !coupon.valid) throw badRequest(coupon.message, { field: "coupon" });

      const ship = shippingOptions(input.address.cep, subtotal - discount, config.freeShippingCents, { freeCoupon: freeShipping })
        .options.find((o) => o.id === input.shipping);
      const total = subtotal - discount + ship.priceCents;

      // baixa de estoque com guarda: se outra compra levou a peça no meio do caminho, aborta tudo
      for (const l of lines) {
        const r = await t.run("UPDATE skus SET qty = qty - ? WHERE id = ? AND qty >= ?", [l.qty, l.sku, l.qty]);
        if (r.changes !== 1) throw conflict("Estoque insuficiente", { issues: [{ sku: l.sku, message: `${l.name} (${l.color}, ${l.size}) acabou de esgotar` }] });
      }
      if (coupon) {
        const used = await t.run("UPDATE coupons SET uses = uses + 1 WHERE code = ? AND (max_uses IS NULL OR uses < max_uses)", [coupon.code]);
        if (used.changes !== 1) throw badRequest("Cupom esgotado", { field: "coupon" });
      }

      let code;
      for (let i = 0; i < 5; i++) {
        code = newOrderCode();
        if (!(await t.one("SELECT 1 FROM orders WHERE code = ?", [code]))) break;
      }
      const c = input.customer;
      const { id: orderId } = await t.one(`INSERT INTO orders
        (code,status,customer_name,email,phone,cpf,address,shipping_method,shipping_cents,subtotal_cents,discount_cents,total_cents,coupon_code,payment_method,idempotency_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`, [code, "aguardando_pagamento", c.name, c.email, c.phone, c.cpf, JSON.stringify(input.address),
        input.shipping, ship.priceCents, subtotal, discount, total, coupon?.code ?? null, input.payment, idempotencyKey ?? null]);

      const params = [];
      const values = lines.map((l) => {
        params.push(orderId, l.sku, l.slug, l.name, l.color, l.size, l.image, l.unitPriceCents, l.qty);
        return "(?,?,?,?,?,?,?,?,?)";
      }).join(",");
      await t.run(`INSERT INTO order_items (order_id,sku_id,product_slug,name,color,size,image,unit_price_cents,qty) VALUES ${values}`, params);
      await t.run("INSERT INTO order_events (order_id,status,note) VALUES (?,?,?)", [orderId, "aguardando_pagamento", "Pedido recebido"]);
      return t.one("SELECT * FROM orders WHERE id = ?", [orderId]);
    });
  } catch (err) {
    // duplo clique chegando ao mesmo tempo: o segundo devolve o pedido do primeiro
    if (idempotencyKey && isUniqueViolation(err, "idempotency")) {
      const r = await replay();
      if (r) return r;
    }
    throw err;
  }

  return { order: await serializeOrder(db, config, order, { withPayment: true }), replay: false };
}

export async function trackOrder(db, config, code, email) {
  const order = await db.one("SELECT * FROM orders WHERE code = ?", [code]);
  // mesma resposta para "não existe" e "e-mail não confere" — evita enumeração de pedidos
  if (!order) throw notFound("Pedido não encontrado");
  const a = Buffer.from(order.email);
  const b = Buffer.from(email);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw notFound("Pedido não encontrado");
  return serializeOrder(db, config, order, { withPayment: true });
}

const TRANSITIONS = {
  aguardando_pagamento: ["pago", "cancelado"],
  pago: ["em_separacao", "cancelado"],
  em_separacao: ["enviado", "cancelado"],
  enviado: ["entregue"],
  entregue: [],
  cancelado: [],
};

/** Muda status validando a transição; cancelamento devolve o estoque uma única vez. Usar dentro de db.tx. */
async function applyStatus(t, order, status, note) {
  if (order.status === status) return order;
  if (!TRANSITIONS[order.status].includes(status)) {
    throw conflict(`Não é possível mudar de "${order.status}" para "${status}"`);
  }
  if (status === "cancelado" && !order.stock_restored) {
    const items = await t.all("SELECT sku_id, qty FROM order_items WHERE order_id = ? ORDER BY sku_id", [order.id]);
    for (const i of items) await t.run("UPDATE skus SET qty = qty + ? WHERE id = ?", [i.qty, i.sku_id]);
    if (order.coupon_code) await t.run("UPDATE coupons SET uses = GREATEST(uses - 1, 0) WHERE code = ?", [order.coupon_code]);
    await t.run("UPDATE orders SET stock_restored = 1 WHERE id = ?", [order.id]);
  }
  await t.run(`UPDATE orders SET status = ?, updated_at = now()${status === "enviado" ? ", shipped_at = now()" : ""} WHERE id = ?`, [status, order.id]);
  await t.run("INSERT INTO order_events (order_id,status,note) VALUES (?,?,?)", [order.id, status, note ?? null]);
  return t.one("SELECT * FROM orders WHERE id = ?", [order.id]);
}

export async function updateOrderStatus(db, config, code, status, note) {
  const updated = await db.tx(async (t) => {
    // FOR UPDATE: dois cliques em "cancelar" ao mesmo tempo não devolvem o estoque duas vezes
    const order = await t.one("SELECT * FROM orders WHERE code = ? FOR UPDATE", [code]);
    if (!order) throw notFound("Pedido não encontrado");
    return applyStatus(t, order, status, note);
  });
  return serializeOrder(db, config, updated);
}

/** Cancela pedidos não pagos após o prazo e devolve o estoque. */
export async function expireStaleOrders(db, ttlHours, now = Date.now()) {
  const cutoff = new Date(now - ttlHours * 3600_000).toISOString();
  const stale = await db.all("SELECT code FROM orders WHERE status = 'aguardando_pagamento' AND created_at < ?", [cutoff]);
  let n = 0;
  for (const { code } of stale) {
    await db.tx(async (t) => {
      const order = await t.one("SELECT * FROM orders WHERE code = ? FOR UPDATE", [code]);
      if (order?.status === "aguardando_pagamento") { await applyStatus(t, order, "cancelado", "Pagamento não identificado no prazo"); n++; }
    });
  }
  return n;
}

// Na Vercel não há servidor ligado o tempo todo: a expiração roda pelo cron diário e também
// "de carona" quando alguém abre o painel (no máximo a cada 5 minutos por instância).
let lastSweep = 0;
export function sweepThrottled(db, ttlHours, everyMs = 5 * 60_000) {
  if (Date.now() - lastSweep < everyMs) return Promise.resolve(0);
  lastSweep = Date.now();
  return expireStaleOrders(db, ttlHours).catch((err) => { console.error("[expiração]", err.message); return 0; });
}
