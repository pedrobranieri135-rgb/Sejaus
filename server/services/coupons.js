import { z } from "zod";
import { conflict, notFound } from "../lib/errors.js";

const brl = (cents) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const LINE_LABEL = { adapt: "US Adapt", essential: "US Essential" };

/**
 * Avalia o cupom para o carrinho. `customer` (cpf/email) só existe no fechamento do pedido —
 * regras "primeira compra" e "uma vez por cliente" são checadas nesse momento.
 * Retorna { coupon, discount, freeShipping }.
 */
export async function evaluateCoupon(db, code, { lines, customer } = {}) {
  if (!code) return { coupon: null, discount: 0, freeShipping: false };
  const c = (await db.one("SELECT * FROM coupons WHERE code = ?", [code]));
  const now = new Date().toISOString();
  const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const eligible = c?.line ? lines.filter((l) => l.line === c.line).reduce((s, l) => s + l.lineTotalCents, 0) : subtotal;

  let error = null;
  if (!c || !c.active) error = "Cupom inválido";
  else if (c.starts_at && c.starts_at > now) error = "Este cupom ainda não começou a valer";
  else if (c.expires_at && c.expires_at < now) error = "Cupom expirado";
  else if (c.max_uses != null && c.uses >= c.max_uses) error = "Cupom esgotado";
  else if (subtotal < c.min_subtotal_cents) error = `Cupom válido para compras a partir de ${brl(c.min_subtotal_cents)}`;
  else if (c.line && eligible === 0) error = `Cupom válido só para peças ${LINE_LABEL[c.line]}`;
  else if (customer && (c.first_purchase_only || c.once_per_customer)) {
    const prev = (await db.one(`SELECT COUNT(*) AS n FROM orders WHERE status != 'cancelado' AND (cpf = ? OR email = ?)
      ${c.once_per_customer && !c.first_purchase_only ? "AND coupon_code = ?" : ""}`, [...[customer.cpf, customer.email, ...(c.once_per_customer && !c.first_purchase_only ? [c.code] : [])]])).n;
    if (prev > 0) error = c.first_purchase_only ? "Cupom válido somente na primeira compra" : "Você já usou este cupom";
  }
  if (error) return { coupon: { code, valid: false, message: error }, discount: 0, freeShipping: false };

  let discount = 0;
  if (c.kind === "percent") discount = Math.round((eligible * c.value) / 100);
  if (c.kind === "fixed") discount = Math.min(c.value, eligible);
  return {
    coupon: { code, valid: true, message: c.description || describe(c), kind: c.kind, value: c.value },
    discount,
    freeShipping: c.kind === "shipping",
  };
}

export function describe(c) {
  const what = c.kind === "percent" ? `${c.value}% OFF` : c.kind === "fixed" ? `${brl(c.value)} OFF` : "Frete grátis (entrega padrão)";
  const rules = [
    c.line && `em ${LINE_LABEL[c.line]}`,
    c.min_subtotal_cents > 0 && `acima de ${brl(c.min_subtotal_cents)}`,
    c.first_purchase_only && "na primeira compra",
  ].filter(Boolean);
  return [what, ...rules].join(" ");
}

/* ---------------- admin ---------------- */

