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
import { createOrder, expireStaleOrders, quote, trackOrder } from "./services/checkout.js";
import { storagePublicBase } from "./lib/images.js";
import { effectiveConfig } from "./services/settings.js";

const limiter = (enabled, windowMin, max) =>
  enabled
    ? rateLimit({
        windowMs: windowMin * 60_000, limit: max, standardHeaders: "draft-7", legacyHeaders: false,
        message: { error: "Muitas requisições. Tente novamente em instantes." },
      })
    : (req, res, next) => next();

export function createApp({ db, config }) {
  const app = express();
  const rl = config.rateLimit !== false;
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.set("query parser", "simple");

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", ...(storagePublicBase() ? [new URL(storagePublicBase()).origin] : [])],
        connectSrc: ["'self'", "https://viacep.com.br"],
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
  api.use("/admin", adminRouter({ db, config, limiter: (w, m) => limiter(rl, w, m) }));
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
    const n = await expireStaleOrders(db, (await cfg()).orderTtlHours);
    res.json({ ok: true, expired: n });
  });

  api.get("/meta", async (req, res) => {
    const c = await cfg();
    res.json({
      ...getMeta(),
      store: { name: config.store.name, instagram: config.store.instagram, whatsapp: c.store.whatsapp },
      freeShippingCents: c.freeShippingCents,
      announcement: c.announcement,
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
    const { order, replay } = await createOrder(db, await cfg(), input, key);
    res.status(replay ? 200 : 201).json(order);
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
