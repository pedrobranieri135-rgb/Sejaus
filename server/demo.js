// Gera pedidos de DEMONSTRAÇÃO (e-mails @exemplo.com) nos últimos 30 dias para visualizar painel e relatórios.
// Passa pelo checkout real (estoque, cupons, frete). Para limpar tudo: npm run seed
import { loadConfig } from "./config.js";
import { connect, migrate, seed } from "./db.js";
import { configureImages } from "./lib/images.js";
import { createOrder, updateOrderStatus } from "./services/checkout.js";
import { effectiveConfig } from "./services/settings.js";

const config = loadConfig();
configureImages({ supabaseUrl: config.storage.secretKey ? config.storage.url : null, bucket: config.storage.bucket });
const db = connect({ databaseUrl: config.databaseUrl, schema: config.dbSchema, caCert: config.dbCaCert });
await migrate(db);
await seed(db);
const cfg = await effectiveConfig(db, config);

let s = 42;
const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const people = [
  ["Ana Ribeiro", "MS", "79002000", "Campo Grande"], ["Bruno Lima", "SP", "01310100", "São Paulo"], ["Carla Mendes", "RJ", "22041001", "Rio de Janeiro"],
  ["Diego Alves", "MS", "79826000", "Dourados"], ["Eduarda Costa", "PR", "80010000", "Curitiba"], ["Felipe Rocha", "MG", "30130000", "Belo Horizonte"],
  ["Gabriela Souza", "SP", "13010000", "Campinas"], ["Henrique Dias", "GO", "74003010", "Goiânia"], ["Isabela Martins", "MS", "79002000", "Campo Grande"],
  ["João Pedro Nunes", "SC", "88010000", "Florianópolis"], ["Larissa Prado", "MT", "78005000", "Cuiabá"], ["Marina Teles", "DF", "70040010", "Brasília"],
];
// CPFs válidos de teste
const cpfs = ["52998224725", "11144477735", "39053344705", "15350946056", "71428793860", "85258473093", "16899535009", "38591452001", "65278398010", "29537941049", "07368614086", "60286328070"];

const skus = await db.all(`SELECT s.id FROM skus s JOIN variants v ON v.id = s.variant_id JOIN products p ON p.id = v.product_id
  WHERE p.active = 1 AND s.qty >= 2`);
const statusFlow = ["aguardando_pagamento", "pago", "em_separacao", "enviado", "entregue"];

let made = 0;
for (let i = 0; i < 32; i++) {
  const pi = Math.floor(rnd() * people.length);
  const [name, state, cep, city] = people[pi];
  const items = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(skus).id))].map((sku) => ({ sku, qty: 1 }));
  const daysAgo = Math.floor(rnd() * 30);
  try {
    const { order } = await createOrder(db, cfg, {
      items,
      customer: { name, email: `${name.split(" ")[0].toLowerCase()}@exemplo.com`, phone: `67998${String(100000 + pi * 7919).slice(0, 6)}`, cpf: cpfs[pi] },
      address: { cep, street: "Rua Exemplo", number: String(10 + i), complement: "", district: "Centro", city, state },
      shipping: rnd() < 0.75 ? "padrao" : "expresso",
      payment: pick(["pix", "pix", "pix", "cartao", "whatsapp"]),
      coupon: rnd() < 0.25 ? pick(["US20", "FRETEUS"]) : undefined,
    });
    // avança o status conforme a idade do pedido
    const target = daysAgo > 7 ? (rnd() < 0.1 ? "cancelado" : "entregue") : daysAgo > 3 ? pick(["enviado", "entregue"]) : pick(statusFlow.slice(0, 4));
    if (target === "cancelado") await updateOrderStatus(db, cfg, order.code, "cancelado", "Demonstração");
    else for (const st of statusFlow.slice(1, statusFlow.indexOf(target) + 1)) await updateOrderStatus(db, cfg, order.code, st);
    if (["enviado", "entregue"].includes(target)) {
      await db.run("UPDATE orders SET tracking_code = ?, carrier = 'correios' WHERE code = ?", [`QB${String(100000000 + i * 7331).slice(0, 9)}BR`, order.code]);
    }
    // data retroativa (pedido e histórico)
    const at = new Date(Date.now() - daysAgo * 86400_000 - Math.floor(rnd() * 10) * 3600_000);
    const { id } = await db.one("SELECT id FROM orders WHERE code = ?", [order.code]);
    await db.run("UPDATE orders SET created_at = ? WHERE id = ?", [at.toISOString(), id]);
    const events = await db.all("SELECT id FROM order_events WHERE order_id = ? ORDER BY id", [id]);
    for (const [k, e] of events.entries()) {
      await db.run("UPDATE order_events SET at = ? WHERE id = ?", [new Date(at.getTime() + k * 26 * 3600_000).toISOString(), e.id]);
    }
    made++;
  } catch (err) {
    if (err.status !== 400 && err.status !== 409) throw err; // cupom/estoque recusado: segue
  }
}
console.log(`✓ ${made} pedidos de demonstração criados (e-mails @exemplo.com). Para limpar: npm run seed`);
await db.close();
