import path from "node:path";
import compression from "compression";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { ZodError } from "zod";
import { HttpError, notFound } from "./lib/errors.js";
import { formatZodError, newsletterSchema, orderSchema, quoteSchema, trackSchema } from "./lib/validators.js";
import { adminRouter } from "./routes/admin.js";
import { getMeta, getProduct, listProducts } from "./services/catalog.js";
import { createOrder, quote, serializeOrder, trackOrder } from "./services/checkout.js";
import { createMercadoPago, verifyWebhookSignature } from "./lib/mercadopago.js";
import { expireWithSync, startPayment, syncPayment, syncPending } from "./services/payments.js";
import { storagePublicBase } from "./lib/images.js";
import { effectiveConfig } from "./services/settings.js";

const limiter = (enabled, windowMin, max) =>
  enabled
    ? rateLimit({
        windowMs: windowMin * 60_000, limit: max, standardHeaders: "draft-7", legacyHeaders: false,
        message: { error: "Muitas requisições. Tente novamente em instantes." },
      })
    : (req, res, next) => next();

export function createApp({ db, config, mp = createMercadoPago({ accessToken: config.mercadopago?.accessToken }) }) {
  const app = express();
  const rl = config.rateLimit !== false;
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.set("query parser", "simple");

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // scripts embutidos seguem bloqueados (o SDK do Mercado Pago tenta injetar um de sincronização de cookies;
        // o pagamento funciona sem ele e liberar "unsafe-inline" enfraqueceria a proteção contra XSS)
        scriptSrc: ["'self'", "https://sdk.mercadopago.com", "https://http2.mlstatic.com", "https://www.mercadopago.com", "https://www.mercadolibre.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://http2.mlstatic.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "https://http2.mlstatic.com"],
        imgSrc: ["'self'", "data:", ...(storagePublicBase() ? [new URL(storagePublicBase()).origin] : []), "https://*.mlstatic.com", "https://*.mercadopago.com", "https://*.mercadolibre.com"],
        connectSrc: ["'self'", "https://viacep.com.br", "https://api.mercadopago.com", "https://api.mercadolibre.com", "https://*.mercadopago.com", "https://*.mercadolibre.com", "https://*.mlstatic.com"],
        frameSrc: ["https://*.mercadopago.com", "https://*.mercadopago.com.br", "https://*.mercadolibre.com", "https://*.mercadolivre.com"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: config.env === "production" ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(compression());

  // ---------- API ----------
  const api = express.Router();
  api.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  // painel tem parser e limites próprios (payload de produto e upload de foto são maiores)
  api.use("/admin", adminRouter({ db, config, mp, limiter: (w, m) => limiter(rl, w, m) }));
  api.use(express.json({ limit: "20kb", strict: true }));
  api.use(limiter(rl, 15, 600));
  const cfg = () => effectiveConfig(db, config);

  api.get("/health", async (req, res) => {
    await db.one("SELECT 1");
    res.json({ ok: true, db: "ok", time: new Date().toISOString() });
  });

  // Cron da Vercel (vercel.json → crons): expira pedidos não pagos e devolve o estoque.
  // A Vercel envia "Authorization: Bearer <CRON_SECRET>"; sem o segredo certo, nada acontece.
  api.get("/cron/expire-orders", async (req, res) => {
    const secret = process.env.CRON_SECRET;
    const got = req.get("Authorization") || "";
    if (!secret || got !== `Bearer ${secret}`) return res.status(401).json({ error: "Não autorizado" });
    const c = await cfg();
    const synced = await syncPending(db, c, mp, { limit: 50, olderThanSec: 0 });
    const n = await expireWithSync(db, c, mp);
    res.json({ ok: true, expired: n, synced });
  });

  api.get("/meta", async (req, res) => {
    const c = await cfg();
    res.json({
      ...getMeta(),
      store: { name: config.store.name, instagram: config.store.instagram, whatsapp: c.store.whatsapp },
      freeShippingCents: c.freeShippingCents,
      announcement: c.announcement,
      // a Public Key é pública por natureza (vai para o navegador); o Access Token nunca sai do servidor
      payments: mp && config.mercadopago.publicKey
        ? { online: true, provider: "mercadopago", publicKey: config.mercadopago.publicKey, maxInstallments: config.mercadopago.maxInstallments }
        : { online: false },
    });
  });

  api.get("/products", async (req, res) => {
    const pick = (v, allowed) => (typeof v === "string" && (!allowed || allowed.includes(v)) ? v : undefined);
    const products = await listProducts(db, {
      line: pick(req.query.line, ["adapt", "essential"]),
      category: pick(req.query.category),
      size: pick(req.query.size),
      search: typeof req.query.q === "string" ? req.query.q.slice(0, 60) : undefined,
      sort: pick(req.query.sort, ["price_asc", "price_desc", "name"]),
    });
    res.json({ count: products.length, products });
  });

  api.get("/products/:slug", async (req, res) => {
    const p = await getProduct(db, String(req.params.slug).slice(0, 120));
    if (!p) throw notFound("Produto não encontrado");
    res.json(p);
  });

  api.post("/cart/quote", async (req, res) => {
    const input = quoteSchema.parse(req.body ?? {});
    res.json(await quote(db, await cfg(), input));
  });

  api.post("/orders", limiter(rl, 15, 15), async (req, res) => {
    const key = req.get("Idempotency-Key");
    if (key && !/^[A-Za-z0-9-]{16,64}$/.test(key)) throw new HttpError(400, "Idempotency-Key inválida");
    const input = orderSchema.parse(req.body ?? {});
    const c = await cfg();
    if (input.payment === "cartao" && mp && !input.card) throw new HttpError(400, "Preencha os dados do cartão", { field: "card" });
    if (input.card && input.card.installments > config.mercadopago.maxInstallments) {
      throw new HttpError(400, `Parcelamento em até ${config.mercadopago.maxInstallments}x`, { field: "card" });
    }
    const { order, replay } = await createOrder(db, c, input, key);
    let payment = null;
    if (!replay && mp && (input.payment === "pix" || (input.payment === "cartao" && input.card))) {
      payment = await startPayment(db, c, mp, order, input); // cartão recusado → 402 e pedido cancelado (estoque devolvido)
    }
    const fresh = await db.one("SELECT * FROM orders WHERE code = ?", [order.code]);
    const out = await serializeOrder(db, c, fresh, { withPayment: true });
    if (payment?.error) out.paymentError = payment.error;
    res.status(replay ? 200 : 201).json(out);
  });

  // Tela do Pix: o navegador do cliente pergunta "já pagou?" a cada poucos segundos.
  // Confere no Mercado Pago no máximo 1x a cada 4 s por pedido (o webhook normalmente chega antes).
  api.post("/orders/payment-status", limiter(rl, 15, 400), async (req, res) => {
    const { code, email } = trackSchema.parse(req.body ?? {});
    const c = await cfg();
    let o = await trackOrder(db, c, code, email);
    const row = await db.one("SELECT status, payment_status, payment_checked_at, mp_order_id FROM orders WHERE code = ?", [code]);
    const stale = !row.payment_checked_at || Date.now() - Date.parse(row.payment_checked_at) > 4000;
    if (mp && row.mp_order_id && row.status === "aguardando_pagamento" && stale) {
      try { await syncPayment(db, c, mp, { code }, "consulta"); o = await trackOrder(db, c, code, email); }
      catch (err) { console.error("[pagamento] consulta:", err.message); }
    }
    res.json({ code: o.code, status: o.status, paymentStatus: o.paymentStatus, paymentDetail: o.paymentDetail });
  });

  // Avisos automáticos do Mercado Pago (tópico "Order"). Só confia no que a própria API confirmar.
  api.post("/webhooks/mercadopago", async (req, res) => {
    const dataId = String(req.query["data.id"] ?? req.body?.data?.id ?? "");
    const type = String(req.query.type ?? req.body?.type ?? "");
    if (!mp) return res.status(503).json({ error: "Pagamento online desativado" });
    const valid = verifyWebhookSignature({
      xSignature: req.get("x-signature"), xRequestId: req.get("x-request-id"), dataId, secret: config.mercadopago.webhookSecret,
    });
    if (!valid) {
      console.warn("[webhook] assinatura inválida ou ausente", { type, dataId: dataId.slice(0, 40) });
      return res.status(401).json({ error: "Assinatura inválida" });
    }
    if (type !== "order" || !/^[A-Za-z0-9]{6,64}$/.test(dataId)) return res.status(200).json({ ok: true, ignored: true });
    try {
      await syncPayment(db, await cfg(), mp, { mpOrderId: dataId }, "webhook");
    } catch (err) {
      console.error("[webhook] sync falhou:", err.message);
      return res.status(500).json({ error: "Tente novamente" }); // o Mercado Pago reenvia
    }
    res.status(200).json({ ok: true });
  });

  api.post("/orders/track", limiter(rl, 15, 30), async (req, res) => {
    const { code, email } = trackSchema.parse(req.body ?? {});
    res.json(await trackOrder(db, await cfg(), code, email));
  });

  api.post("/newsletter", limiter(rl, 60, 10), async (req, res) => {
    const { email } = newsletterSchema.parse(req.body ?? {});
    await db.run("INSERT INTO newsletter (email) VALUES (?) ON CONFLICT (email) DO NOTHING", [email]);
    res.status(201).json({ ok: true });
  });

  api.use((req, res) => res.status(404).json({ error: "Rota não encontrada" }));
  app.use("/api", api);

  // ---------- FRONT ----------
  const pub = path.join(config.root, "public");
  app.use("/img", express.static(path.join(pub, "img"), { maxAge: "7d", immutable: false, fallthrough: false }));
  app.use(express.static(pub, {
    extensions: ["html"],
    setHeaders: (res, file) => {
      // HTML/CSS/JS sempre revalidam via ETag (deploy novo aparece na hora); imagens têm cache longo acima
      res.set("Cache-Control", "no-cache");
    },
  }));
  app.use((req, res) => res.status(404).sendFile(path.join(pub, "404.html")));

  // ---------- ERROS ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ZodError) return res.status(400).json({ error: "Dados inválidos", fields: formatZodError(err) });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "JSON inválido" });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "Requisição muito grande" });
    if (err.status === 404 || err.statusCode === 404) return res.status(404).json({ error: "Arquivo não encontrado" });
    // corrida rara entre duas gravações iguais (ex.: mesmo e-mail cadastrado ao mesmo tempo)
    if (err.code === "23505") return res.status(409).json({ error: "Esse registro já existe" });
    if (err.code === "23503") return res.status(409).json({ error: "Registro em uso por outro cadastro" });
    // banco fora do ar / rede: avisa sem expor detalhes
    if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "57P01", "53300"].includes(err.code) || /Connection terminated|timeout exceeded/i.test(err.message)) {
      console.error("[db]", req.method, req.originalUrl, err.message);
      return res.status(503).json({ error: "Serviço temporariamente indisponível. Tente novamente em instantes." });
    }
    console.error("[erro]", req.method, req.originalUrl, err);
    res.status(500).json({ error: "Erro interno. Tente novamente." });
  });

  return app;
}
