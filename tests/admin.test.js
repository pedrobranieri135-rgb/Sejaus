import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { connect, migrate } from "../server/db.js";
import { ensureBootstrapAdmin } from "../server/services/auth.js";
import { hasDatabase, skipReason, startTestStore } from "./helpers.js";

let db, base, config, cookie, store;
const created = [];

const call = async (method, url, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined && !isBuf ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text, headers: res.headers };
};

const customer = (email, cpf = "529.982.247-25") => ({ name: "Ana Souza", email, phone: "67998313659", cpf });
const address = { cep: "79002-000", street: "Rua 14 de Julho", number: "100", district: "Centro", city: "Campo Grande", state: "MS" };
const anySku = async (min = 1) => (await db.one("SELECT s.id, s.qty, p.price_cents, p.line FROM skus s JOIN variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id WHERE s.qty >= ? ORDER BY s.id LIMIT 1", [min]));
const placeOrder = (items, extra = {}) =>
  call("POST", "/api/orders", { items, customer: customer("ana@example.com"), address, shipping: "padrao", payment: "pix", ...extra }, { Cookie: "" });

before(async () => {
  if (!hasDatabase) return;
  // fotos em disco local nos testes (o Storage do Supabase tem teste próprio no fim do arquivo)
  store = await startTestStore({ adminEmail: "dono@sejaus.com.br", adminPassword: "senha-forte-123", storage: { url: null, secretKey: null, bucket: "produtos" } });
  ({ db, base, config } = store);
  await ensureBootstrapAdmin(db, config);
});
after(async () => {
  await store?.stop();
  for (const id of created) for (const suf of ["", "-s"]) fs.rmSync(path.join(store?.config.root ?? ".", "public/img/p", `${id}${suf}.webp`), { force: true });
});

describe("login do painel", { skip: !hasDatabase && skipReason }, () => {
  test("bloqueia sem sessão e com senha errada", async () => {
    assert.equal((await call("GET", "/api/admin/dashboard")).status, 401);
    const bad = await call("POST", "/api/admin/login", { email: "dono@sejaus.com.br", password: "errada" });
    assert.equal(bad.status, 401);
    assert.equal((await call("POST", "/api/admin/login", { email: "naoexiste@x.com", password: "x" })).status, 401);
  });
  test("login cria cookie HttpOnly + SameSite=Strict", async () => {
    const r = await call("POST", "/api/admin/login", { email: "DONO@sejaus.com.br", password: "senha-forte-123" });
    assert.equal(r.status, 200);
    const sc = r.headers.get("set-cookie");
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Strict/);
    cookie = sc.split(";")[0];
    assert.equal((await call("GET", "/api/admin/me")).body.admin.email, "dono@sejaus.com.br");
  });
  test("bloqueia escrita sem JSON (proteção CSRF)", async () => {
    const r = await call("POST", "/api/admin/coupons", "code=X", { "Content-Type": "application/x-www-form-urlencoded" });
    assert.equal(r.status, 415);
  });
  test("Bearer não funciona quando ADMIN_TOKEN não está definido", async () => {
    const r = await call("GET", "/api/admin/dashboard", undefined, { Cookie: "", Authorization: "Bearer null" });
    assert.equal(r.status, 401);
  });
});

