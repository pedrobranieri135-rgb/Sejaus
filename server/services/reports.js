import { z } from "zod";
import { categories } from "../data/catalog.js";

// pedido "pago" = dinheiro confirmado
export const PAID = "('pago','em_separacao','enviado','entregue')";
// datas no fuso de Brasília
const LOCAL_DATE = "(o.created_at AT TIME ZONE 'America/Sao_Paulo')::date";

const day = (d) => d.toISOString().slice(0, 10);
export function todayBR(now = Date.now()) { return day(new Date(now - 3 * 3600_000)); }
const addDays = (iso, n) => day(new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400_000));
const diffDays = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().startsWith(d), "Data inválida");
export const rangeSchema = z.object({ from: isoDate.optional(), to: isoDate.optional() }).passthrough();

export function resolveRange(q = {}) {
  const r = rangeSchema.parse(q);
  const to = r.to || todayBR();
  const from = r.from || addDays(to, -29);
  if (from > to) return { from: to, to: from };
  if (diffDays(from, to) > 730) return { from: addDays(to, -730), to };
  return { from, to };
}

/** Todos os totais do período em uma consulta só (o banco fica longe: menos idas e voltas). */
async function totals(db, from, to) {
  const t = await db.one(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ${PAID})                                  AS orders,
      COALESCE(SUM(total_cents)    FILTER (WHERE status IN ${PAID}), 0)          AS revenue,
      COALESCE(SUM(discount_cents) FILTER (WHERE status IN ${PAID}), 0)          AS discounts,
      COALESCE(SUM(shipping_cents) FILTER (WHERE status IN ${PAID}), 0)          AS shipping,
      COALESCE(SUM(subtotal_cents) FILTER (WHERE status IN ${PAID}), 0)          AS products,
      COUNT(*)                                                                   AS all_orders,
      COUNT(*) FILTER (WHERE status = 'aguardando_pagamento')                    AS pending_n,
      COALESCE(SUM(total_cents) FILTER (WHERE status = 'aguardando_pagamento'), 0) AS pending_v,
      COUNT(*) FILTER (WHERE status = 'cancelado')                               AS cancelled_n,
      COALESCE(SUM(total_cents) FILTER (WHERE status = 'cancelado'), 0)          AS cancelled_v,
      COUNT(DISTINCT email) FILTER (WHERE status IN ${PAID})                     AS customers,
      (SELECT COALESCE(SUM(oi.qty), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.status IN ${PAID} AND ${LOCAL_DATE} BETWEEN ? AND ?)             AS items
    FROM orders o WHERE ${LOCAL_DATE} BETWEEN ? AND ?`, [from, to, from, to]);
  return {
    revenueCents: t.revenue, orders: t.orders, avgTicketCents: t.orders ? Math.round(t.revenue / t.orders) : 0,
    itemsSold: t.items, discountsCents: t.discounts, shippingCents: t.shipping, productsCents: t.products,
    ordersCreated: t.all_orders, paymentRate: t.all_orders ? t.orders / t.all_orders : 0, customers: t.customers,
    pending: { count: t.pending_n, valueCents: t.pending_v }, cancelled: { count: t.cancelled_n, valueCents: t.cancelled_v },
  };
}

// sem base anterior não existe variação percentual honesta
const pct = (cur, prev) => (prev ? (cur - prev) / prev : null);

export async function report(db, q) {
  const { from, to } = resolveRange(q);
  const len = diffDays(from, to) + 1;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(len - 1));
  const range = [from, to];

  const itemsBase = `FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN products p ON p.slug = oi.product_slug
    WHERE o.status IN ${PAID} AND ${LOCAL_DATE} BETWEEN ? AND ?`;
  const paidOrders = `FROM orders o WHERE status IN ${PAID} AND ${LOCAL_DATE} BETWEEN ? AND ?`;

  // consultas independentes rodam em paralelo
  const [cur, prev, dailyList, byLine, byCategory, topProducts, topVariants, bySize, payments, coupons, byState, shippingMethods] = await Promise.all([
    totals(db, from, to),
    totals(db, prevFrom, prevTo),
    db.all(`SELECT ${LOCAL_DATE} AS d, COUNT(*) AS orders, SUM(total_cents) AS revenue ${paidOrders} GROUP BY 1`, range),
    db.all(`SELECT COALESCE(p.line,'outros') AS key, SUM(oi.qty) AS qty, SUM(oi.qty*oi.unit_price_cents) AS revenue ${itemsBase} GROUP BY 1 ORDER BY revenue DESC`, range),
    db.all(`SELECT COALESCE(p.category,'outros') AS key, SUM(oi.qty) AS qty, SUM(oi.qty*oi.unit_price_cents) AS revenue ${itemsBase} GROUP BY 1 ORDER BY revenue DESC`, range),
    db.all(`SELECT oi.product_slug AS slug, MAX(oi.name) AS name, SUM(oi.qty) AS qty, SUM(oi.qty*oi.unit_price_cents) AS revenue ${itemsBase}
      GROUP BY oi.product_slug ORDER BY qty DESC, revenue DESC LIMIT 10`, range),
    db.all(`SELECT MAX(oi.name) AS name, oi.color, oi.size, SUM(oi.qty) AS qty ${itemsBase}
      GROUP BY oi.product_slug, oi.color, oi.size ORDER BY qty DESC LIMIT 10`, range),
    db.all(`SELECT oi.size AS key, SUM(oi.qty) AS qty ${itemsBase} GROUP BY oi.size ORDER BY qty DESC`, range),
    db.all(`SELECT payment_method AS key, COUNT(*) AS orders, SUM(total_cents) AS revenue ${paidOrders} GROUP BY 1 ORDER BY revenue DESC`, range),
    db.all(`SELECT coupon_code AS code, COUNT(*) AS orders, SUM(discount_cents) AS discount, SUM(total_cents) AS revenue
      ${paidOrders} AND coupon_code IS NOT NULL GROUP BY coupon_code ORDER BY orders DESC`, range),
    db.all(`SELECT address::jsonb->>'state' AS key, COUNT(*) AS orders, SUM(total_cents) AS revenue ${paidOrders} GROUP BY 1 ORDER BY revenue DESC`, range),
    db.all(`SELECT shipping_method AS key, COUNT(*) AS orders ${paidOrders} GROUP BY 1`, range),
  ]);

  const dailyRows = new Map(dailyList.map((r) => [r.d, r]));
  const daily = Array.from({ length: len }, (_, i) => {
    const d = addDays(from, i);
    const r = dailyRows.get(d);
    return { date: d, orders: r?.orders ?? 0, revenueCents: r?.revenue ?? 0 };
  });

  return {
    range: { from, to, days: len, previous: { from: prevFrom, to: prevTo } },
    totals: cur,
    previous: prev,
    change: {
      revenue: pct(cur.revenueCents, prev.revenueCents),
      orders: pct(cur.orders, prev.orders),
      avgTicket: pct(cur.avgTicketCents, prev.avgTicketCents),
      itemsSold: pct(cur.itemsSold, prev.itemsSold),
    },
    daily,
    byLine,
    byCategory: byCategory.map((r) => ({ ...r, label: categories[r.key] || r.key })),
    topProducts, topVariants, bySize, payments, coupons, byState, shippingMethods,
  };
}

export async function dashboard(db) {
  const today = todayBR();
  const [t, week, counts, lowStock, recent] = await Promise.all([
    totals(db, today, today),
    report(db, { from: addDays(today, -6), to: today }),
    db.one(`SELECT
        (SELECT COUNT(*) FROM orders WHERE status IN ('pago','em_separacao')) AS to_ship,
        (SELECT COUNT(*) FROM orders WHERE status = 'aguardando_pagamento') AS awaiting_n,
        (SELECT COALESCE(SUM(total_cents),0) FROM orders WHERE status = 'aguardando_pagamento') AS awaiting_v,
        (SELECT COUNT(*) FROM products WHERE active = 1) AS products,
        (SELECT COUNT(*) FROM skus s JOIN variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id WHERE p.active=1 AND s.qty = 0) AS out_of_stock,
        (SELECT COUNT(*) FROM skus s JOIN variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id WHERE p.active=1 AND s.qty BETWEEN 1 AND 2) AS low_stock,
        (SELECT COUNT(*) FROM newsletter) AS newsletter`),
    // esgotou vendendo (não tamanho que nunca existiu naquela cor)
    db.all(`SELECT s.id AS sku, p.id AS "productId", p.name, v.color, s.size, s.qty FROM skus s
      JOIN variants v ON v.id = s.variant_id JOIN products p ON p.id = v.product_id
      WHERE p.active = 1 AND s.qty <= 2 AND (s.qty > 0 OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.sku_id = s.id))
      ORDER BY s.qty, p.position LIMIT 12`),
    db.all(`SELECT code, status, customer_name AS name, total_cents AS total, created_at AS "createdAt" FROM orders ORDER BY id DESC LIMIT 6`),
  ]);
  return {
    today: t,
    week: { totals: week.totals, change: week.change, daily: week.daily, topProducts: week.topProducts.slice(0, 5) },
    toShip: counts.to_ship,
    awaiting: { count: counts.awaiting_n, valueCents: counts.awaiting_v },
    lowStock, recent,
    counts: { products: counts.products, outOfStock: counts.out_of_stock, lowStock: counts.low_stock, newsletter: counts.newsletter },
  };
}

export async function customers(db, q = "") {
  const like = `%${q.replace(/[%_\\]/g, "")}%`;
  return db.all(`
    SELECT email,
      (SELECT customer_name FROM orders x WHERE x.email = o.email ORDER BY id DESC LIMIT 1) AS name,
      (SELECT phone FROM orders x WHERE x.email = o.email ORDER BY id DESC LIMIT 1) AS phone,
      (SELECT (address::jsonb->>'city') || '/' || (address::jsonb->>'state') FROM orders x WHERE x.email = o.email ORDER BY id DESC LIMIT 1) AS city,
      SUM(CASE WHEN status != 'cancelado' THEN 1 ELSE 0 END) AS orders,
      SUM(CASE WHEN status IN ${PAID} THEN total_cents ELSE 0 END) AS spent,
      MIN(created_at) AS "firstOrder", MAX(created_at) AS "lastOrder"
    FROM orders o
    WHERE (? = '' OR email ILIKE ? OR customer_name ILIKE ? OR phone ILIKE ? OR cpf ILIKE ?)
    GROUP BY email ORDER BY spent DESC, "lastOrder" DESC LIMIT 1000`, [q, like, like, like, like]);
}
