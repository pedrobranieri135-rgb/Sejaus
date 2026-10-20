import crypto from "node:crypto";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { connect, migrate, seed } from "../server/db.js";
import { configureImages } from "../server/lib/images.js";

export const hasDatabase = !!process.env.DATABASE_URL;
export const skipReason = "Defina DATABASE_URL no .env para rodar os testes contra o Postgres";

/**
 * Sobe a loja num schema temporário e exclusivo (t_<aleatório>) do mesmo Postgres.
 * Os dados reais da loja (schema "loja") nunca são tocados; o schema é apagado no fim.
 */
export async function startTestStore(overrides = {}) {
  const schema = `t_${crypto.randomBytes(5).toString("hex")}`;
  const config = loadConfig({ dbSchema: schema, rateLimit: false, env: "test", adminToken: null, ...overrides });
  configureImages({ supabaseUrl: config.storage?.secretKey ? config.storage.url : null, bucket: config.storage?.bucket });
  const db = connect({ databaseUrl: config.databaseUrl, schema, caCert: config.dbCaCert, max: 6 });
  await migrate(db);
  await seed(db);
  const server = createApp({ db, config }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = async () => {
    await new Promise((r) => server.close(r));
    await db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  };
  return { db, config, server, base, schema, stop };
}
