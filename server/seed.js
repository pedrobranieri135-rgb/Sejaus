import { loadConfig } from "./config.js";
import { connect, migrate, seed } from "./db.js";

const config = loadConfig();
const db = connect({ databaseUrl: config.databaseUrl, schema: config.dbSchema, caCert: config.dbCaCert });
await migrate(db);
const reset = process.argv.includes("--reset");
console.log((await seed(db, { reset })) ? "✓ Catálogo importado (pedidos, clientes e histórico zerados)" : "Banco já possui produtos (use --reset para recriar)");
await db.close();