describe("cupons", { skip: !hasDatabase && skipReason }, () => {
  test("cria, valida regras e impede duplicado", async () => {
    const bad = await call("POST", "/api/admin/coupons", { code: "x y", kind: "percent", value: 200 });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.fields.code && bad.body.fields.value);
    const ok = await call("POST", "/api/admin/coupons", { code: "adapt15", kind: "percent", value: 15, line: "adapt", maxUses: 2 });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.body.code, "ADAPT15");
    assert.equal((await call("POST", "/api/admin/coupons", { code: "ADAPT15", kind: "fixed", value: 500 })).status, 409);
  });
  test("cupom por linha só desconta peças daquela linha", async () => {
    const ess = (await db.one("SELECT s.id, p.price_cents FROM skus s JOIN variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id WHERE p.line='essential' AND s.qty>0 LIMIT 1"));
    const ada = (await db.one("SELECT s.id, p.price_cents FROM skus s JOIN variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id WHERE p.line='adapt' AND s.qty>0 LIMIT 1"));
    const q = await call("POST", "/api/cart/quote", { items: [{ sku: ess.id, qty: 1 }, { sku: ada.id, qty: 1 }], coupon: "ADAPT15" });
    assert.equal(q.body.discountCents, Math.round(ada.price_cents * 0.15));
    const onlyEss = await call("POST", "/api/cart/quote", { items: [{ sku: ess.id, qty: 1 }], coupon: "ADAPT15" });
    assert.equal(onlyEss.body.coupon.valid, false);
  });
  test("frete grátis por cupom zera a entrega padrão", async () => {
    await call("POST", "/api/admin/coupons", { code: "FRETE0", kind: "shipping", minSubtotalCents: 0 });
    const s = await anySku();
    const q = await call("POST", "/api/cart/quote", { items: [{ sku: s.id, qty: 1 }], cep: "79002000", coupon: "FRETE0" });
    assert.equal(q.body.shipping.options.find((o) => o.id === "padrao").priceCents, 0);
    assert.ok(q.body.shipping.options.find((o) => o.id === "expresso").priceCents > 0);
  });
  test("primeira compra: segunda compra do mesmo CPF é recusada", async () => {
    const s = await anySku(2);
    const first = await placeOrder([{ sku: s.id, qty: 1 }], { coupon: "BEMVINDOUS" });
    assert.equal(first.status, 201, first.text);
    const second = await placeOrder([{ sku: s.id, qty: 1 }], { coupon: "BEMVINDOUS" });
    assert.equal(second.status, 400);
    assert.match(second.body.error, /primeira compra/);
  });
  test("limite de usos e agendamento", async () => {
    await call("POST", "/api/admin/coupons", { code: "FUTURO", kind: "fixed", value: 1000, startsAt: "2099-01-01" });
    const s = await anySku();
    const q = await call("POST", "/api/cart/quote", { items: [{ sku: s.id, qty: 1 }], coupon: "FUTURO" });
    assert.match(q.body.coupon.message, /ainda não começou/);
    const list = await call("GET", "/api/admin/coupons");
    assert.equal(list.body.find((c) => c.code === "FUTURO").status, "agendado");
  });
  test("cupom usado é desativado em vez de apagado", async () => {
    const r = await call("DELETE", "/api/admin/coupons/BEMVINDOUS");
    assert.deepEqual(r.body, { deleted: false, deactivated: true });
    assert.equal((await call("DELETE", "/api/admin/coupons/FUTURO")).body.deleted, true);
  });
});

