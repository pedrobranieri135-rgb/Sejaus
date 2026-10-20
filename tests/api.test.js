import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { crc16 } from "../server/lib/pix.js";
import { isValidCpf } from "../server/lib/validators.js";
import { expireStaleOrders } from "../server/services/checkout.js";
import { hasDatabase, skipReason, startTestStore } from "./helpers.js";

let db, base, config, store;
const TOKEN = "test-admin-token-123";

const call = async (method, url, body, headers = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text };
};
const adminH = { Authorization: `Bearer ${TOKEN}` };

const customer = { name: "Maria Silva", email: "maria@example.com", phone: "(11) 98765-4321", cpf: "529.982.247-25" };
const address = { cep: "01310-100", street: "Av. Paulista", number: "1000", district: "Bela Vista", city: "São Paulo", state: "sp" };

async function skuWithStock(min = 3) {
  return (await db.one(`SELECT s.id, s.qty, p.price_cents FROM skus s JOIN variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id
    WHERE s.qty >= ? ORDER BY s.id LIMIT 1`, [min]));
}
const order = (items, extra = {}) => ({ items, customer, address, shipping: "padrao", payment: "pix", ...extra });

before(async () => {
  if (!hasDatabase) return;
  store = await startTestStore({ adminToken: TOKEN });
  ({ db, base, config } = store);
});
after(async () => { await store?.stop(); });

describe("catálogo", { skip: !hasDatabase && skipReason }, () => {
  test("lista os 26 produtos com variantes e SKUs", async () => {
    const r = await call("GET", "/api/products");
    assert.equal(r.status, 200);
    assert.equal(r.body.count, 26);
    const p = r.body.products[0];
    assert.ok(p.variants.length > 0 && p.variants[0].skus.length > 0);
    assert.ok(p.variants[0].images[0].lg.startsWith("/img/p/"));
    assert.equal("qty" in p.variants[0].skus[0], false, "não expõe quantidade exata");
  });
  test("filtra por linha, categoria e busca sem acento", async () => {
    assert.equal((await call("GET", "/api/products?line=adapt")).body.count, 3);
    assert.ok((await call("GET", "/api/products?category=macacoes")).body.products.every((p) => p.category === "macacoes"));
    assert.ok((await call("GET", "/api/products?q=calca%20flare")).body.count >= 2);
  });
  test("ignora parâmetros inválidos e trata array em query", async () => {
    assert.equal((await call("GET", "/api/products?line=xxx")).status, 200);
    assert.equal((await call("GET", "/api/products?q[]=a&q[]=b")).status, 200);
  });
  test("produto inexistente → 404", async () => {
    assert.equal((await call("GET", "/api/products/nao-existe")).status, 404);
  });
});

describe("carrinho / cotação", { skip: !hasDatabase && skipReason }, () => {
  test("preço vem do servidor e frete grátis acima do limite", async () => {
    const s = await skuWithStock(3);
    const r = await call("POST", "/api/cart/quote", { items: [{ sku: s.id, qty: 3, price: 1 }], cep: "01310100" });
    assert.equal(r.status, 400, "campos extras (ex.: price) são rejeitados");
    const ok = await call("POST", "/api/cart/quote", { items: [{ sku: s.id, qty: 3 }], cep: "01310100" });
    assert.equal(ok.body.subtotalCents, s.price_cents * 3);
    const padrao = ok.body.shipping.options.find((o) => o.id === "padrao");
    assert.equal(padrao.priceCents, s.price_cents * 3 >= config.freeShippingCents ? 0 : padrao.originalCents);
  });
  test("cupom válido, inválido e com mínimo", async () => {
    const s = await skuWithStock(1);
    const ok = await call("POST", "/api/cart/quote", { items: [{ sku: s.id, qty: 1 }], coupon: "bemvindous" });
    assert.equal(ok.body.coupon.valid, true);
    assert.equal(ok.body.discountCents, Math.round(s.price_cents * 0.1));
    const bad = await call("POST", "/api/cart/quote", { items: [{ sku: s.id, qty: 1 }], coupon: "NAOEXISTE" });
    assert.equal(bad.body.coupon.valid, false);
    assert.equal(bad.body.discountCents, 0);
    const min = await call("POST", "/api/cart/quote", { items: [{ sku: s.id, qty: 1 }], coupon: "FIRSTCHAPTER" });
    assert.equal(min.body.coupon.valid, s.price_cents >= 49900);
  });
  test("aponta falta de estoque e SKU inexistente", async () => {
    const s = await skuWithStock(1);
    const r = await call("POST", "/api/cart/quote", { items: [{ sku: s.id, qty: 10 }, { sku: 999999, qty: 1 }] });
    assert.equal(r.status, 200);
    assert.ok(r.body.issues.some((i) => i.type === "missing"));
    if (s.qty < 10) assert.ok(r.body.issues.some((i) => i.type === "stock"));
  });
  test("quantidade inválida → 400", async () => {
    for (const qty of [0, -1, 11, 1.5, "abc"]) {
      assert.equal((await call("POST", "/api/cart/quote", { items: [{ sku: 1, qty }] })).status, 400, `qty=${qty}`);
    }
  });
  test("JSON malformado e corpo gigante", async () => {
    assert.equal((await call("POST", "/api/cart/quote", "{oops")).status, 400);
    assert.equal((await call("POST", "/api/cart/quote", { items: [], pad: "x".repeat(30_000) })).status, 413);
  });
});