const isoOrNull = z.union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal(""), z.null()])
  .optional()
  .transform((v) => (!v ? null : /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00-03:00`).toISOString() : new Date(v).toISOString()));

export const couponSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/, "Use 3 a 30 letras/números, sem espaços"),
  kind: z.enum(["percent", "fixed", "shipping"]),
  value: z.coerce.number().int().min(0).default(0),
  minSubtotalCents: z.coerce.number().int().min(0).max(100_000_00).default(0),
  maxUses: z.union([z.coerce.number().int().min(1), z.literal(""), z.null()]).optional().transform((v) => (v === "" || v == null ? null : v)),
  startsAt: isoOrNull,
  expiresAt: isoOrNull,
  active: z.boolean().default(true),
  firstPurchaseOnly: z.boolean().default(false),
  oncePerCustomer: z.boolean().default(false),
  line: z.enum(["adapt", "essential", ""]).nullable().optional().transform((v) => v || null),
  description: z.string().trim().max(120).default(""),
}).strict().superRefine((c, ctx) => {
  if (c.kind === "percent" && (c.value < 1 || c.value > 90)) ctx.addIssue({ path: ["value"], code: "custom", message: "Porcentagem entre 1 e 90" });
  if (c.kind === "fixed" && c.value < 100) ctx.addIssue({ path: ["value"], code: "custom", message: "Valor mínimo R$ 1,00" });
  if (c.startsAt && c.expiresAt && c.startsAt >= c.expiresAt) ctx.addIssue({ path: ["expiresAt"], code: "custom", message: "O fim precisa ser depois do início" });
});

const toApi = (c) => ({
  code: c.code, kind: c.kind, value: c.value, minSubtotalCents: c.min_subtotal_cents, maxUses: c.max_uses, uses: c.uses,
  startsAt: c.starts_at, expiresAt: c.expires_at, active: !!c.active, firstPurchaseOnly: !!c.first_purchase_only,
  oncePerCustomer: !!c.once_per_customer, line: c.line, description: c.description, createdAt: c.created_at,
  summary: describe(c),
  status: !c.active ? "inativo" : c.expires_at && c.expires_at < new Date().toISOString() ? "expirado"
    : c.max_uses != null && c.uses >= c.max_uses ? "esgotado" : c.starts_at && c.starts_at > new Date().toISOString() ? "agendado" : "ativo",
});

export async function listCoupons(db) {
  const rows = (await db.all("SELECT * FROM coupons ORDER BY created_at DESC, code"));
  const stats = new Map((await db.all(`SELECT coupon_code AS code, COUNT(*) AS orders, SUM(discount_cents) AS discount, SUM(total_cents) AS revenue
    FROM orders WHERE coupon_code IS NOT NULL AND status != 'cancelado' GROUP BY coupon_code`)).map((r) => [r.code, r]));
  return rows.map((c) => ({ ...toApi(c), stats: stats.get(c.code) ?? { orders: 0, discount: 0, revenue: 0 } }));
}

export async function saveCoupon(db, input, { originalCode } = {}) {
  const c = couponSchema.parse(input);
  const params = [c.kind, c.kind === "shipping" ? 0 : c.value, c.minSubtotalCents, c.maxUses, c.startsAt, c.expiresAt, c.active ? 1 : 0,
    c.firstPurchaseOnly ? 1 : 0, c.oncePerCustomer ? 1 : 0, c.line, c.description];
  if (originalCode) {
    const existing = (await db.one("SELECT * FROM coupons WHERE code = ?", [originalCode]));
    if (!existing) throw notFound("Cupom não encontrado");
    if (c.code !== originalCode) {
      if (existing.uses > 0) throw conflict("Cupom já usado não pode trocar de código. Crie um novo.");
      if ((await db.one("SELECT 1 FROM coupons WHERE code = ?", [c.code]))) throw conflict("Já existe um cupom com esse código");
    }
    (await db.run(`UPDATE coupons SET code=?, kind=?, value=?, min_subtotal_cents=?, max_uses=?, starts_at=?, expires_at=?, active=?,
      first_purchase_only=?, once_per_customer=?, line=?, description=? WHERE code=?`, [c.code, ...params, originalCode]));
  } else {
    if ((await db.one("SELECT 1 FROM coupons WHERE code = ?", [c.code]))) throw conflict("Já existe um cupom com esse código");
    (await db.run(`INSERT INTO coupons (code, kind, value, min_subtotal_cents, max_uses, starts_at, expires_at, active,
      first_purchase_only, once_per_customer, line, description) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [c.code, ...params]));
  }
  return toApi((await db.one("SELECT * FROM coupons WHERE code = ?", [c.code])));
}

export async function deleteCoupon(db, code) {
  const c = (await db.one("SELECT * FROM coupons WHERE code = ?", [code]));
  if (!c) throw notFound("Cupom não encontrado");
  const used = (await db.one("SELECT COUNT(*) AS n FROM orders WHERE coupon_code = ?", [code])).n;
  if (used > 0) {
    // histórico de pedidos aponta para ele: só desativa
    (await db.run("UPDATE coupons SET active = 0 WHERE code = ?", [code]));
    return { deleted: false, deactivated: true };
  }
  (await db.run("DELETE FROM coupons WHERE code = ?", [code]));
  return { deleted: true };
}