describe("produtos", { skip: !hasDatabase && skipReason }, () => {
  let pid, imageId;
  test("upload valida o conteúdo e gera webp", async () => {
    assert.equal((await call("POST", "/api/admin/uploads", Buffer.from("nao sou imagem"), { "Content-Type": "image/png" })).status, 400);
    const png = await sharp({ create: { width: 600, height: 750, channels: 3, background: "#7a1f2b" } }).png().toBuffer();
    const r = await call("POST", "/api/admin/uploads", png, { "Content-Type": "image/png" });
    assert.equal(r.status, 201, r.text);
    imageId = r.body.id;
    created.push(imageId);
    assert.ok(fs.existsSync(path.join(config.root, "public/img/p", `${imageId}.webp`)));
  });
  test("cria produto com cores e tamanhos e aparece na loja", async () => {
    const r = await call("POST", "/api/admin/products", {
      name: "Regata US Adapt Dry", line: "adapt", category: "camisetas", priceCents: 8990, compareAtCents: 11990,
      description: "Regata leve", features: ["Toque gelado"], badges: ["Novo"], active: true,
      variants: [{ color: "Vinho", hex: "#5B1A22", images: [imageId], skus: [{ size: "M", qty: 4 }, { size: "G", qty: 0 }] }],
    });
    assert.equal(r.status, 201, r.text);
    pid = r.body.id;
    assert.equal(r.body.slug, "regata-us-adapt-dry");
    const store = await call("GET", "/api/products/regata-us-adapt-dry");
    assert.equal(store.body.compareAtCents, 11990);
    assert.equal(store.body.variants[0].skus.find((s) => s.size === "G").available, false);
  });
  test("valida preço promocional e foto inexistente", async () => {
    const base = { name: "Teste", line: "adapt", category: "camisetas", priceCents: 5000, variants: [{ color: "Preta", hex: "#000000", images: [imageId], skus: [{ size: "P", qty: 1 }] }] };
    assert.equal((await call("POST", "/api/admin/products", { ...base, compareAtCents: 4000 })).status, 400);
    assert.equal((await call("POST", "/api/admin/products", { ...base, variants: [{ ...base.variants[0], images: ["nao-existe"] }] })).status, 400);
  });
  test("edita preço e pausa: some da loja", async () => {
    const p = (await call("GET", `/api/admin/products/${pid}`)).body;
    const r = await call("PUT", `/api/admin/products/${pid}`, {
      name: p.name, line: p.line, category: p.category, priceCents: 7990, compareAtCents: null, description: p.description,
      features: p.features, badges: p.badges, active: true,
      variants: p.variants.map((v) => ({ id: v.id, color: v.color, hex: v.hex, images: v.images.map((i) => i.id), skus: v.skus.map((s) => ({ id: s.id, size: s.size, qty: s.qty })) })),
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.priceCents, 7990);
    await call("PATCH", `/api/admin/products/${pid}/active`, { active: false });
    assert.equal((await call("GET", "/api/products/regata-us-adapt-dry")).status, 404);
  });
  test("não remove cor que já tem pedido", async () => {
    const s = await anySku();
    await placeOrder([{ sku: s.id, qty: 1 }]);
    const prodId = (await db.one("SELECT v.product_id AS id FROM skus s JOIN variants v ON v.id=s.variant_id WHERE s.id=?", [s.id])).id;
    const p = (await call("GET", `/api/admin/products/${prodId}`)).body;
    const keep = p.variants.filter((v) => !v.skus.some((k) => k.id === s.id));
    if (!keep.length) return; // produto de uma cor só
    const r = await call("PUT", `/api/admin/products/${prodId}`, {
      name: p.name, line: p.line, category: p.category, priceCents: p.priceCents, description: p.description, features: p.features, badges: p.badges,
      variants: keep.map((v) => ({ id: v.id, color: v.color, hex: v.hex, images: v.images.map((i) => i.id), skus: v.skus.map((k) => ({ id: k.id, size: k.size, qty: k.qty })) })),
    });
    assert.equal(r.status, 409);
  });
  test("promoção em massa: prévia não altera, aplicar altera e mostra preço de", async () => {
    const before = (await db.one("SELECT price_cents FROM products WHERE slug='camiseta-us-adapt-estampa-01'")).price_cents;
    const prev = await call("POST", "/api/admin/products/bulk-price?preview=1", { action: "promo", percent: 20, line: "adapt" });
    assert.ok(prev.body.count >= 3);
    assert.equal((await db.one("SELECT price_cents FROM products WHERE slug='camiseta-us-adapt-estampa-01'")).price_cents, before);
    await call("POST", "/api/admin/products/bulk-price", { action: "promo", percent: 20, line: "adapt" });
    const row = (await db.one("SELECT price_cents, compare_at_cents FROM products WHERE slug='camiseta-us-adapt-estampa-01'"));
    assert.equal(row.compare_at_cents, before);
    assert.equal(row.price_cents, 7990); // 99,00 - 20% = 79,20 → arredonda para ,90
    await call("POST", "/api/admin/products/bulk-price", { action: "clear_promo", line: "adapt" });
    assert.equal((await db.one("SELECT price_cents FROM products WHERE slug='camiseta-us-adapt-estampa-01'")).price_cents, before);
  });
});

describe("pedidos, rastreio e relatórios", { skip: !hasDatabase && skipReason }, () => {
  test("enviado com rastreio: cliente vê o código e o link", async () => {
    const s = await anySku();
    const o = (await placeOrder([{ sku: s.id, qty: 1 }])).body;
    await call("PATCH", `/api/admin/orders/${o.code}/status`, { status: "pago" });
    await call("PATCH", `/api/admin/orders/${o.code}/status`, { status: "em_separacao" });
    const bad = await call("PATCH", `/api/admin/orders/${o.code}/status`, { status: "enviado", trackingCode: "x" });
    assert.equal(bad.status, 400);
    assert.equal((await db.one("SELECT status FROM orders WHERE code=?", [o.code])).status, "em_separacao", "rastreio inválido não muda status");
    const ok = await call("PATCH", `/api/admin/orders/${o.code}/status`, { status: "enviado", trackingCode: "qb123456789br" });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.tracking.carrier, "correios");
    const t = await call("POST", "/api/orders/track", { code: o.code, email: "ana@example.com" }, { Cookie: "" });
    assert.equal(t.body.tracking.code, "QB123456789BR");
    assert.match(t.body.tracking.url, /QB123456789BR/);
  });
  test("busca e filtros de pedidos", async () => {
    const all = await call("GET", "/api/admin/orders");
    assert.ok(all.body.total >= 3);
    const sent = await call("GET", "/api/admin/orders?status=enviado");
    assert.ok(sent.body.orders.every((o) => o.status === "enviado"));
    assert.ok((await call("GET", "/api/admin/orders?q=QB1234")).body.total >= 1);
    assert.equal((await call("GET", "/api/admin/orders?status=xpto")).status, 400);
  });
  test("CSV neutraliza fórmula maliciosa", async () => {
    const s = await anySku();
    await call("POST", "/api/orders", { items: [{ sku: s.id, qty: 1 }], customer: { ...customer("csv@example.com", "111.444.777-35"), name: "=HYPERLINK(1) Teste" }, address, shipping: "padrao", payment: "pix" }, { Cookie: "" });
    const csv = (await call("GET", "/api/admin/orders.csv")).text;
    assert.ok(csv.includes("'=HYPERLINK"));
    const bytes = new Uint8Array(await (await fetch(base + "/api/admin/orders.csv", { headers: { Cookie: cookie } })).arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "BOM UTF-8 para o Excel");
  });
  test("relatório soma só pedidos pagos", async () => {
    const r = await call("GET", "/api/admin/reports");
    const paid = (await db.one("SELECT COALESCE(SUM(total_cents),0) t FROM orders WHERE status IN ('pago','em_separacao','enviado','entregue')")).t;
    assert.equal(r.body.totals.revenueCents, paid);
    assert.equal(r.body.daily.length, 30);
    assert.ok(Array.isArray(r.body.topProducts));
    assert.equal((await call("GET", "/api/admin/reports?from=2026-13-01")).status, 400);
  });
  test("clientes agrupados por e-mail", async () => {
    const c = await call("GET", "/api/admin/customers?q=ana@");
    assert.equal(c.body.length, 1);
    assert.ok(c.body[0].orders >= 2);
  });
});

