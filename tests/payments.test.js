import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { verifyWebhookSignature } from "../server/lib/mercadopago.js";
import { ensureBootstrapAdmin } from "../server/services/auth.js";
import { hasDatabase, startTestStore } from "./helpers.js";

/* ---------------- assinatura do webhook (não precisa de rede) ---------------- */
describe("assinatura do webhook do Mercado Pago", () => {
  const secret = "segredo-de-teste";
  const sign = (id, reqId, ts) => crypto.createHmac("sha256", secret).update(`id:${id};request-id:${reqId};ts:${ts};`).digest("hex");
  const now = Date.now();

  test("aceita assinatura correta (id em minúsculas, como manda a documentação)", () => {
    const v1 = sign("ord01abc", "req-1", now);
    assert.equal(verifyWebhookSignature({ xSignature: `ts=${now},v1=${v1}`, xRequestId: "req-1", dataId: "ORD01ABC", secret, now }), true);
  });
  test("recusa assinatura adulterada, segredo errado, sem cabeçalho e aviso antigo (replay)", () => {
    const v1 = sign("ord01abc", "req-1", now);
    assert.equal(verifyWebhookSignature({ xSignature: `ts=${now},v1=${v1}`, xRequestId: "req-1", dataId: "ORD01XYZ", secret, now }), false);
    assert.equal(verifyWebhookSignature({ xSignature: `ts=${now},v1=${v1}`, xRequestId: "req-1", dataId: "ORD01ABC", secret: "outro", now }), false);
    assert.equal(verifyWebhookSignature({ xSignature: undefined, xRequestId: "req-1", dataId: "ORD01ABC", secret, now }), false);
    const old = now - 60 * 60_000;
    assert.equal(verifyWebhookSignature({ xSignature: `ts=${old},v1=${sign("ord01abc", "req-1", old)}`, xRequestId: "req-1", dataId: "ORD01ABC", secret, now }), false);
  });
});

/* ---------------- fluxo real no ambiente de teste do Mercado Pago ---------------- */
const mpEnabled = hasDatabase && !!process.env.MP_ACCESS_TOKEN && !!process.env.MP_PUBLIC_KEY;
const skip = !mpEnabled && "Defina DATABASE_URL, MP_ACCESS_TOKEN e MP_PUBLIC_KEY (credenciais de TESTE) para rodar";