describe("pedidos", { skip: !hasDatabase && skipReason }, () => {
  test("cria pedido, baixa estoque e gera Pix válido", async () => {
    const s = await skuWithStock(2);
    const r = await call("POST", "/api/orders", order([{ sku: s.id, qty: 2 }]));
    assert.equal(r.status, 201, r.text);
    assert.match(r.body.code, /^US-[A-Z0-9]{6}$/);
    assert.equal(r.body.subtotalCents, s.price_cents * 2);
    assert.equal(r.body.totalCents, r.body.subtotalCents - r.body.discountCents + r.body.shippingCents);
    assert.equal((await db.one("SELECT qty FROM skus WHERE id=?", [s.id])).qty, s.qty - 2);
    const pix = r.body.payment.pix.copyPaste;
    assert.equal(crc16(pix.slice(0, -4)), pix.slice(-4));
    assert.ok(r.body.payment.whatsappUrl.startsWith("https://wa.me/"));
    assert.equal(r.body.customer.cpf, undefined, "não devolve CPF");
  });
  test("valida dados do cliente (CPF, e-mail, telefone, UF)", async () => {
    const s = await skuWithStock(1);
    const r = await call("POST", "/api/orders", {
      ...order([{ sku: s.id, qty: 1 }]),
      customer: { name: "Jo", email: "x@", phone: "123", cpf: "111.111.111-11" },
      address: { ...address, state: "XX" },
    });
    assert.equal(r.status, 400);
    for (const f of ["customer.name", "customer.email", "customer.phone", "customer.cpf", "address.state"]) assert.ok(r.body.fields[f], f);
  });
  test("não vende mais do que o estoque (409) e não altera nada", async () => {
    const s = await skuWithStock(1);
    (await db.run("UPDATE skus SET qty = 1 WHERE id = ?", [s.id]));
    const other = (await db.one("SELECT id, qty FROM skus WHERE qty >= 1 AND id != ? LIMIT 1", [s.id]));
    const r = await call("POST", "/api/orders", order([{ sku: other.id, qty: 1 }, { sku: s.id, qty: 2 }]));
    assert.equal(r.status, 409);
    assert.equal((await db.one("SELECT qty FROM skus WHERE id=?", [other.id])).qty, other.qty, "rollback do outro item");
  });
  test("pedidos simultâneos pela última peça: só um passa", async () => {
    const s = await skuWithStock(1);
    (await db.run("UPDATE skus SET qty = 1 WHERE id = ?", [s.id]));
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => call("POST", "/api/orders", order([{ sku: s.id, qty: 1 }]))));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 4);
    assert.equal((await db.one("SELECT qty FROM skus WHERE id=?", [s.id])).qty, 0);
  });
  test("Idempotency-Key evita pedido duplicado no duplo clique", async () => {
    const s = await skuWithStock(2);
    const key = "a1b2c3d4-e5f6-4711-8899-aabbccddeeff";
    const a = await call("POST", "/api/orders", order([{ sku: s.id, qty: 1 }]), { "Idempotency-Key": key });
    const b = await call("POST", "/api/orders", order([{ sku: s.id, qty: 1 }]), { "Idempotency-Key": key });
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(a.body.code, b.body.code);
    assert.equal((await db.one("SELECT qty FROM skus WHERE id=?", [s.id])).qty, s.qty - 1);
  });
  test("cupom inválido no pedido é recusado (não ignorado em silêncio)", async () => {
    const s = await skuWithStock(1);
    const r = await call("POST", "/api/orders", order([{ sku: s.id, qty: 1 }], { coupon: "FAKE" }));
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "coupon");
  });
  test("rastreio exige e-mail correto", async () => {
    const s = await skuWithStock(1);
    const o = (await call("POST", "/api/orders", order([{ sku: s.id, qty: 1 }]))).body;
    assert.equal((await call("POST", "/api/orders/track", { code: o.code, email: "MARIA@example.com" })).status, 200);
    assert.equal((await call("POST", "/api/orders/track", { code: o.code, email: "outra@example.com" })).status, 404);
    assert.equal((await call("POST", "/api/orders/track", { code: "US-ZZZZZZ", email: "maria@example.com" })).status, 404);
  });
});