describe("configurações e usuários", { skip: !hasDatabase && skipReason }, () => {
  test("configurações alteram a loja na hora", async () => {
    assert.equal((await call("PUT", "/api/admin/settings", { whatsapp: "123" })).status, 400);
    await call("PUT", "/api/admin/settings", { whatsapp: "55 67 99831-3659", announcement: "Black Friday US" , freeShippingCents: 19900 });
    const meta = await call("GET", "/api/meta", undefined, { Cookie: "" });
    assert.equal(meta.body.store.whatsapp, "5567998313659");
    assert.equal(meta.body.announcement, "Black Friday US");
    assert.equal(meta.body.freeShippingCents, 19900);
  });
  test("usuários: cria, não exclui a si mesmo, troca de senha derruba sessão", async () => {
    assert.equal((await call("POST", "/api/admin/users", { name: "Marcos", email: "marcos@sejaus.com.br", password: "curta" })).status, 400);
    const u = await call("POST", "/api/admin/users", { name: "Marcos", email: "marcos@sejaus.com.br", password: "outra-senha-forte" });
    assert.equal(u.status, 201);
    const me = (await call("GET", "/api/admin/me")).body.admin;
    assert.equal((await call("DELETE", `/api/admin/users/${me.id}`)).status, 400);
    assert.equal((await call("POST", "/api/admin/me/password", { current: "errada", next: "nova-senha-forte-1" })).status, 400);
    assert.equal((await call("POST", "/api/admin/me/password", { current: "senha-forte-123", next: "nova-senha-forte-1" })).status, 200);
    assert.equal((await call("GET", "/api/admin/me")).status, 401, "sessão antiga derrubada");
    const relog = await call("POST", "/api/admin/login", { email: "dono@sejaus.com.br", password: "nova-senha-forte-1" });
    assert.equal(relog.status, 200);
    cookie = relog.headers.get("set-cookie").split(";")[0];
    const log = await call("GET", "/api/admin/log");
    assert.ok(log.body.some((l) => l.action === "senha_alterada"));
  });
});

