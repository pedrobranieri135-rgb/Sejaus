import { categories, sizeGuides } from "../data/catalog.js";
import { imageUrls } from "../lib/images.js";

const LOW_STOCK = 2;

async function loadAll(db, where = "", params = []) {
  const products = await db.all(`SELECT * FROM products WHERE active = 1 ${where} ORDER BY position, id`, params);
  if (!products.length) return [];
  const ids = products.map((p) => p.id);
  const variants = await db.all(`SELECT * FROM variants WHERE product_id IN (${ids.map(() => "?").join(",")}) ORDER BY position, id`, ids);
  const vids = variants.map((v) => v.id);
  const skus = vids.length
    ? await db.all(`SELECT * FROM skus WHERE variant_id IN (${vids.map(() => "?").join(",")}) ORDER BY position, id`, vids)
    : [];

  const skusByVariant = Map.groupBy(skus, (s) => s.variant_id);
  const variantsByProduct = Map.groupBy(variants, (v) => v.product_id);

  return products.map((p) => {
    const vs = (variantsByProduct.get(p.id) || []).map((v) => {
      const ss = skusByVariant.get(v.id) || [];
      return {
        color: v.color,
        slug: v.slug,
        hex: v.hex,
        images: JSON.parse(v.images).map(imageUrls),
        skus: ss.map((s) => ({ id: s.id, size: s.size, available: s.qty > 0, low: s.qty > 0 && s.qty <= LOW_STOCK })),
      };
    });
    const sizes = [...new Set(vs.flatMap((v) => v.skus.map((s) => s.size)))];
    return {
      slug: p.slug,
      name: p.name,
      line: p.line,
      gender: p.gender,
      category: p.category,
      categoryLabel: categories[p.category] || p.category,
      priceCents: p.price_cents,
      compareAtCents: p.compare_at_cents ?? null,
      installments: { count: 3, valueCents: Math.ceil(p.price_cents / 3) },
      description: p.description,
      fabric: p.fabric,
      features: JSON.parse(p.features),
      badges: JSON.parse(p.badges),
      sizeGuide: p.size_guide,
      sizes,
      variants: vs,
      inStock: vs.some((v) => v.skus.some((s) => s.available)),
    };
  });
}

const normalize = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export async function listProducts(db, q = {}) {
  let list = await loadAll(db);
  if (q.line) list = list.filter((p) => p.line === q.line);
  if (q.category) list = list.filter((p) => p.category === q.category);
  if (q.size) list = list.filter((p) => p.variants.some((v) => v.skus.some((s) => s.size === q.size && s.available)));
  if (q.search) {
    const terms = normalize(q.search).split(/\s+/).filter(Boolean);
    list = list.filter((p) => {
      const hay = normalize([p.name, p.categoryLabel, p.description, p.line, ...p.variants.map((v) => v.color)].join(" "));
      return terms.every((t) => hay.includes(t));
    });
  }
  if (q.sort === "price_asc") list.sort((a, b) => a.priceCents - b.priceCents);
  if (q.sort === "price_desc") list.sort((a, b) => b.priceCents - a.priceCents);
  if (q.sort === "name") list.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return list;
}

export async function getProduct(db, slug) {
  return (await loadAll(db, "AND slug = ?", [slug]))[0] || null;
}

export function getMeta() {
  return { categories, sizeGuides };
}
