import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { categories, products as catalog } from "../data/catalog.js";
import { imageIds } from "../db.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.js";
import { imageUrls } from "../lib/images.js";

const IMAGE_ID = /^[a-z0-9][a-z0-9-]{2,140}$/;

const slugify = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);

const uniq = (arr, key) => new Set(arr.map(key)).size === arr.length;

export const productSchema = z.object({
  name: z.string().trim().min(3, "Nome muito curto").max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,120}$/, "Use letras minúsculas, números e hífen").optional().or(z.literal("").transform(() => undefined)),
  line: z.enum(["adapt", "essential"]),
  category: z.string().refine((c) => c in categories, "Categoria inválida"),
  priceCents: z.coerce.number().int().min(100, "Preço mínimo R$ 1,00").max(100_000_00),
  compareAtCents: z.union([z.coerce.number().int().min(0), z.null()]).optional().transform((v) => v || null),
  description: z.string().trim().max(2000).default(""),
  fabric: z.string().trim().max(120).nullable().optional().transform((v) => v || null),
  features: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  badges: z.array(z.string().trim().min(1).max(20)).max(3).default([]),
  sizeGuide: z.enum(["adapt"]).nullable().optional().transform((v) => v || null),
  active: z.boolean().default(true),
  variants: z.array(z.object({
    id: z.coerce.number().int().positive().optional(),
    color: z.string().trim().min(1, "Informe a cor").max(40),
    hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor inválida"),
    images: z.array(z.string().regex(IMAGE_ID)).min(1, "Adicione pelo menos 1 foto").max(8),
    skus: z.array(z.object({
      id: z.coerce.number().int().positive().optional(),
      size: z.string().trim().min(1).max(10),
      qty: z.coerce.number().int().min(0).max(100_000),
    }).strict()).min(1, "Adicione pelo menos 1 tamanho").max(12)
      .refine((s) => uniq(s, (x) => x.size.toUpperCase()), "Tamanho repetido"),
  }).strict()).min(1, "Adicione pelo menos 1 cor").max(20)
    .refine((v) => uniq(v, (x) => x.color.toLowerCase()), "Cor repetida"),
}).strict().superRefine((p, ctx) => {
  if (p.compareAtCents && p.compareAtCents <= p.priceCents) {
    ctx.addIssue({ path: ["compareAtCents"], code: "custom", message: "O preço \"de\" precisa ser maior que o preço de venda" });
  }
});

async function soldBySlug(db) {
  const rows = await db.all(`SELECT oi.product_slug AS slug, SUM(oi.qty) AS qty FROM order_items oi
    JOIN orders o ON o.id = oi.order_id WHERE o.status != 'cancelado' GROUP BY oi.product_slug`);
  return new Map(rows.map((r) => [r.slug, r.qty]));
}

/** Monta os produtos com cores, fotos e estoque em 3 consultas (não uma por produto). */
async function shapeMany(db, products) {
  if (!products.length) return [];
  const sold = await soldBySlug(db);
  const pids = products.map((p) => p.id);
  const variants = await db.all(`SELECT * FROM variants WHERE product_id IN (${pids.map(() => "?").join(",")}) ORDER BY position, id`, pids);
  const vids = variants.map((v) => v.id);
  const skus = vids.length ? await db.all(`SELECT id, variant_id, size, qty FROM skus WHERE variant_id IN (${vids.map(() => "?").join(",")}) ORDER BY position, id`, vids) : [];
  const skusBy = Map.groupBy(skus, (s) => s.variant_id);
  const varsBy = Map.groupBy(variants, (v) => v.product_id);
  return products.map((p) => {
    const vs = (varsBy.get(p.id) || []).map((v) => ({
      id: v.id, color: v.color, slug: v.slug, hex: v.hex,
      images: JSON.parse(v.images).map(imageUrls),
      skus: (skusBy.get(v.id) || []).map(({ id, size, qty }) => ({ id, size, qty })),
    }));
    const stock = vs.reduce((s, v) => s + v.skus.reduce((a, k) => a + k.qty, 0), 0);
    return {
      id: p.id, slug: p.slug, name: p.name, line: p.line, category: p.category, categoryLabel: categories[p.category] || p.category,
      priceCents: p.price_cents, compareAtCents: p.compare_at_cents, description: p.description, fabric: p.fabric,
      features: JSON.parse(p.features), badges: JSON.parse(p.badges), sizeGuide: p.size_guide, active: !!p.active,
      createdAt: p.created_at, variants: vs, stock, sold: sold.get(p.slug) ?? 0,
      lowStock: vs.some((v) => v.skus.some((k) => k.qty > 0 && k.qty <= 2)),
      outOfStock: stock === 0,
    };
  });
}

