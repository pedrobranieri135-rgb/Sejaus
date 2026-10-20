import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { bootstrap } from "./bootstrap.js";
import { expireStaleOrders } from "./services/checkout.js";
import { effectiveConfig } from "./services/settings.js";

const config = loadConfig();
let db, boot;
try {
  const r = await bootstrap(config);
  ({ db, admin: boot } = r);
  if (r.seeded) console.log("✓ Catálogo importado no banco");
} catch (err) {
  console.error("✖ Não foi possível preparar o banco:", err.message);
  process.exit(1);
}

const sweep = async () => {
  try {
    const n = await expireStaleOrders(db, (await effectiveConfig(db, config)).orderTtlHours);
    if (n) console.log(`↺ ${n} pedido(s) expirado(s) — estoque devolvido`);
  } catch (err) {
    console.error("[expiração]", err.message);
  }
};
sweep();
const timer = setInterval(sweep, 10 * 60_000);
timer.unref();

const server = createApp({ db, config }).listen(config.port, () => {
  console.log(`\n  SEJA US  →  http://localhost:${config.port}`);
  console.log(`  Admin    →  http://localhost:${config.port}/admin`);
  console.log(`  Banco    →  Postgres (schema "${config.dbSchema}")${config.storage.secretKey ? " · fotos no Supabase Storage" : ""}`);
  if (boot) {
    console.log(`  Usuário admin criado: ${boot.email}${boot.generated ? `  senha: ${boot.password}  (troque em Configurações)` : "  (senha definida no .env)"}\n`);
  }
});

const shutdown = () => {
  server.close(async () => { await db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
