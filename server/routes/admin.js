import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { categories, sizeGuides } from "../data/catalog.js";
import { HttpError, notFound } from "../lib/errors.js";
import { CARRIERS } from "../lib/tracking.js";
import { stockUpdateSchema } from "../lib/validators.js";
import {
  audit, changePassword, createAdmin, deleteAdmin, listAdmins, login, loginSchema, logout, SESSION_COOKIE, sessionAdmin,
} from "../services/auth.js";
import { deleteCoupon, listCoupons, saveCoupon } from "../services/coupons.js";
import { changeStatus, getOrderAdmin, listOrders, ordersCsv, setNote, setTracking, toCsv, csvMoney } from "../services/orders-admin.js";
import {
  adminGetProduct, adminListProducts, bulkPrice, deleteProduct, saveProduct, saveUpload, setProductActive,
} from "../services/products-admin.js";
import { customers, dashboard, report } from "../services/reports.js";
import { cancelWithPayment, expireWithSync, syncPending } from "../services/payments.js";
import { effectiveConfig, getSettings, saveSettings } from "../services/settings.js";

function readCookie(req, name) {
  const raw = req.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};

let lastAdminSweep = 0;

export function adminRouter({ db, config, limiter, mp }) {
  const r = express.Router();
  const json = express.json({ limit: "200kb" });
  const secure = config.env === "production";
  const cookie = (value, maxAgeMs) =>
    `${SESSION_COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`;
  const bearer = config.adminToken ? Buffer.from(config.adminToken) : null;
  const who = (req) => req.admin?.email ?? "api";
  const log = (req, action, detail) => audit(db, who(req), action, detail);
  const cfg = () => effectiveConfig(db, config);

  // ---- público: login ----
  r.post("/login", limiter(15, 10), json, async (req, res) => {
    const { email, password } = loginSchema.parse(req.body ?? {});
    const s = await login(db, email, password);
    if (!s) {
      await audit(db, email, "login_falhou", req.ip);
      return res.status(401).json({ error: "E-mail ou senha incorretos" });
    }
    await audit(db, email, "login", req.ip);
    res.set("Set-Cookie", cookie(s.token, s.maxAgeMs)).json({ admin: s.admin });
  });

  // ---- autenticação: cookie de sessão OU Bearer (ADMIN_TOKEN, para integrações) ----
  r.use(async (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.get("Authorization") || "");
    if (m && bearer) {
      const got = Buffer.from(m[1]);
      if (got.length === bearer.length && crypto.timingSafeEqual(got, bearer)) { req.admin = { id: 0, email: "api", name: "API" }; return next(); }
    }
    const admin = await sessionAdmin(db, readCookie(req, SESSION_COOKIE));
    if (!admin) return res.status(401).json({ error: "Sessão expirada. Entre novamente." });
    req.admin = admin;
    // CSRF: escrita só com Content-Type JSON/imagem (formulário de outro site não consegue enviar)
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      const ct = req.get("Content-Type") || "";
      if (!/^application\/json|^image\//.test(ct)) return res.status(415).json({ error: "Content-Type não suportado" });
    }
    next();
  });
  r.use(limiter(15, 900));

  r.post("/logout", async (req, res) => {
    await logout(db, readCookie(req, SESSION_COOKIE));
    res.set("Set-Cookie", cookie("", 0)).json({ ok: true });
  });
  r.get("/me", async (req, res) => res.json({ admin: req.admin }));
  r.post("/me/password", json, async (req, res) => {
    const b = z.object({ current: z.string(), next: z.string() }).strict().parse(req.body ?? {});
    await changePassword(db, req.admin.id, b.current, b.next);
    await log(req, "senha_alterada");
    res.set("Set-Cookie", cookie("", 0)).json({ ok: true, relogin: true });
  });

  r.get("/meta", async (req, res) => res.json({
    categories, sizeGuides, carriers: CARRIERS,
    statuses: { aguardando_pagamento: "Aguardando pagamento", pago: "Pago", em_separacao: "Em separação", enviado: "Enviado", entregue: "Entregue", cancelado: "Cancelado" },
  }));

  // ---- painel ----
  // abrir o painel também expira pedidos vencidos (na Vercel não há rotina rodando o tempo todo)
  // abrir o painel confere pagamentos pendentes no Mercado Pago e expira pedidos vencidos (no máx. a cada 2 min)
  const sweep = async () => {
    if (Date.now() - lastAdminSweep < 2 * 60_000) return;
    lastAdminSweep = Date.now();
    try {
      const c = await cfg();
      await syncPending(db, c, mp, { limit: 15 });
      await expireWithSync(db, c, mp);
    } catch (err) { console.error("[painel] sincronização:", err.message); }
  };
  r.get("/dashboard", async (req, res) => { await sweep(); res.json(await dashboard(db)); });
  r.get("/summary", async (req, res) => res.json(await dashboard(db))); // compatibilidade

  // ---- pedidos ----
  r.get("/orders", async (req, res) => { await sweep(); res.json(await listOrders(db, req.query)); });
  r.get("/orders.csv", async (req, res) => {
    await log(req, "exportou_pedidos");
    res.type("text/csv; charset=utf-8").attachment(`pedidos-seja-us-${new Date().toISOString().slice(0, 10)}.csv`).send(await ordersCsv(db, req.query));
  });
  r.get("/orders/:code", async (req, res) => res.json(await getOrderAdmin(db, await cfg(), String(req.params.code).toUpperCase())));
  const statusHandler = async (req, res) => {
    const code = String(req.params.code).toUpperCase();
    // cancelar pedido pago pelo Mercado Pago estorna o cliente antes (se o estorno falhar, nada é cancelado)
    let refund = null;
    if (req.body?.status === "cancelado") refund = await cancelWithPayment(db, await cfg(), mp, code);
    const out = await changeStatus(db, await cfg(), code, req.body ?? {});
    if (refund?.refunded) out.refunded = true;
    await log(req, "status_pedido", `${code} → ${out.status}`);
    res.json(out);
  };
  r.patch("/orders/:code/status", json, statusHandler);
  r.patch("/orders/:code", json, statusHandler);
  r.patch("/orders/:code/tracking", json, async (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const t = await setTracking(db, code, req.body ?? {});
    await log(req, "rastreio", `${code}: ${t.trackingCode}`);
    res.json(await getOrderAdmin(db, await cfg(), code));
  });
  r.patch("/orders/:code/note", json, async (req, res) => {
    const code = String(req.params.code).toUpperCase();
    await setNote(db, code, req.body?.note);
    res.json(await getOrderAdmin(db, await cfg(), code));
  });

  // ---- produtos ----
  r.get("/products", async (req, res) => res.json(await adminListProducts(db)));
  r.get("/products/:id", async (req, res) => res.json(await adminGetProduct(db, id(req.params.id))));
  r.post("/products", json, async (req, res) => {
    const p = await saveProduct(db, config.root, req.body ?? {});
    await log(req, "produto_criado", p.name);
    res.status(201).json(p);
  });
  r.put("/products/:id", json, async (req, res) => {
    const p = await saveProduct(db, config.root, req.body ?? {}, id(req.params.id));
    await log(req, "produto_editado", p.name);
    res.json(p);
  });
  r.patch("/products/:id/active", json, async (req, res) => {
    const { active } = z.object({ active: z.boolean() }).strict().parse(req.body ?? {});
    await setProductActive(db, id(req.params.id), active);
    await log(req, active ? "produto_ativado" : "produto_pausado", req.params.id);
    res.json({ ok: true });
  });
  r.delete("/products/:id", async (req, res) => {
    const out = await deleteProduct(db, id(req.params.id));
    await log(req, out.deleted ? "produto_excluido" : "produto_pausado", req.params.id);
    res.json(out);
  });
  r.post("/products/bulk-price", json, async (req, res) => {
    const dryRun = req.query.preview === "1";
    const out = await bulkPrice(db, req.body ?? {}, { dryRun });
    if (!dryRun) await log(req, "precos_em_massa", `${req.body?.action} ${req.body?.percent ?? ""}% em ${out.count} produtos`);
    res.json(out);
  });
  r.post("/uploads", express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "4mb" }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, "Envie uma imagem JPG, PNG ou WEBP");
    const out = await saveUpload(db, config, req.body);
    await log(req, "upload_foto", out.id);
    res.status(201).json(out);
  });

  // ---- estoque ----
  r.get("/stock", async (req, res) => {
    res.json((await db.all(`SELECT s.id AS sku, p.id AS "productId", p.name, p.line, p.active, v.color, s.size, s.qty
      FROM skus s JOIN variants v ON v.id = s.variant_id JOIN products p ON p.id = v.product_id
      ORDER BY p.position, v.position, s.position`)));
  });
  r.patch("/stock/:sku", json, async (req, res) => {
    const { qty } = stockUpdateSchema.parse(req.body ?? {});
    const sku = id(req.params.sku);
    if ((await db.run("UPDATE skus SET qty = ? WHERE id = ?", [qty, sku])).changes !== 1) throw notFound("SKU não encontrado");
    await log(req, "estoque", `SKU ${sku} = ${qty}`);
    res.json({ sku, qty });
  });

  // ---- cupons ----
  r.get("/coupons", async (req, res) => res.json(await listCoupons(db)));
  r.post("/coupons", json, async (req, res) => {
    const c = await saveCoupon(db, req.body ?? {});
    await log(req, "cupom_criado", c.code);
    res.status(201).json(c);
  });
  r.put("/coupons/:code", json, async (req, res) => {
    const c = await saveCoupon(db, req.body ?? {}, { originalCode: String(req.params.code).toUpperCase() });
    await log(req, "cupom_editado", c.code);
    res.json(c);
  });
  r.delete("/coupons/:code", async (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const out = await deleteCoupon(db, code);
    await log(req, out.deleted ? "cupom_excluido" : "cupom_desativado", code);
    res.json(out);
  });

  // ---- clientes ----
  const q = (req) => (typeof req.query.q === "string" ? req.query.q.slice(0, 80) : "");
  r.get("/customers", async (req, res) => res.json(await customers(db, q(req))));
  r.get("/customers.csv", async (req, res) => {
    await log(req, "exportou_clientes");
    const rows = (await customers(db, q(req))).map((c) => [c.name, c.email, c.phone, c.city, c.orders, csvMoney(c.spent),
      new Date(c.firstOrder).toLocaleDateString("pt-BR"), new Date(c.lastOrder).toLocaleDateString("pt-BR")]);
    res.type("text/csv; charset=utf-8").attachment("clientes-seja-us.csv")
      .send(toCsv(["Nome", "E-mail", "Telefone", "Cidade", "Pedidos", "Total gasto", "Primeira compra", "Última compra"], rows));
  });
  r.get("/newsletter.csv", async (req, res) => {
    const rows = (await db.all("SELECT email, created_at FROM newsletter ORDER BY created_at DESC"))
      .map((n) => [n.email, new Date(n.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })]);
    res.type("text/csv; charset=utf-8").attachment("newsletter-seja-us.csv").send(toCsv(["E-mail", "Inscrito em"], rows));
  });

  // ---- relatórios ----
  r.get("/reports", async (req, res) => res.json(await report(db, req.query)));
  r.get("/reports.csv", async (req, res) => {
    const rep = await report(db, req.query);
    res.type("text/csv; charset=utf-8").attachment(`vendas-${rep.range.from}-a-${rep.range.to}.csv`)
      .send(toCsv(["Data", "Pedidos pagos", "Faturamento"], rep.daily.map((d) => [d.date.split("-").reverse().join("/"), d.orders, csvMoney(d.revenueCents)])));
  });

  // ---- configurações / usuários / log ----
  r.get("/settings", async (req, res) => {
    const c = await cfg();
    res.json({ saved: await getSettings(db), effective: {
      whatsapp: c.store.whatsapp, pixKey: c.store.pixKey, pixMerchantName: c.store.pixMerchantName, pixMerchantCity: c.store.pixMerchantCity,
      freeShippingCents: c.freeShippingCents, orderTtlHours: c.orderTtlHours, announcement: c.announcement,
    } });
  });
  r.put("/settings", json, async (req, res) => {
    const saved = await saveSettings(db, req.body ?? {});
    await log(req, "configuracoes", Object.keys(req.body ?? {}).join(", "));
    res.json({ saved });
  });
  r.get("/users", async (req, res) => res.json(await listAdmins(db)));
  r.post("/users", json, async (req, res) => {
    const a = await createAdmin(db, req.body ?? {});
    await log(req, "usuario_criado", a.email);
    res.status(201).json(a);
  });
  r.delete("/users/:id", async (req, res) => {
    await deleteAdmin(db, id(req.params.id), req.admin.id);
    await log(req, "usuario_excluido", req.params.id);
    res.json({ ok: true });
  });
  r.get("/log", async (req, res) => res.json((await db.all("SELECT * FROM admin_log ORDER BY id DESC LIMIT 200"))));

  r.use(async (req, res) => res.status(404).json({ error: "Rota não encontrada" }));
  return r;
}