export async function adminListProducts(db) {
  return shapeMany(db, await db.all("SELECT * FROM products ORDER BY position, id"));
}

export async function adminGetProduct(db, id) {
  const p = await db.one("SELECT * FROM products WHERE id = ?", [id]);
  if (!p) throw notFound("Produto não encontrado");
  return (await shapeMany(db, [p]))[0];
}

// fotos do catálogo original (arquivos estáticos em /img/p, publicados junto com o site)
const CATALOG_IMAGES = new Set(catalog.flatMap((p) => p.variants.flatMap((v) => imageIds(p.slug, v))));

/** Foto existe? Catálogo original: lista fixa. Enviada pelo painel: registrada em uploads. */
async function assertImagesExist(db, root, ids) {
  const uploaded = ids.filter((i) => /^(up|lo)-/.test(i));
  const known = uploaded.length
    ? new Set((await db.all(`SELECT id FROM uploads WHERE id IN (${uploaded.map(() => "?").join(",")})`, uploaded)).map((r) => r.id))
    : new Set();
  for (const img of ids) {
    const ok = /^(up|lo)-/.test(img) ? known.has(img) : CATALOG_IMAGES.has(img);
    if (!ok) throw badRequest(`Foto não encontrada: ${img}`, { field: "variants" });
  }
}

