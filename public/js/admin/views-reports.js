import { hbars, timeChart, timeTable } from "./charts.js";
import {
  $, $$, api, brl, debounce, delta, errorToast, esc, fmtDate, frame, LINE, num, PAYMENT, qs, SHIPPING, view, waLink,
} from "./core.js";

/* =================== CLIENTES =================== */
export async function customersView() {
  frame("Clientes", `<a class="btn btn-ghost btn-sm" href="/api/admin/newsletter.csv">Exportar newsletter</a><a class="btn btn-ghost btn-sm" id="cust-csv" href="/api/admin/customers.csv">Exportar clientes</a>`);
  view().innerHTML = `
    <div class="filters"><label class="search-field"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>
      <input type="search" id="c-q" placeholder="Nome, e-mail, telefone ou CPF"></label></div>
    <div id="c-table"></div>`;
  const load = async (q = "") => {
    const list = await api(`/customers${qs({ q })}`);
    $("#cust-csv").href = `/api/admin/customers.csv${qs({ q })}`;
    $("#c-table").innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>Cliente</th><th>Contato</th><th>Cidade</th><th class="num">Pedidos</th><th class="num">Total pago</th><th>Última compra</th><th></th></tr></thead>
      <tbody>${list.length ? list.map((c) => `<tr>
        <td class="strong">${esc(c.name)}</td>
        <td>${esc(c.email)}<br><span class="muted">${esc(c.phone)}</span></td>
        <td>${esc(c.city || "—")}</td>
        <td class="num">${c.orders}</td>
        <td class="num strong">${brl(c.spent)}</td>
        <td>${fmtDate(c.lastOrder, { dateStyle: "short" })}</td>
        <td><div class="actions-row"><a class="btn btn-ghost btn-sm" href="${waLink(c.phone)}" target="_blank" rel="noopener">WhatsApp</a><a class="btn btn-ghost btn-sm" href="#/pedidos" data-cust="${esc(c.email)}">Pedidos</a></div></td>
      </tr>`).join("") : `<tr><td colspan="7" class="empty-row">${q ? "Nenhum cliente encontrado." : "Os clientes aparecem aqui depois da primeira compra."}</td></tr>`}</tbody></table></div>
      <p class="muted">${list.length} cliente(s)</p>`;
  };
  await load();
  $("#c-q").addEventListener("input", debounce((e) => load(e.target.value).catch(errorToast), 300));
  view().addEventListener("click", (e) => {
    const a = e.target.closest("[data-cust]");
    if (a) { e.preventDefault(); sessionStorage.setItem("us.ordersQ", a.dataset.cust); location.hash = "#/pedidos"; }
  });
}

/* =================== RELATÓRIOS =================== */
const todayBR = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const range = { preset: "30", from: "", to: "" };
const br = (d) => d.split("-").reverse().join("/");

function presetRange(p) {
  const t = todayBR();
  if (p === "7") return { from: addDays(t, -6), to: t };
  if (p === "30") return { from: addDays(t, -29), to: t };
  if (p === "90") return { from: addDays(t, -89), to: t };
  if (p === "mes") return { from: `${t.slice(0, 8)}01`, to: t };
  if (p === "ano") return { from: `${t.slice(0, 4)}-01-01`, to: t };
  return { from: range.from, to: range.to };
}

export async function reportsView() {
  frame("Relatórios", `<a class="btn btn-ghost btn-sm" id="rep-csv" href="#">Exportar vendas por dia</a>`);
  if (!range.from) Object.assign(range, presetRange(range.preset));
  view().innerHTML = `
    <div class="filters">
      <div class="seg" id="rep-seg">${[["7", "7 dias"], ["30", "30 dias"], ["90", "90 dias"], ["mes", "Este mês"], ["ano", "Este ano"], ["custom", "Período"]]
        .map(([k, l]) => `<button type="button" data-p="${k}" aria-pressed="${range.preset === k}">${l}</button>`).join("")}</div>
      <label class="muted">De <input type="date" id="rep-from" value="${range.from}"></label>
      <label class="muted">até <input type="date" id="rep-to" value="${range.to}"></label>
    </div>
    <div id="rep-body"></div>`;
  const load = async () => {
    $$("#rep-seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.p === range.preset)));
    $("#rep-from").value = range.from;
    $("#rep-to").value = range.to;
    $("#rep-csv").href = `/api/admin/reports.csv${qs({ from: range.from, to: range.to })}`;
    $("#rep-body").innerHTML = `<div class="card-box skeleton" style="aspect-ratio:auto;height:320px"></div>`;
    renderReport(await api(`/reports${qs({ from: range.from, to: range.to })}`));
  };
  $("#rep-seg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-p]");
    if (!b) return;
    range.preset = b.dataset.p;
    if (b.dataset.p !== "custom") Object.assign(range, presetRange(b.dataset.p));
    load().catch(errorToast);
  });
  const custom = () => {
    range.preset = "custom";
    range.from = $("#rep-from").value;
    range.to = $("#rep-to").value;
    if (range.from && range.to) load().catch(errorToast);
  };
  $("#rep-from").addEventListener("change", custom);
  $("#rep-to").addEventListener("change", custom);
  await load();
}

function renderReport(r) {
  const t = r.totals;
  const revLines = r.byLine.reduce((s, x) => s + x.revenue, 0);
  const share = (v) => (revLines ? ` · ${Math.round((v / revLines) * 100)}%` : "");
  $("#rep-body").innerHTML = `
    <p class="muted">${br(r.range.from)} a ${br(r.range.to)} (${r.range.days} dias), comparado com os ${r.range.days} dias anteriores. Considera só pedidos pagos.</p>
    <div class="kpis">
      <div class="kpi"><span class="kpi-label">Faturamento</span><span class="kpi-value">${brl(t.revenueCents)}</span><span class="kpi-sub">${delta(r.change.revenue)} antes ${brl(r.previous.revenueCents)}</span></div>
      <div class="kpi"><span class="kpi-label">Pedidos pagos</span><span class="kpi-value">${num(t.orders)}</span><span class="kpi-sub">${delta(r.change.orders)} antes ${num(r.previous.orders)}</span></div>
      <div class="kpi"><span class="kpi-label">Ticket médio</span><span class="kpi-value">${brl(t.avgTicketCents)}</span><span class="kpi-sub">${delta(r.change.avgTicket)}</span></div>
      <div class="kpi"><span class="kpi-label">Peças vendidas</span><span class="kpi-value">${num(t.itemsSold)}</span><span class="kpi-sub">${delta(r.change.itemsSold)}</span></div>
      <div class="kpi"><span class="kpi-label">Pedidos que foram pagos</span><span class="kpi-value">${Math.round(t.paymentRate * 100)}%</span><span class="kpi-sub">${t.ordersCreated} criados, ${t.pending.count} aguardando, ${t.cancelled.count} cancelados</span></div>
      <div class="kpi"><span class="kpi-label">Descontos concedidos</span><span class="kpi-value">${brl(t.discountsCents)}</span><span class="kpi-sub">frete cobrado ${brl(t.shippingCents)}</span></div>
    </div>
    <section class="card-box"><div class="box-head"><h2>Faturamento por dia</h2><button class="linklike chart-toggle" id="toggle-table">Ver como tabela</button></div><div id="rep-chart"></div></section>
    <div class="grid-2">
      <section class="card-box"><div class="box-head"><h2>Produtos mais vendidos</h2><span class="muted">peças e faturamento</span></div>
        ${hbars(r.topProducts.map((p) => ({ label: p.name, value: p.qty, display: `${p.qty} · ${brl(p.revenue)}` })))}</section>
      <section class="card-box"><div class="box-head"><h2>Cor e tamanho campeões</h2></div>
        ${hbars(r.topVariants.map((p) => ({ label: `${p.name}, ${p.color} ${p.size}`, value: p.qty, display: `${p.qty} un.` })))}</section>
    </div>
    <div class="grid-3">
      <section class="card-box"><div class="box-head"><h2>Por linha</h2></div>
        ${hbars(r.byLine.map((x) => ({ label: LINE[x.key] || x.key, value: x.revenue, display: `${brl(x.revenue)}${share(x.revenue)}` })))}</section>
      <section class="card-box"><div class="box-head"><h2>Por categoria</h2></div>
        ${hbars(r.byCategory.map((x) => ({ label: x.label, value: x.revenue, display: brl(x.revenue) })))}</section>
      <section class="card-box"><div class="box-head"><h2>Tamanhos vendidos</h2></div>
        ${hbars(r.bySize.map((x) => ({ label: x.key, value: x.qty, display: `${x.qty} un.` })))}</section>
      <section class="card-box"><div class="box-head"><h2>Formas de pagamento</h2></div>
        ${hbars(r.payments.map((x) => ({ label: PAYMENT[x.key] || x.key, value: x.revenue, display: `${x.orders} · ${brl(x.revenue)}` })))}</section>
      <section class="card-box"><div class="box-head"><h2>Estados</h2></div>
        ${hbars(r.byState.slice(0, 10).map((x) => ({ label: x.key || "—", value: x.revenue, display: `${x.orders} · ${brl(x.revenue)}` })))}</section>
      <section class="card-box"><div class="box-head"><h2>Entrega escolhida</h2></div>
        ${hbars(r.shippingMethods.map((x) => ({ label: SHIPPING[x.key] || x.key, value: x.orders, display: `${x.orders} pedido(s)` })))}</section>
    </div>
    <section class="card-box"><div class="box-head"><h2>Desempenho dos cupons</h2></div>
      ${r.coupons.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Cupom</th><th class="num">Pedidos</th><th class="num">Desconto dado</th><th class="num">Faturamento gerado</th></tr></thead>
        <tbody>${r.coupons.map((c) => `<tr><td class="strong">${esc(c.code)}</td><td class="num">${c.orders}</td><td class="num">${brl(c.discount)}</td><td class="num">${brl(c.revenue)}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="muted">Nenhum pedido pago usou cupom neste período.</p>`}
    </section>`;
  const chartEl = $("#rep-chart");
  let asTable = false;
  timeChart(chartEl, r.daily);
  $("#toggle-table").addEventListener("click", (e) => {
    asTable = !asTable;
    e.target.textContent = asTable ? "Ver como gráfico" : "Ver como tabela";
    if (asTable) chartEl.innerHTML = timeTable(r.daily);
    else timeChart(chartEl, r.daily);
  });
}
