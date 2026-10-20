// Entrada da Vercel: toda requisição /api/* cai aqui (ver vercel.json → rewrites).
// O banco é preparado uma vez por instância (cold start) e reaproveitado nas próximas requisições.
import { createApp } from "../server/app.js";
import { bootstrap } from "../server/bootstrap.js";
import { loadConfig } from "../server/config.js";

const config = loadConfig();
let appPromise;

function getApp() {
  appPromise ??= bootstrap(config, { maxConnections: 3 })
    .then(({ db }) => createApp({ db, config }))
    .catch((err) => {
      appPromise = undefined; // próxima requisição tenta de novo
      throw err;
    });
  return appPromise;
}

export default async function handler(req, res) {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (err) {
    console.error("[boot]", err.message);
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Loja temporariamente indisponível. Tente novamente em instantes." }));
  }
}

