import { z } from "zod";
import { notFound } from "../lib/errors.js";
import { CARRIERS, detectCarrier } from "../lib/tracking.js";
import { ORDER_STATUSES } from "../lib/validators.js";
import { serializeOrder, updateOrderStatus } from "./checkout.js";

export const orderQuerySchema = z.object({
  status: z.enum(["", ...ORDER_STATUSES]).optional(),
  q: z.string().max(80).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
}).passthrough();

function where(q) {
  const parts = [];
  const params = [];
  if (q.status) { parts.push("status = ?"); params.push(q.status); }
  if (q.from) { parts.push("(created_at AT TIME ZONE 'America/Sao_Paulo')::date >= ?"); params.push(q.from); }
  if (q.to) { parts.push("(created_at AT TIME ZONE 'America/Sao_Paulo')::date <= ?"); params.push(q.to); }
  if (q.q?.trim()) {
    const term = q.q.trim().replace(/[%_\\]/g, ""); // remove curingas do LIKE
    const digits = term.replace(/\D/g, "");
    const like = `%${term}%`;
    parts.push(`(code ILIKE ? OR customer_name ILIKE ? OR email ILIKE ? OR tracking_code ILIKE ?${digits.length >= 4 ? " OR cpf LIKE ? OR phone LIKE ?" : ""})`);
    params.push(like, like, like, like, ...(digits.length >= 4 ? [`%${digits}%`, `%${digits}%`] : []));
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

const PAGE = 30;

export async function listOrders(db, query) {
  const q = orderQuerySchema.parse(query);
  const w = where(q);
  const [totalRow, rows, countRows] = await Promise.all([
    db.one(`SELECT COUNT(*) AS n FROM orders ${w.sql}`, w.params),
    db.all(`SELECT o.*, (SELECT SUM(qty) FROM order_items WHERE order_id = o.id) AS items FROM orders o ${w.sql}
      ORDER BY id DESC LIMIT ? OFFSET ?`, [...w.params, PAGE, (q.page - 1) * PAGE]),
    db.all("SELECT status, COUNT(*) AS n FROM orders GROUP BY status"),
  ]);
  const total = totalRow.n;
  const counts = Object.fromEntries(countRows.map((r) => [r.status, r.n]));
  return {
    total, page: q.page, pageSize: PAGE, pages: Math.max(1, Math.ceil(total / PAGE)), counts,
    orders: rows.map((o) => {
      const a = JSON.parse(o.address);
      return {
        code: o.code, status: o.status, createdAt: o.created_at, name: o.customer_name, email: o.email,
        totalCents: o.total_cents, items: o.items, payment: o.payment_method, shipping: o.shipping_method,
        tracking: o.tracking_code, city: `${a.city}/${a.state}`, coupon: o.coupon_code,
      };
    }),
  };
}

export async function getOrderAdmin(db, config, code) {
  const o = await db.one("SELECT * FROM orders WHERE code = ?", [code]);
  if (!o) throw notFound("Pedido não encontrado");
  return {
    ...(await serializeOrder(db, config, o)),
    customer: { name: o.customer_name, email: o.email, phone: o.phone, cpf: o.cpf },
    address: JSON.parse(o.address),
    internalNote: o.internal_note || "",
    previousOrders: (await db.one("SELECT COUNT(*) AS n FROM orders WHERE email = ? AND id != ? AND status != 'cancelado'", [o.email, o.id])).n,
    mercadopago: o.mp_order_id ? {
      orderId: o.mp_order_id, paymentId: o.mp_payment_id, status: o.payment_status, detail: o.payment_detail,
      paidCents: o.paid_cents, installments: o.installments, brand: o.card_brand, checkedAt: o.payment_checked_at,
      events: await db.all("SELECT source, mp_status, detail, at FROM payment_events WHERE order_id = ? ORDER BY id", [o.id]),
    } : null,
  };
}

export const trackingSchema = z.object({
  trackingCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{8,40}$/, "Código de rastreio inválido"),
  carrier: z.enum(Object.keys(CARRIERS)).optional(),
}).strict();

export const statusSchema = z.object({
  status: z.enum(ORDER_STATUSES),
  note: z.string().trim().max(200).optional(),
  trackingCode: z.string().optional(),
  carrier: z.string().optional(),
}).strict();

export async function setTracking(db, code, input) {
  const t = trackingSchema.parse(input);
  const carrier = t.carrier || detectCarrier(t.trackingCode);
  const r = (await db.run("UPDATE orders SET tracking_code = ?, carrier = ?, updated_at = now() WHERE code = ?", [t.trackingCode, carrier, code]));
  if (r.changes !== 1) throw notFound("Pedido não encontrado");
  return { trackingCode: t.trackingCode, carrier };
}

/** Muda status; ao marcar "enviado" já grava o rastreio (se veio). */
export async function changeStatus(db, config, code, input) {
  const s = statusSchema.parse(input);
  // valida o rastreio antes de mexer no status, para não deixar nada pela metade
  const t = s.trackingCode ? trackingSchema.parse({ trackingCode: s.trackingCode, ...(s.carrier ? { carrier: s.carrier } : {}) }) : null;
  const note = s.status === "enviado" && t ? (s.note || `Rastreio: ${t.trackingCode}`) : s.note;
  await updateOrderStatus(db, config, code, s.status, note);
  if (t) await setTracking(db, code, t);
  return getOrderAdmin(db, config, code);
}

export async function setNote(db, code, note) {
  const n = z.string().max(1000).parse(note ?? "");
  if ((await db.run("UPDATE orders SET internal_note = ? WHERE code = ?", [n, code])).changes !== 1) throw notFound("Pedido não encontrado");
}

/* ---------- CSV (separador ; e BOM para abrir certo no Excel BR) ---------- */
const cell = (v) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // bloqueia injeção de fórmula
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const money = (c) => ((c || 0) / 100).toFixed(2).replace(".", ",");

export function toCsv(header, rows) {
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n");
}

export async function ordersCsv(db, query) {
  const q = orderQuerySchema.parse({ ...query, page: 1 });
  const w = where(q);
  // itens agregados no próprio banco: uma consulta só, mesmo com milhares de pedidos
  const rows = await db.all(`SELECT o.*, (SELECT string_agg(i.qty || 'x ' || i.name || ' (' || i.color || '/' || i.size || ')', ' | ' ORDER BY i.id)
    FROM order_items i WHERE i.order_id = o.id) AS items_text FROM orders o ${w.sql} ORDER BY id DESC LIMIT 20000`, w.params);
  return toCsv(
    ["Pedido", "Data", "Status", "Cliente", "E-mail", "Telefone", "CPF", "Cidade", "UF", "CEP", "Itens", "Subtotal", "Desconto", "Cupom", "Frete", "Total", "Pagamento", "Entrega", "Rastreio"],
    rows.map((o) => {
      const a = JSON.parse(o.address);
      return [o.code, new Date(o.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }), o.status, o.customer_name, o.email, o.phone, o.cpf,
        a.city, a.state, a.cep, o.items_text,
        money(o.subtotal_cents), money(o.discount_cents), o.coupon_code, money(o.shipping_cents), money(o.total_cents),
        o.payment_method, o.shipping_method, o.tracking_code];
    }),
  );
}

export const csvMoney = money;
