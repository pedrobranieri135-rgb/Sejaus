import { $, $$, api, closePanel, errorToast, esc, state, toast } from "./core.js";
import { couponsView } from "./views-coupons.js";
import { dashboardView, openOrder, ordersView, refreshBadges } from "./views-orders.js";
import { productEditView, productsView, stockView } from "./views-products.js";
import { customersView, reportsView } from "./views-reports.js";
import { settingsView } from "./views-settings.js";

const routes = {
  painel: () => dashboardView(),
  pedidos: (p, rest) => ordersView({ ...p, code: rest[0] }),
  produtos: (p, rest) => (rest[0] ? productEditView({ id: rest[0] }) : productsView()),
  estoque: (p) => stockView(p),
  cupons: () => couponsView(),
  clientes: () => customersView(),
  relatorios: () => reportsView(),
  config: () => settingsView(),
};

let lastSection = null;

// Navegação em fila: uma tela só começa depois que a anterior terminou de carregar.
// Sem isso, uma tela lenta (ex.: Painel) podia terminar de desenhar por cima da tela seguinte.
let routing = Promise.resolve();
function route() {
  routing = routing.then(renderRoute, renderRoute);
  return routing;
}

async function renderRoute() {
  if (!state.me) return;
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [section = "painel", ...rest] = path.split("/").filter(Boolean);
  const params = Object.fromEntries(new URLSearchParams(query));
  const handler = routes[section];
  if (!handler) { location.hash = "#/painel"; return; }

  // pedido aberto por cima da lista: não recarrega a lista se já estamos nela
  if (section === "pedidos" && lastSection === "pedidos" && rest[0] && $("#orders-table")) { openOrder(rest[0]); return; }
  if (section === "pedidos" && lastSection === "pedidos" && !rest[0] && !query && $("#orders-table")) { closePanel(); return; }
  closePanel();

  // cada tela ganha um <main> novo: listeners da tela anterior não se acumulam
  const old = $("#view");
  const fresh = old.cloneNode(false);
  old.replaceWith(fresh);
  lastSection = section;
  $$("[data-nav]").forEach((a) => (a.dataset.nav === section ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  $("#sidebar").classList.remove("open");
  $("#menu-btn").setAttribute("aria-expanded", "false");
  window.scrollTo(0, 0);

  if (section === "pedidos") {
    const q = sessionStorage.getItem("us.ordersQ");
    if (q) { sessionStorage.removeItem("us.ordersQ"); params.q = q; }
  }
  try {
    await handler(params, rest);
  } catch (err) {
    errorToast(err);
    if (err.status !== 401) fresh.innerHTML = `<div class="card-box"><h2>Não foi possível abrir esta tela</h2><p class="muted">${esc(err.message)}</p><a class="btn btn-dark btn-sm" href="/admin">Tentar de novo</a></div>`;
  }
}

function showLogin(message) {
  state.me = null;
  closePanel();
  $("#app").hidden = true;
  $("#login-screen").hidden = false;
  const err = $("#login-error");
  err.hidden = !message;
  err.textContent = message || "";
  setTimeout(() => $("#login-form").email.focus(), 50);
}

async function enter(admin) {
  state.me = admin;
  state.meta = await api("/meta");
  $("#user-name").textContent = admin.name;
  $("#user-email").textContent = admin.email;
  $("#login-screen").hidden = true;
  $("#app").hidden = false;
  lastSection = null;
  if (!location.hash || location.hash === "#") location.hash = "#/painel";
  await route();
  refreshBadges();
}

state.onUnauthorized = () => { if (state.me) showLogin("Sua sessão expirou. Entre novamente."); };

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = $("button[type=submit]", f);
  btn.disabled = true;
  try {
    const r = await api("/login", { method: "POST", body: { email: f.email.value.trim(), password: f.password.value } });
    f.password.value = "";
    await enter(r.admin);
  } catch (err) {
    showLogin(err.status === 401 ? "E-mail ou senha incorretos." : err.status === 429 ? "Muitas tentativas. Aguarde alguns minutos." : err.message);
  } finally { btn.disabled = false; }
});

$("#logout").addEventListener("click", async () => {
  try { await api("/logout", { method: "POST", body: {} }); } catch { /* sessão já expirada */ }
  showLogin();
  toast("Você saiu do painel");
});

$("#menu-btn").addEventListener("click", () => {
  const open = $("#sidebar").classList.toggle("open");
  $("#menu-btn").setAttribute("aria-expanded", String(open));
});

// painel lateral: fechar pelo fundo, Esc ou botão — e voltar a URL para a lista
const closeOrderPanel = () => {
  closePanel();
  if (/^#\/pedidos\/.+/.test(location.hash)) history.replaceState(null, "", "#/pedidos");
};
$("#panel-backdrop").addEventListener("click", closeOrderPanel);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#side-panel").classList.contains("open") && !$("#admin-modal").open) closeOrderPanel();
});
document.addEventListener("click", (e) => {
  if (e.target.closest("#side-panel [data-panel-close]")) closeOrderPanel();
  if (e.target.closest("#admin-modal [data-close]")) $("#admin-modal").close();
  if (e.target.matches("dialog#admin-modal")) e.target.close();
});
document.addEventListener("orders:changed", () => {
  // atualiza a lista atrás do painel sem fechá-lo
  if (lastSection === "pedidos" && $("#orders-table")) $("#orders-q")?.dispatchEvent(new Event("input"));
});

addEventListener("hashchange", route);

// sessão existente?
api("/me").then((r) => enter(r.admin)).catch(() => showLogin());