export async function saveProduct(db, root, input, id = null) {
  const p = productSchema.parse(input);
  await assertImagesExist(db, root, [...new Set(p.variants.flatMap((v) => v.images))]);

  const savedId = await db.tx(async (t) => {
    let slug = p.slug || slugify(p.name);
    const clash = async (s) => !!(await t.one("SELECT id FROM products WHERE slug = ? AND id != ?", [s, id ?? 0]));
    if (p.slug && (await clash(slug))) throw conflict("Já existe um produto com esse endereço (slug)");
    for (let n = 2; await clash(slug); n++) slug = `${slugify(p.name)}-${n}`;

    const cols = [slug, p.name, p.line, p.line === "adapt" ? "masculino" : "feminino", p.category, p.priceCents,
      p.compareAtCents, p.description, p.fabric, JSON.stringify(p.features), JSON.stringify(p.badges), p.sizeGuide, p.active ? 1 : 0];
    let pid = id;
    if (id) {
      const r = await t.run(`UPDATE products SET slug=?, name=?, line=?, gender=?, category=?, price_cents=?, compare_at_cents=?, description=?,
        fabric=?, features=?, badges=?, size_guide=?, active=? WHERE id=?`, [...cols, id]);
      if (r.changes !== 1) throw notFound("Produto não encontrado");
    } else {
      pid = (await t.one(`INSERT INTO products (slug, name, line, gender, category, price_cents, compare_at_cents, description, fabric,
        features, badges, size_guide, active, position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, (SELECT COALESCE(MAX(position), -1) + 1 FROM products))
        RETURNING id`, cols)).id;
    }

    const skuHasOrders = async (skuId) => !!(await t.one("SELECT 1 FROM order_items WHERE sku_id = ? LIMIT 1", [skuId]));
    const existingV = new Map((await t.all("SELECT * FROM variants WHERE product_id = ?", [pid])).map((v) => [v.id, v]));
    const keepV = new Set();
    for (const [vi, v] of p.variants.entries()) {
      const vslug = slugify(v.color) || `cor-${vi + 1}`;
      let vid = v.id;
      if (vid && existingV.has(vid)) {
        const old = existingV.get(vid);
        const keepSlug = old.color === v.color ? old.slug : `${vslug}-${vid}`;
        await t.run("UPDATE variants SET color=?, slug=?, hex=?, images=?, position=? WHERE id=?", [v.color, keepSlug, v.hex, JSON.stringify(v.images), vi, vid]);
      } else {
        vid = (await t.one("INSERT INTO variants (product_id, color, slug, hex, images, position) VALUES (?,?,?,?,?,?) RETURNING id",
          [pid, v.color, `${vslug}-${crypto.randomBytes(3).toString("hex")}`, v.hex, JSON.stringify(v.images), vi])).id;
      }
      keepV.add(vid);

      const existingS = new Map((await t.all("SELECT * FROM skus WHERE variant_id = ?", [vid])).map((s) => [s.id, s]));
      const keepS = new Set();
      // remove primeiro os tamanhos que saíram (libera o nome do tamanho para reuso, ex.: trocar "M" por "M")
      const incomingIds = new Set(v.skus.filter((s) => s.id && existingS.has(s.id)).map((s) => s.id));
      for (const [sid, s] of existingS) {
        if (incomingIds.has(sid)) continue;
        if (await skuHasOrders(sid)) throw conflict(`O tamanho ${s.size} de ${v.color} já tem pedidos. Zere o estoque em vez de remover.`);
        await t.run("DELETE FROM skus WHERE id = ?", [sid]);
      }
      for (const [si, s] of v.skus.entries()) {
        if (s.id && existingS.has(s.id)) {
          await t.run("UPDATE skus SET size=?, qty=?, position=? WHERE id=?", [s.size, s.qty, si, s.id]);
          keepS.add(s.id);
        } else {
          keepS.add((await t.one("INSERT INTO skus (variant_id, size, qty, position) VALUES (?,?,?,?) RETURNING id", [vid, s.size, s.qty, si])).id);
        }
      }
    }
    for (const [vid, v] of existingV) {
      if (keepV.has(vid)) continue;
      const used = await t.one("SELECT 1 FROM order_items oi JOIN skus s ON s.id = oi.sku_id WHERE s.variant_id = ? LIMIT 1", [vid]);
      if (used) throw conflict(`A cor ${v.color} já tem pedidos. Zere o estoque em vez de remover.`);
      await t.run("DELETE FROM variants WHERE id = ?", [vid]);
    }
    return pid;
  });
  return adminGetProduct(db, savedId);
}

export async function setProductActive(db, id, active) {
  if ((await db.run("UPDATE products SET active = ? WHERE id = ?", [active ? 1 : 0, id])).changes !== 1) throw notFound("Produto não encontrado");
}

export async function deleteProduct(db, id) {
  const p = await db.one("SELECT * FROM products WHERE id = ?", [id]);
  if (!p) throw notFound("Produto não encontrado");
  if (await db.one("SELECT 1 FROM order_items WHERE product_slug = ? LIMIT 1", [p.slug])) {
    await db.run("UPDATE products SET active = 0 WHERE id = ?", [id]);
    return { deleted: false, deactivated: true };
  }
  await db.run("DELETE FROM products WHERE id = ?", [id]);
  return { deleted: true };
}

export const bulkPriceSchema = z.object({
  action: z.enum(["increase", "decrease", "promo", "clear_promo"]),
  percent: z.coerce.number().min(0).max(90).default(0),
  line: z.enum(["adapt", "essential", ""]).optional().transform((v) => v || null),
  category: z.string().optional().transform((v) => v || null),
  rounding: z.enum(["90", "none"]).default("90"),
  ids: z.array(z.coerce.number().int().positive()).max(500).optional(),
}).strict().refine((b) => b.action === "clear_promo" || b.percent > 0, { path: ["percent"], message: "Informe a porcentagem" });

const round90 = (c) => Math.max(190, Math.floor(c / 100) * 100 + 90);

