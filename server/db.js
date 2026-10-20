import fs from "node:fs";
import pg from "pg";
import { products as catalog } from "./data/catalog.js";

// Tipos do Postgres → JS: datas como ISO string (comparáveis como texto), contagens/somas como número.
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz
pg.types.setTypeParser(1114, (v) => new Date(`${v}Z`).toISOString()); // timestamp
pg.types.setTypeParser(1082, (v) => v); // date → "AAAA-MM-DD"
pg.types.setTypeParser(20, (v) => Number(v)); // bigint (COUNT/SUM)
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric

const IDENT = /^[a-z_][a-z0-9_]{0,40}$/;

/** "?" → "$1, $2…" (deixa as consultas legíveis e iguais às originais). */
const numbered = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

/** Interface comum para pool e transação: one / all / run. */
function wrap(exec) {
  return {
    async all(sql, params = []) { return (await exec(numbered(sql), params)).rows; },
    async one(sql, params = []) { return (await exec(numbered(sql), params)).rows[0]; },
    async run(sql, params = []) { const r = await exec(numbered(sql), params); return { changes: r.rowCount, rows: r.rows }; },
    async exec(sql) { await exec(sql, []); },
  };
}

export function connect({ databaseUrl, schema = "loja", caCert, max = 10 }) {
  if (!databaseUrl) throw new Error("DATABASE_URL não definida. Veja o .env.example.");
  if (!IDENT.test(schema)) throw new Error(`Schema inválido: ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.delete("sslmode"); // SSL configurado abaixo
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  // Pooler em modo transação (porta 6543, usado na Vercel): cada consulta pode cair numa conexão diferente,
  // então o schema vem do próprio usuário do banco (ALTER ROLE loja_app SET search_path = loja).
  const transactionPooler = url.port === "6543";
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    // Supabase exige SSL. Com o certificado do projeto (DATABASE_CA_CERT) a conexão é verificada de ponta a ponta.
    ssl: local ? false : caCert ? { ca: fs.readFileSync(caCert, "utf8"), rejectUnauthorized: true } : { rejectUnauthorized: false },
  });
  pool.on("error", (err) => console.error("[db] conexão ociosa caiu:", err.message));
  const ready = new WeakSet();
  const client = async () => {
    const c = await pool.connect();
    if (!ready.has(c)) {
      if (!transactionPooler) await c.query(`SET search_path TO "${schema}", public`);
      ready.add(c);
    }
    return c;
  };

  const db = wrap(async (sql, params) => {
    const c = await client();
    try { return await c.query(sql, params); } finally { c.release(); }
  });
  db.schema = schema;
  db.pool = pool;
  /** Transação: tudo ou nada. Se fn lançar erro, desfaz. */
  db.tx = async (fn) => {
    const c = await client();
    try {
      await c.query("BEGIN");
      if (transactionPooler) await c.query(`SET LOCAL search_path TO "${schema}", public`);
      const out = await fn(wrap((sql, params) => c.query(sql, params)));
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  };
  db.close = () => pool.end();
  return db;
}

/* ------------------------------------------------------------------ */
/* Migrações (tabela schema_migrations). Idempotentes: podem rodar de novo. */

const MIGRATIONS = [
  ["001_inicial", (s) => `
    SET LOCAL search_path TO "${s}", public;
    CREATE TABLE IF NOT EXISTS products (
      id               SERIAL PRIMARY KEY,
      slug             TEXT NOT NULL UNIQUE,
      name             TEXT NOT NULL,
      line             TEXT NOT NULL CHECK (line IN ('adapt','essential')),
      gender           TEXT NOT NULL,
      category         TEXT NOT NULL,
      price_cents      INTEGER NOT NULL CHECK (price_cents > 0),
      compare_at_cents INTEGER,
      description      TEXT NOT NULL DEFAULT '',
      fabric           TEXT,
      features         TEXT NOT NULL DEFAULT '[]',
      badges           TEXT NOT NULL DEFAULT '[]',
      size_guide       TEXT,
      position         INTEGER NOT NULL DEFAULT 0,
      active           INTEGER NOT NULL DEFAULT 1,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS variants (
      id          SERIAL PRIMARY KEY,
      product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      color       TEXT NOT NULL,
      slug        TEXT NOT NULL,
      hex         TEXT NOT NULL,
      images      TEXT NOT NULL DEFAULT '[]',
      position    INTEGER NOT NULL DEFAULT 0,
      UNIQUE (product_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);
    CREATE TABLE IF NOT EXISTS skus (
      id          SERIAL PRIMARY KEY,
      variant_id  INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
      size        TEXT NOT NULL,
      qty         INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
      position    INTEGER NOT NULL DEFAULT 0,
      UNIQUE (variant_id, size)
    );
    CREATE TABLE IF NOT EXISTS coupons (
      code                TEXT PRIMARY KEY,
      kind                TEXT NOT NULL CHECK (kind IN ('percent','fixed','shipping')),
      value               INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
      min_subtotal_cents  INTEGER NOT NULL DEFAULT 0,
      max_uses            INTEGER,
      uses                INTEGER NOT NULL DEFAULT 0,
      starts_at           TIMESTAMPTZ,
      expires_at          TIMESTAMPTZ,
      active              INTEGER NOT NULL DEFAULT 1,
      first_purchase_only INTEGER NOT NULL DEFAULT 0,
      once_per_customer   INTEGER NOT NULL DEFAULT 0,
      line                TEXT CHECK (line IS NULL OR line IN ('adapt','essential')),
      description         TEXT NOT NULL DEFAULT '',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id               SERIAL PRIMARY KEY,
      code             TEXT NOT NULL UNIQUE,
      status           TEXT NOT NULL,
      customer_name    TEXT NOT NULL,
      email            TEXT NOT NULL,
      phone            TEXT NOT NULL,
      cpf              TEXT NOT NULL,
      address          TEXT NOT NULL,
      shipping_method  TEXT NOT NULL,
      shipping_cents   INTEGER NOT NULL,
      subtotal_cents   INTEGER NOT NULL,
      discount_cents   INTEGER NOT NULL DEFAULT 0,
      total_cents      INTEGER NOT NULL,
      coupon_code      TEXT,
      payment_method   TEXT NOT NULL,
      idempotency_key  TEXT UNIQUE,
      stock_restored   INTEGER NOT NULL DEFAULT 0,
      tracking_code    TEXT,
      carrier          TEXT,
      internal_note    TEXT,
      shipped_at       TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email);
    CREATE INDEX IF NOT EXISTS idx_orders_cpf ON orders(cpf);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
    CREATE TABLE IF NOT EXISTS order_items (
      id                SERIAL PRIMARY KEY,
      order_id          INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      sku_id            INTEGER NOT NULL REFERENCES skus(id),
      product_slug      TEXT NOT NULL,
      name              TEXT NOT NULL,
      color             TEXT NOT NULL,
      size              TEXT NOT NULL,
      image             TEXT,
      unit_price_cents  INTEGER NOT NULL,
      qty               INTEGER NOT NULL CHECK (qty > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_sku ON order_items(sku_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_slug ON order_items(product_slug);
    CREATE TABLE IF NOT EXISTS order_events (
      id        SERIAL PRIMARY KEY,
      order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      status    TEXT NOT NULL,
      note      TEXT,
      at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);
    CREATE TABLE IF NOT EXISTS newsletter (
      email       TEXT PRIMARY KEY,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admins (
      id             SERIAL PRIMARY KEY,
      email          TEXT NOT NULL UNIQUE,
      name           TEXT NOT NULL,
      password_hash  TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at  TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_admin ON sessions(admin_id);
    CREATE TABLE IF NOT EXISTS admin_log (
      id      SERIAL PRIMARY KEY,
      admin   TEXT NOT NULL,
      action  TEXT NOT NULL,
      detail  TEXT,
      at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS uploads (
      id          TEXT PRIMARY KEY,
      storage     TEXT NOT NULL CHECK (storage IN ('supabase','local')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `],
  // O schema da loja não é exposto na API pública do Supabase; mesmo assim, RLS ligado e
  // nenhum acesso para anon/authenticated: só o servidor (dono das tabelas) lê e grava.
  ["002_bloqueio_api_publica", (s) => `
    DO $$
    DECLARE t record;
    BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = '${s}' LOOP
        EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', '${s}', t.tablename);
      END LOOP;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA "${s}" FROM anon, authenticated';
        EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA "${s}" FROM anon, authenticated';
        EXECUTE 'REVOKE ALL ON SCHEMA "${s}" FROM anon, authenticated';
      END IF;
    END $$;
  `],
];

export async function migrate(db) {
  const s = db.schema;
  await db.exec(`CREATE SCHEMA IF NOT EXISTS "${s}"`);
  await db.exec(`CREATE TABLE IF NOT EXISTS "${s}".schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await db.exec(`ALTER TABLE "${s}".schema_migrations ENABLE ROW LEVEL SECURITY`);
  const done = new Set((await db.all(`SELECT name FROM "${s}".schema_migrations`)).map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (done.has(name)) continue;
    await db.tx(async (t) => {
      // trava para duas instâncias subindo juntas não aplicarem a mesma migração
      await t.exec(`SELECT pg_advisory_xact_lock(hashtext('${s}.migrations'))`);
      if (await t.one(`SELECT 1 FROM "${s}".schema_migrations WHERE name = ?`, [name])) return;
      await t.exec(sql(s));
      await t.run(`INSERT INTO "${s}".schema_migrations (name) VALUES (?)`, [name]);
    });
  }
}

/* ------------------------------------------------------------------ */
/* Seed do catálogo (em lote: poucas idas ao banco, rápido mesmo longe do servidor) */

export const imageIds = (productSlug, variant) => variant.src.map((_, i) => `${productSlug}--${variant.slug}-${i + 1}`);

// estoque determinístico (mesmo resultado a cada seed) — 1 a 14 unidades
function seededQty(key) {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const r = (h >>> 0) % 100;
  return r < 8 ? 1 : r < 15 ? 2 : 3 + (r % 12);
}

const multiInsert = (table, cols, rows, returning = "") => {
  const params = [];
  const values = rows.map((row) => `(${row.map((v) => { params.push(v); return "?"; }).join(",")})`).join(",");
  return [`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values} ${returning}`, params];
};

export async function seed(db, { reset = false } = {}) {
  const count = (await db.one("SELECT COUNT(*) AS n FROM products")).n;
  if (count > 0 && !reset) return false;
  await db.tx(async (t) => {
    if (reset) {
      await t.exec("TRUNCATE order_events, order_items, orders, skus, variants, products, coupons, newsletter, admin_log, sessions, uploads RESTART IDENTITY CASCADE");
    }
    const [pSql, pParams] = multiInsert("products",
      ["slug", "name", "line", "gender", "category", "price_cents", "description", "fabric", "features", "badges", "size_guide", "position"],
      catalog.map((p, i) => [p.slug, p.name, p.line, p.gender, p.category, p.price, p.description, p.fabric, JSON.stringify(p.features), JSON.stringify(p.badges), p.sizeGuide, i]),
      "RETURNING id, slug");
    const pid = new Map((await t.all(pSql, pParams)).map((r) => [r.slug, r.id]));

    const vRows = catalog.flatMap((p) => p.variants.map((v, vi) => [pid.get(p.slug), v.color, v.slug, v.hex, JSON.stringify(imageIds(p.slug, v)), vi]));
    const [vSql, vParams] = multiInsert("variants", ["product_id", "color", "slug", "hex", "images", "position"], vRows, "RETURNING id, product_id, slug");
    const vid = new Map((await t.all(vSql, vParams)).map((r) => [`${r.product_id}/${r.slug}`, r.id]));

    const sRows = [];
    for (const p of catalog) {
      // todos os tamanhos que o produto usa aparecem em todas as cores; os que a cor não tem ficam com 0
      const allSizes = [...new Set(p.variants.flatMap((v) => v.sizes))];
      for (const v of p.variants) {
        allSizes.forEach((size, si) => sRows.push([
          vid.get(`${pid.get(p.slug)}/${v.slug}`), size, v.sizes.includes(size) ? seededQty(`${p.slug}/${v.slug}/${size}`) : 0, si,
        ]));
      }
    }
    await t.run(...multiInsert("skus", ["variant_id", "size", "qty", "position"], sRows));

    await t.run(...multiInsert("coupons", ["code", "kind", "value", "min_subtotal_cents", "max_uses", "first_purchase_only", "description"], [
      ["BEMVINDOUS", "percent", 10, 0, null, 1, "10% OFF na primeira compra"],
      ["US20", "fixed", 2000, 19900, null, 0, "R$ 20 OFF acima de R$ 199"],
      ["FIRSTCHAPTER", "percent", 15, 49900, 100, 0, "15% OFF acima de R$ 499 (Essential)"],
      ["FRETEUS", "shipping", 0, 15000, null, 0, "Frete grátis na entrega padrão acima de R$ 150"],
    ]));
  });
  return true;
}
