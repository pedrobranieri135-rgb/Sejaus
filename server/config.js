import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const int = (v, def) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : def);

export function loadConfig(overrides = {}) {
  const env = process.env;
  return {
    root,
    port: int(env.PORT, 3000),
    env: env.NODE_ENV || "development",
    // Postgres (Supabase): Project Settings → Database → Connection string → Session pooler
    databaseUrl: env.DATABASE_URL || null,
    dbSchema: env.DB_SCHEMA || "loja",
    dbCaCert: env.DATABASE_CA_CERT || null,
    // Supabase Storage para as fotos enviadas pelo painel (sem isso, salva no disco do servidor)
    storage: {
      url: env.SUPABASE_URL || null,
      secretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || null,
      bucket: env.SUPABASE_BUCKET || "produtos",
    },
    // token opcional para integrações (Authorization: Bearer). Sem ele, só login com e-mail e senha.
    adminToken: env.ADMIN_TOKEN || null,
    adminEmail: env.ADMIN_EMAIL || null,
    adminPassword: env.ADMIN_PASSWORD || null,
    trustProxy: int(env.TRUST_PROXY, 0),
    store: {
      name: "Seja US",
      instagram: "seja_us",
      // número no formato internacional, só dígitos (ex.: 5511999999999)
      whatsapp: (env.WHATSAPP_NUMBER || "5500000000000").replace(/\D/g, ""),
      pixKey: env.PIX_KEY || "pix@sejaus.com.br",
      pixMerchantName: env.PIX_MERCHANT_NAME || "SEJA US",
      pixMerchantCity: env.PIX_MERCHANT_CITY || "SAO PAULO",
    },
    freeShippingCents: int(env.FREE_SHIPPING_CENTS, 29900),
    orderTtlHours: int(env.ORDER_TTL_HOURS, 48),
    maxQtyPerItem: 10,
    maxItemsPerOrder: 20,
    ...overrides,
  };
}