/** Reajuste/promoção em massa. Retorna a prévia (dryRun) ou aplica. */
export async function bulkPrice(db, input, { dryRun = false } = {}) {
  const b = bulkPriceSchema.parse(input);
  let rows = await db.all("SELECT id, name, price_cents, compare_at_cents, line, category FROM products ORDER BY position, id");
  if (b.ids?.length) rows = rows.filter((r) => b.ids.includes(r.id));
  if (b.line) rows = rows.filter((r) => r.line === b.line);
  if (b.category) rows = rows.filter((r) => r.category === b.category);
  const changes = rows.map((r) => {
    let price = r.price_cents;
    let compare = r.compare_at_cents;
    const rnd = (c) => (b.rounding === "90" ? round90(c) : Math.round(c));
    if (b.action === "increase") price = rnd(r.price_cents * (1 + b.percent / 100));
    if (b.action === "decrease") price = rnd(r.price_cents * (1 - b.percent / 100));
    if (b.action === "promo") { compare = r.compare_at_cents ?? r.price_cents; price = rnd(compare * (1 - b.percent / 100)); }
    if (b.action === "clear_promo") { price = r.compare_at_cents ?? r.price_cents; compare = null; }
    if (compare != null && compare <= price) compare = null;
    return { id: r.id, name: r.name, from: r.price_cents, to: price, compareAt: compare, before: r.compare_at_cents };
  }).filter((c) => c.to !== c.from || c.compareAt !== c.before).map(({ before, ...c }) => c);
  if (!dryRun && changes.length) {
    await db.tx(async (t) => {
      for (const c of changes) await t.run("UPDATE products SET price_cents = ?, compare_at_cents = ? WHERE id = ?", [c.to, c.compareAt, c.id]);
    });
  }
  return { count: changes.length, changes };
}

/* ---------------- upload de fotos ---------------- */

async function putStorage(storage, key, body) {
  const res = await fetch(`${storage.url}/storage/v1/object/${storage.bucket}/${key}`, {
    method: "POST",
    headers: { apikey: storage.secretKey, "Content-Type": "image/webp", "cache-control": "31536000", "x-upsert": "false" },
    body,
  });
  if (!res.ok) {
    console.error("[storage] upload falhou:", res.status, (await res.text()).slice(0, 300));
    throw new HttpError(502, "Não foi possível salvar a foto. Tente novamente.");
  }
}

/**
 * Recebe a imagem crua, valida pelo conteúdo (não pela extensão), gera as versões WEBP
 * e salva no Supabase Storage (ou no disco, em desenvolvimento sem Supabase).
 */
export async function saveUpload(db, config, buffer) {
  const { default: sharp } = await import("sharp");
  let meta;
  try { meta = await sharp(buffer, { limitInputPixels: 60_000_000 }).metadata(); }
  catch { throw badRequest("Arquivo não é uma imagem válida"); }
  if (!["jpeg", "png", "webp"].includes(meta.format)) throw badRequest("Envie JPG, PNG ou WEBP");
  if (meta.width < 300 || meta.height < 300) throw badRequest("Imagem pequena demais (mínimo 300×300 px)");

  const base = sharp(buffer, { limitInputPixels: 60_000_000 }).rotate(); // respeita a orientação EXIF e descarta metadados (GPS etc.)
  const [lg, sm] = await Promise.all([
    base.clone().resize({ width: 1000, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(),
    base.clone().resize({ width: 520, withoutEnlargement: true }).webp({ quality: 74 }).toBuffer(),
  ]);
  const suffix = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const storage = config.storage;

  if (storage?.url && storage?.secretKey) {
    const id = `up-${suffix}`;
    await Promise.all([putStorage(storage, `p/${id}.webp`, lg), putStorage(storage, `p/${id}-s.webp`, sm)]);
    await db.run("INSERT INTO uploads (id, storage) VALUES (?, 'supabase')", [id]);
    return imageUrls(id);
  }

  const id = `lo-${suffix}`;
  const dir = path.join(config.root, "public", "img", "p");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.webp`), lg);
  fs.writeFileSync(path.join(dir, `${id}-s.webp`), sm);
  await db.run("INSERT INTO uploads (id, storage) VALUES (?, 'local')", [id]);
  return imageUrls(id);
}
