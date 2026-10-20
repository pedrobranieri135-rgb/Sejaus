import { connect, migrate, seed } from "./db.js";
import { configureImages } from "./lib/images.js";
import { ensureBootstrapAdmin } from "./services/auth.js";

/** Prepara banco, fotos e usuário inicial. Usado no servidor local (index.js) e na Vercel (api/index.js). */
export async function bootstrap(config, { maxConnections = 10 } = {}) {
  configureImages({ supabaseUrl: config.storage.secretKey ? config.storage.url : null, bucket: config.storage.bucket });
  const db = connect({ databaseUrl: config.databaseUrl, schema: config.dbSchema, caCert: config.dbCaCert, max: maxConnections });
  await migrate(db);
  const seeded = await seed(db);
  const admin = await ensureBootstrapAdmin(db, config);
  return { db, seeded, admin };
}