describe("migração", { skip: !hasDatabase && skipReason }, () => {
  test("migrações são idempotentes e o schema fica fechado para a API pública", async () => {
    await migrate(db);
    await migrate(db);
    const applied = await db.all("SELECT name FROM schema_migrations ORDER BY name");
    assert.deepEqual(applied.map((r) => r.name), ["001_inicial", "002_bloqueio_api_publica"]);
    const noRls = await db.all("SELECT tablename FROM pg_tables WHERE schemaname = ? AND NOT rowsecurity", [db.schema]);
    assert.deepEqual(noRls, [], "todas as tabelas com RLS ligado");
    const anon = await db.one("SELECT has_schema_privilege('anon', ?, 'USAGE') AS ok", [db.schema]).catch(() => ({ ok: false }));
    assert.equal(anon.ok, false, "anon não acessa o schema da loja");
  });
});

describe("Supabase Storage", { skip: !(hasDatabase && process.env.SUPABASE_SECRET_KEY) && "Defina SUPABASE_URL e SUPABASE_SECRET_KEY para testar o Storage" }, () => {
  test("foto enviada vai para o bucket público e é apagada no fim", async () => {
    const { saveUpload } = await import("../server/services/products-admin.js");
    const { configureImages } = await import("../server/lib/images.js");
    const storage = { url: process.env.SUPABASE_URL, secretKey: process.env.SUPABASE_SECRET_KEY, bucket: process.env.SUPABASE_BUCKET || "produtos" };
    configureImages({ supabaseUrl: storage.url, bucket: storage.bucket });
    const png = await sharp({ create: { width: 400, height: 500, channels: 3, background: "#1C2A4A" } }).png().toBuffer();
    const img = await saveUpload(db, { ...config, storage }, png);
    try {
      assert.match(img.id, /^up-/);
      const res = await fetch(img.lg);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/webp");
      assert.ok(await db.one("SELECT 1 FROM uploads WHERE id = ? AND storage = 'supabase'", [img.id]));
    } finally {
      await fetch(`${storage.url}/storage/v1/object/${storage.bucket}`, {
        method: "DELETE", headers: { apikey: storage.secretKey, "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: [`p/${img.id}.webp`, `p/${img.id}-s.webp`] }),
      });
      configureImages({ supabaseUrl: null });
    }
  });
});