describe("pagamento automático (Mercado Pago, ambiente de teste)", { skip }, () => {
  const WEBHOOK_SECRET = "segredo-webhook-teste";
  let store, base, db, cookie;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  const customer = { name: "Cliente Teste", email: "cliente.teste.seja@gmail.com", phone: "67998313659", cpf: "52998224725" };
  const address = { cep: "79002000", street: "Rua Teste", number: "1", district: "Centro", city: "Campo Grande", state: "MS" };
  const skuWith = async (min) => (await db.one("SELECT s.id, s.qty FROM skus s WHERE s.qty >= ? ORDER BY s.id LIMIT 1", [min]));
  const cardToken = async (holder) => {
    const r = await fetch(`https://api.mercadopago.com/v1/card_tokens?public_key=${process.env.MP_PUBLIC_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ card_number: "5480832801033311", security_code: "123", expiration_month: 11, expiration_year: 2030, cardholder: { name: holder, identification: { type: "CPF", number: "12345678909" } } }),
    });
    return (await r.json()).id;
  };
  const card = async (holder, installments = 1) => ({ token: await cardToken(holder), paymentMethodId: "master", type: "credit_card", installments, identification: { type: "CPF", number: "12345678909" } });
  const waitFor = async (fn, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 3000)); }
    return null;
  };

  before(async () => {
    store = await startTestStore({
      adminEmail: "dono@sejaus.com.br", adminPassword: "senha-forte-123", mpTestPayerName: "APRO",
      mercadopago: { accessToken: process.env.MP_ACCESS_TOKEN, publicKey: process.env.MP_PUBLIC_KEY, webhookSecret: WEBHOOK_SECRET, maxInstallments: 3 },
    });
    ({ base, db } = store);
    await ensureBootstrapAdmin(db, store.config);
    const r = await fetch(base + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "dono@sejaus.com.br", password: "senha-forte-123" }) });
    cookie = r.headers.get("set-cookie").split(";")[0];
  });
  after(async () => { await store?.stop(); });

  test("meta informa pagamento online e a Public Key (nunca o Access Token)", async () => {
    const r = await call("GET", "/api/meta");
    assert.equal(r.json.payments.online, true);
    assert.equal(r.json.payments.publicKey, process.env.MP_PUBLIC_KEY);
    assert.ok(!r.text.includes(process.env.MP_ACCESS_TOKEN));
  });

  let pixOrder;
  test("Pix: gera QR Code do pedido e confirma sozinho", async () => {
    const s = await skuWith(2);
    const r = await call("POST", "/api/orders", { items: [{ sku: s.id, qty: 1 }], customer, address, shipping: "padrao", payment: "pix" }, { "Idempotency-Key": crypto.randomUUID() });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.payment.automatic, true);
    assert.ok(r.json.payment.pix.qrBase64.length > 100, "imagem do QR");
    assert.match(r.json.payment.pix.copyPaste, /^000201/);
    pixOrder = r.json;
    const paid = await waitFor(async () => {
      const p = await call("POST", "/api/orders/payment-status", { code: pixOrder.code, email: customer.email });
      return p.json.status === "pago" ? p.json : null;
    });
    assert.ok(paid, "pedido Pix deveria virar pago (conta de teste aprova o nome APRO)");
    assert.equal(paid.paymentStatus, "pago");
  });

  test("cartão sem dados: cria o pedido e devolve o link do Mercado Pago (Checkout Pro)", async () => {
    const s = await skuWith(1);
    const r = await call("POST", "/api/orders", { items: [{ sku: s.id, qty: 1 }], customer, address, shipping: "padrao", payment: "cartao" }, { "Idempotency-Key": crypto.randomUUID() });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.status, "aguardando_pagamento");
    assert.match(r.json.payment.checkoutUrl, /^https:\/\/www\.mercadopago\.com\.br\/checkout\/v1\/redirect\?pref_id=/);
    // ainda sem pagamento: a consulta não muda nada nem cancela o pedido
    const st = await call("POST", "/api/orders/payment-status", { code: r.json.code, email: customer.email });
    assert.equal(st.status, 200, st.text);
    assert.equal(st.json.status, "aguardando_pagamento");
    assert.equal(st.json.paymentStatus, "pendente");
  });

  test("cartão aprovado: pedido nasce pago, com parcelas", async () => {
    const s = await skuWith(2);
    const r = await call("POST", "/api/orders", { items: [{ sku: s.id, qty: 1 }], customer, address, shipping: "padrao", payment: "cartao", card: await card("APRO", 3) }, { "Idempotency-Key": crypto.randomUUID() });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.status, "pago");
    assert.equal(r.json.installments, 3);
    assert.equal(r.json.cardBrand, "master");
  });

  test("cartão recusado: 402 com motivo claro e estoque devolvido", async () => {
    const s = await skuWith(1);
    const before = s.qty;
    const r = await call("POST", "/api/orders", { items: [{ sku: s.id, qty: 1 }], customer, address, shipping: "padrao", payment: "cartao", card: await card("FUND") }, { "Idempotency-Key": crypto.randomUUID() });
    assert.equal(r.status, 402, r.text);
    assert.match(r.json.error, /limite|saldo/i);
    assert.equal((await db.one("SELECT qty FROM skus WHERE id = ?", [s.id])).qty, before, "estoque devolvido");
  });

  test("cartão: parcelas acima do limite são recusadas antes de cobrar", async () => {
    const s = await skuWith(1);
    const r = await call("POST", "/api/orders", { items: [{ sku: s.id, qty: 1 }], customer, address, shipping: "padrao", payment: "cartao", card: await card("APRO", 6) });
    assert.equal(r.status, 400);
  });

  test("webhook: sem assinatura → 401; assinado → 200 e sincroniza pela API", async () => {
    const mpId = (await db.one("SELECT mp_order_id FROM orders WHERE code = ?", [pixOrder.code])).mp_order_id;
    const bad = await call("POST", `/api/webhooks/mercadopago?data.id=${mpId}&type=order`, { action: "order.processed", data: { id: mpId } });
    assert.equal(bad.status, 401);
    const ts = Date.now();
    const reqId = crypto.randomUUID();
    const v1 = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`id:${mpId.toLowerCase()};request-id:${reqId};ts:${ts};`).digest("hex");
    const ok = await call("POST", `/api/webhooks/mercadopago?data.id=${mpId}&type=order`, { action: "order.processed", data: { id: mpId } },
      { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": reqId });
    assert.equal(ok.status, 200, ok.text);
    const ev = await db.all("SELECT source FROM payment_events pe JOIN orders o ON o.id = pe.order_id WHERE o.code = ?", [pixOrder.code]);
    assert.ok(ev.length >= 1);
  });

  test("painel: cancelar pedido pago estorna no Mercado Pago e devolve o estoque", async () => {
    const s = await skuWith(2);
    const before = s.qty;
    const r = await call("POST", "/api/orders", { items: [{ sku: s.id, qty: 1 }], customer, address, shipping: "padrao", payment: "cartao", card: await card("APRO") }, { "Idempotency-Key": crypto.randomUUID() });
    assert.equal(r.json.status, "pago", r.text);
    const c = await call("PATCH", `/api/admin/orders/${r.json.code}/status`, { status: "cancelado" }, { Cookie: cookie });
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.refunded, true);
    const row = await db.one("SELECT status, payment_status, (SELECT qty FROM skus WHERE id = ?) AS qty FROM orders WHERE code = ?", [s.id, r.json.code]);
    assert.equal(row.status, "cancelado");
    assert.equal(row.payment_status, "estornado");
    assert.equal(row.qty, before);
  });
});
