import { z } from "zod";

// Configurações editáveis pelo painel. O .env é o padrão; o que for salvo no painel tem prioridade.
export const settingsSchema = z.object({
  whatsapp: z.string().transform((s) => s.replace(/\D/g, "")).pipe(z.string().regex(/^55\d{10,11}$/, "Use DDI 55 + DDD + número (ex.: 5567998313659)")),
  pixKey: z.string().trim().min(3, "Informe a chave Pix").max(77),
  pixMerchantName: z.string().trim().min(2).max(25),
  pixMerchantCity: z.string().trim().min(2).max(15),
  freeShippingCents: z.coerce.number().int().min(0).max(10_000_00),
  orderTtlHours: z.coerce.number().int().min(1).max(240),
  announcement: z.string().trim().max(160),
}).partial().strict();

export async function getSettings(db) {
  const rows = (await db.all("SELECT key, value FROM settings"));
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
}

export async function saveSettings(db, patch) {
  const data = settingsSchema.parse(patch);
  for (const [k, v] of Object.entries(data)) {
    await db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(v)]);
  }
  return getSettings(db);
}

const DEFAULT_ANNOUNCEMENT = "Frete grátis acima de R$ 299 / 10% off na primeira compra com o cupom BEMVINDOUS";

/** Config do .env + o que foi salvo no painel. Use em toda requisição que depende da loja. */
export async function effectiveConfig(db, config) {
  const s = await getSettings(db);
  return {
    ...config,
    freeShippingCents: s.freeShippingCents ?? config.freeShippingCents,
    orderTtlHours: s.orderTtlHours ?? config.orderTtlHours,
    announcement: s.announcement ?? DEFAULT_ANNOUNCEMENT,
    store: {
      ...config.store,
      whatsapp: s.whatsapp ?? config.store.whatsapp,
      pixKey: s.pixKey ?? config.store.pixKey,
      pixMerchantName: s.pixMerchantName ?? config.store.pixMerchantName,
      pixMerchantCity: s.pixMerchantCity ?? config.store.pixMerchantCity,
    },
  };
}