describe("admin", { skip: !hasDatabase && skipReason }, () => {
  test("exige token", async () => {
    assert.equal((await call("GET", "/api/admin/orders")).status, 401);
    assert.equal((await call("GET", "/api/admin/orders", undefined, { Authorization: "Bearer errado" })).status, 401);
    assert.equal((await call("GET", "/api/admin/orders", undefined, adminH)).status, 200);
  });
  test("fluxo de status e cancelamento devolve estoque uma vez", async () => {
    const s = await skuWithStock(2);
    const o = (await call("POST", "/api/orders", order([{ sku: s.id, qty: 2 }]))).body;
    assert.equal((await call("PATCH", `/api/admin/orders/${o.code}`, { status: "enviado" }, adminH)).status, 409, "pula etapas → 409");
    assert.equal((await call("PATCH", `/api/admin/orders/${o.code}`, { status: "pago" }, adminH)).status, 200);
    assert.equal((await call("PATCH", `/api/admin/orders/${o.code}`, { status: "cancelado" }, adminH)).status, 200);
    assert.equal((await db.one("SELECT qty FROM skus WHERE id=?", [s.id])).qty, s.qty);
    assert.equal((await call("PATCH", `/api/admin/orders/${o.code}`, { status: "cancelado" }, adminH)).status, 200, "idempotente");
    assert.equal((await db.one("SELECT qty FROM skus WHERE id=?", [s.id])).qty, s.qty, "não devolve duas vezes");
  });
  test("ajuste de estoque valida valor", async () => {
    const s = await skuWithStock(1);
    assert.equal((await call("PATCH", `/api/admin/stock/${s.id}`, { qty: -5 }, adminH)).status, 400);
    assert.equal((await call("PATCH", `/api/admin/stock/${s.id}`, { qty: 7 }, adminH)).status, 200);
    assert.equal((await call("PATCH", `/api/admin/stock/99999999`, { qty: 7 }, adminH)).status, 404);
  });
});

describe("rotinas", { skip: !hasDatabase && skipReason }, () => {
  test("pedido não pago expira e devolve estoque", async () => {
    const s = await skuWithStock(1);
    const o = (await call("POST", "/api/orders", order([{ sku: s.id, qty: 1 }]))).body;
    const n = await expireStaleOrders(db, 48, Date.now() + 49 * 3600_000);
    assert.ok(n >= 1);
    assert.equal((await db.one("SELECT status FROM orders WHERE code=?", [o.code])).status, "cancelado");
    assert.equal((await db.one("SELECT qty FROM skus WHERE id=?", [s.id])).qty, s.qty);
  });
  test("newsletter valida e não duplica", async () => {
    assert.equal((await call("POST", "/api/newsletter", { email: "nao-e-email" })).status, 400);
    assert.equal((await call("POST", "/api/newsletter", { email: "a@b.com" })).status, 201);
    assert.equal((await call("POST", "/api/newsletter", { email: "A@B.com" })).status, 201);
    assert.equal((await db.one("SELECT COUNT(*) n FROM newsletter")).n, 1);
  });
  test("validador de CPF", () => {
    assert.equal(isValidCpf("529.982.247-25"), true);
    assert.equal(isValidCpf("123.456.789-00"), false);
    assert.equal(isValidCpf("000.000.000-00"), false);
  });
  test("headers de segurança e rota inexistente", async () => {
    const res = await fetch(base + "/api/products");
    assert.ok(res.headers.get("content-security-policy"));
    assert.equal(res.headers.get("x-powered-by"), null);
    assert.equal((await call("GET", "/api/nada")).status, 404);
  });
});
