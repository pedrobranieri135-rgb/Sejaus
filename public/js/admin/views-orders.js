import { hbars, timeChart } from "./charts.js";
import {
  $, $$, api, brl, closeBtn, closePanel, confirmBox, delta, errorToast, esc, fmtDate, frame, LINE, loading, NEXT, num,
  openPanel, panelBody, PAYMENT, pill, qs, SHIPPING, STATUS, state, toast, view, waLink, debounce,
} from "./core.js";

/* =================== PAINEL =================== */
export async function dashboardView() {
  frame("Painel", `<a class="btn btn-dark btn-sm" href="#/produtos/novo">Novo produto</a>`);
  loading();
  const d = await api("/dashboard");
  view().innerHTML = `
    <div class="kpis">
      <div class="kpi"><span class="kpi-label">Vendas hoje</span><span class="kpi-value">${brl(d.today.revenueCents)}</span><span class="kpi-sub">${d.today.orders} ${d.today.orders === 1 ? "pedido pago" : "pedidos pagos"}</span></div>
      <div class="kpi"><span class="kpi-label">Últimos 7 dias</span><span class="kpi-value">${brl(d.week.totals.revenueCents)}</span><span class="kpi-sub">${delta(d.week.change.revenue)} vs 7 dias anteriores</span></div>
      <div class="kpi"><span class="kpi-label">Ticket médio (7 dias)</span><span class="kpi-value">${brl(d.week.totals.avgTicketCents)}</span><span class="kpi-sub">${num(d.week.totals.itemsSold)} peças vendidas</span></div>
      <a class="kpi" href="#/pedidos?status=aguardando_pagamento"><span class="kpi-label">Aguardando pagamento</span><span class="kpi-value">${d.awaiting.count}</span><span class="kpi-sub">${brl(d.awaiting.valueCents)} em aberto</span></a>
      <a class="kpi" href="#/pedidos?status=pago"><span class="kpi-label">Para separar e enviar</span><span class="kpi-value">${d.toShip}</span><span class="kpi-sub">pagos ou em separação</span></a>
    </div>
    <div class="grid-main">
      <section class="card-box"><div class="box-head"><h2>Faturamento — últimos 7 dias</h2><a class="muted" href="#/relatorios">Ver relatórios</a></div><div id="dash-chart"></div></section>
      <section class="card-box"><div class="box-head"><h2>Mais vendidos (7 dias)</h2></div>
        ${hbars(d.week.topProducts.map((p) => ({ label: p.name, value: p.qty, display: `${p.qty} un.` })), { empty: "Nenhuma venda paga nos últimos 7 dias." })}
      </section>
    </div>
    <div class="grid-2">
      <section class="card-box"><div class="box-head"><h2>Pedidos recentes</h2><a class="muted" href="#/pedidos">Ver todos</a></div>
        ${d.recent.length ? `<ul class="alert-list">${d.recent.map((o) => `<li><a href="#/pedidos/${esc(o.code)}"><b>${esc(o.code)}</b> ${esc(o.name)}</a><span>${pill(o.status)} <b>${brl(o.total)}</b></span></li>`).join("")}</ul>` : `<p class="muted">Os pedidos da loja aparecem aqui.</p>`}
      </section>
      <section class="card-box"><div class="box-head"><h2>Alertas de estoque</h2><a class="muted" href="#/estoque?f=low">Abrir estoque</a></div>
        ${d.lowStock.length ? `<ul class="alert-list">${d.lowStock.map((s) => `<li><a href="#/produtos/${s.productId}">${esc(s.name)} <span class="muted">${esc(s.color)} / ${esc(s.size)}</span></a>${s.qty === 0 ? pill("zero", "Esgotou") : pill("low", `${s.qty} un.`)}</li>`).join("")}</ul>` : `<p class="muted">Nenhum tamanho com estoque baixo.</p>`}
      </section>
    </div>
    <div class="kpis">
      <a class="kpi" href="#/produtos"><span class="kpi-label">Produtos ativos</span><span class="kpi-value">${d.counts.products}</span></a>
      <a class="kpi" href="#/estoque?f=low"><span class="kpi-label">Tamanhos com estoque baixo</span><span class="kpi-value">${d.counts.lowStock}</span></a>
      <a class="kpi" href="#/clientes"><span class="kpi-label">Inscritos na newsletter</span><span class="kpi-value">${d.counts.newsletter}</span></a>
    </div>`;
  timeChart($("#dash-chart"), d.week.daily, { height: 220 });
}

/* =================== PEDIDOS =================== */
const ordersState = { status: "", q: "", from: "", to: "", page: 1 };

export async function ordersView(params) {
  if (params.status != null) ordersState.status = params.status;
  if (params.q != null) { ordersState.q = params.q; ordersState.page = 1; }
  frame("Pedidos", `<a class="btn btn-ghost btn-sm" id="export-orders" href="#">Exportar CSV</a>`);
  view().innerHTML = `
    <div class="filters">
      <div class="seg" id="status-seg" role="group" aria-label="Filtrar por status"></div>
    </div>
    <div class="filters">
      <label class="search-field"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>
        <input type="search" id="orders-q" placeholder="Código, nome, e-mail, CPF, telefone ou rastreio" value="${esc(ordersState.q)}"></label>
      <label class="muted">De <input type="date" id="orders-from" value="${esc(ordersState.from)}"></label>
      <label class="muted">até <input type="date" id="orders-to" value="${esc(ordersState.to)}"></label>
    </div>
    <div id="orders-table"></div>`;
  const load = async () => {
    const data = await api(`/orders${qs(ordersState)}`);
    renderSeg(data.counts);
    renderTable(data);
    $("#export-orders").href = `/api/admin/orders.csv${qs({ ...ordersState, page: "" })}`;
  };
  const reload = () => { ordersState.page = 1; load().catch(errorToast); };
  $("#orders-q").addEventListener("input", debounce((e) => { ordersState.q = e.target.value; reload(); }, 300));
  $("#orders-from").addEventListener("change", (e) => { ordersState.from = e.target.value; reload(); });
  $("#orders-to").addEventListener("change", (e) => { ordersState.to = e.target.value; reload(); });
  $("#status-seg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-status]");
    if (b) { ordersState.status = b.dataset.status; reload(); }
  });
  view().addEventListener("click", (e) => {
    const row = e.target.closest("[data-order]");
    if (row && !e.target.closest("a")) location.hash = `#/pedidos/${row.dataset.order}`;
    const pg = e.target.closest("[data-page]");
    if (pg) { ordersState.page = Number(pg.dataset.page); load().catch(errorToast); }
  });
  view().addEventListener("keydown", (e) => {
    const row = e.target.closest("[data-order]");
    if (row && e.key === "Enter") location.hash = `#/pedidos/${row.dataset.order}`;
  });
  await load();
  if (params.code) openOrder(params.code);
}

function renderSeg(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const opts = [["", "Todos", total], ...Object.keys(STATUS).map((k) => [k, STATUS[k], counts[k] || 0])];
  $("#status-seg").innerHTML = opts.map(([k, l, n]) =>
    `<button type="button" data-status="${k}" aria-pressed="${ordersState.status === k}">${esc(l)} <span class="count">${n}</span></button>`).join("");
}

function renderTable(data) {
  $("#orders-table").innerHTML = `
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Pedido</th><th>Data</th><th>Cliente</th><th>Status</th><th>Pagamento</th><th>Entrega</th><th class="num">Itens</th><th class="num">Total</th></tr></thead>
      <tbody>${data.orders.length ? data.orders.map((o) => `
        <tr class="clickable" data-order="${esc(o.code)}" tabindex="0">
          <td class="strong">${esc(o.code)}${o.coupon ? `<br><span class="muted">${esc(o.coupon)}</span>` : ""}</td>
          <td>${fmtDate(o.createdAt)}</td>
          <td>${esc(o.name)}<br><span class="muted">${esc(o.city)}</span></td>
          <td>${pill(o.status)}</td>
          <td>${esc(PAYMENT[o.payment] || o.payment)}</td>
          <td>${esc(SHIPPING[o.shipping] || o.shipping)}${o.tracking ? `<br><span class="muted">${esc(o.tracking)}</span>` : ""}</td>
          <td class="num">${o.items}</td>
          <td class="num strong">${brl(o.totalCents)}</td>
        </tr>`).join("") : `<tr><td colspan="8" class="empty-row">Nenhum pedido encontrado com esses filtros.</td></tr>`}</tbody>
    </table></div>
    ${data.pages > 1 ? `<div class="pager"><span class="muted">${data.total} pedidos · página ${data.page} de ${data.pages}</span>
      <button class="btn btn-ghost btn-sm" data-page="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""}>Anterior</button>
      <button class="btn btn-ghost btn-sm" data-page="${data.page + 1}" ${data.page >= data.pages ? "disabled" : ""}>Próxima</button></div>` : ""}`;
}

/* ---------- detalhe do pedido ---------- */
let current = null;

export async function openOrder(code) {
  try {
    current = await api(`/orders/${encodeURIComponent(code)}`);
    renderOrder();
  } catch (err) {
    errorToast(err);
    location.hash = "#/pedidos";
  }
}

function renderOrder() {
  const o = current;
  const a = o.address;
  const carriers = state.meta?.carriers || {};
  const flow = ["aguardando_pagamento", "pago", "em_separacao", "enviado", "entregue"];
  const at = new Map(o.timeline.map((e) => [e.status, e]));
  const canTrack = ["pago", "em_separacao", "enviado"].includes(o.status);
  openPanel(`
    <div class="panel-head"><h2>${esc(o.code)}</h2>${pill(o.status)}${closeBtn()}</div>
    <p class="muted">Feito em ${fmtDate(o.createdAt)} · ${o.previousOrders ? `cliente com ${o.previousOrders} pedido(s) anterior(es)` : "primeira compra do cliente"}</p>

    ${NEXT[o.status].length ? `<section class="card-box"><div class="box-head"><h2>Próximo passo</h2></div>
      ${o.status === "em_separacao" ? `<p class="muted" style="margin-bottom:10px">Informe o código de rastreio ao marcar como enviado. O cliente vê o código e o link na página "Meu pedido".</p>
        <div class="inline-fields" style="margin-bottom:10px"><input id="ship-code" placeholder="Código de rastreio (ex.: QB123456789BR)" value="${esc(o.tracking?.code || "")}">
          <select id="ship-carrier">${Object.entries(carriers).map(([k, l]) => `<option value="${k}" ${o.tracking?.carrier === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>` : ""}
      <div class="actions-row">${NEXT[o.status].map((n) => `<button class="btn ${n === "cancelado" ? "btn-ghost" : "btn-dark"} btn-sm" data-to="${n}">${n === "cancelado" ? "Cancelar pedido" : `Marcar como ${esc(STATUS[n].toLowerCase())}`}</button>`).join("")}</div>
    </section>` : ""}

    <section class="card-box"><div class="box-head"><h2>Itens</h2><button class="btn btn-ghost btn-sm" data-print>Imprimir guia de separação</button></div>
      ${o.items.map((i) => `<div class="item-line"><img src="${esc(i.image)}" alt=""><span><b>${i.qty}x ${esc(i.name)}</b><br><span class="muted">${esc(i.color)} / ${esc(i.size)} · ${brl(i.unitPriceCents)}</span></span><b>${brl(i.lineTotalCents)}</b></div>`).join("")}
      <dl class="kv" style="margin-top:12px">
        <dt>Subtotal</dt><dd>${brl(o.subtotalCents)}</dd>
        ${o.discountCents ? `<dt>Desconto</dt><dd>− ${brl(o.discountCents)} (${esc(o.couponCode)})</dd>` : o.couponCode ? `<dt>Cupom</dt><dd>${esc(o.couponCode)}</dd>` : ""}
        <dt>Frete</dt><dd>${o.shippingCents ? brl(o.shippingCents) : "Grátis"} · ${esc(SHIPPING[o.shippingMethod] || o.shippingMethod)}</dd>
        <dt><b>Total</b></dt><dd><b>${brl(o.totalCents)}</b> · ${esc(PAYMENT[o.paymentMethod] || o.paymentMethod)}</dd>
      </dl>
    </section>

    <section class="card-box"><div class="box-head"><h2>Cliente e entrega</h2><a class="btn btn-ghost btn-sm" href="${waLink(o.customer.phone)}" target="_blank" rel="noopener">WhatsApp do cliente</a></div>
      <dl class="kv">
        <dt>Nome</dt><dd>${esc(o.customer.name)}</dd>
        <dt>E-mail</dt><dd>${esc(o.customer.email)}</dd>
        <dt>Telefone</dt><dd>${esc(o.customer.phone)}</dd>
        <dt>CPF</dt><dd>${esc(o.customer.cpf)}</dd>
        <dt>Endereço</dt><dd>${esc(a.street)}, ${esc(a.number)}${a.complement ? ` — ${esc(a.complement)}` : ""}<br>${esc(a.district)} · ${esc(a.city)}/${esc(a.state)} · CEP ${esc(a.cep)}</dd>
      </dl>
      <button class="linklike" data-copy-address style="margin-top:10px">Copiar endereço</button>
    </section>

    ${canTrack || o.tracking ? `<section class="card-box"><div class="box-head"><h2>Rastreio</h2>${o.tracking ? `<a class="muted" href="${esc(o.tracking.url)}" target="_blank" rel="noopener">Abrir rastreio</a>` : ""}</div>
      <form class="inline-fields" id="tracking-form"><input name="trackingCode" placeholder="Código de rastreio" value="${esc(o.tracking?.code || "")}" aria-label="Código de rastreio">
        <select name="carrier" aria-label="Transportadora">${Object.entries(carriers).map(([k, l]) => `<option value="${k}" ${o.tracking?.carrier === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <button class="btn btn-dark btn-sm" type="submit" style="grid-column:1/-1;justify-self:start">Salvar rastreio</button></form>
    </section>` : ""}

    <section class="card-box"><div class="box-head"><h2>Histórico</h2></div>
      <ul class="timeline">${(o.status === "cancelado" ? o.timeline.map((e) => e.status) : flow).map((s) => {
        const e = at.get(s);
        return `<li class="${e ? "" : "todo"}">${esc(STATUS[s])}${e?.note ? ` <span class="muted">— ${esc(e.note)}</span>` : ""}${e ? `<time>${fmtDate(e.at)}</time>` : ""}</li>`;
      }).join("")}</ul>
    </section>

    <section class="card-box"><div class="box-head"><h2>Nota interna</h2><span class="muted">só a equipe vê</span></div>
      <form id="note-form" class="field" style="gap:10px"><textarea name="note" maxlength="1000" placeholder="Ex.: cliente pediu para embalar para presente">${esc(o.internalNote)}</textarea>
      <button class="btn btn-ghost btn-sm" type="submit" style="justify-self:start">Salvar nota</button></form>
    </section>`);
  bindOrderPanel();
}

function printSlip(o) {
  const a = o.address;
  $("#print-area").innerHTML = `
    <h1>SEJA US — Guia de separação</h1>
    <p><b>Pedido ${esc(o.code)}</b> · ${fmtDate(o.createdAt)} · Entrega ${esc(SHIPPING[o.shippingMethod] || "")}</p>
    <table><thead><tr><th>Qtd.</th><th>Produto</th><th>Cor</th><th>Tamanho</th><th>OK</th></tr></thead>
      <tbody>${o.items.map((i) => `<tr><td>${i.qty}</td><td>${esc(i.name)}</td><td>${esc(i.color)}</td><td>${esc(i.size)}</td><td>☐</td></tr>`).join("")}</tbody></table>
    <div class="box"><b>Destinatário</b><br>${esc(o.customer.name)}<br>${esc(a.street)}, ${esc(a.number)}${a.complement ? ` — ${esc(a.complement)}` : ""}<br>${esc(a.district)} — ${esc(a.city)}/${esc(a.state)}<br>CEP ${esc(a.cep)}<br>Tel. ${esc(o.customer.phone)}</div>
    ${o.internalNote ? `<div class="box"><b>Observações</b><br>${esc(o.internalNote)}</div>` : ""}`;
  window.print();
}

function bindOrderPanel() {
  const body = panelBody();
  body.onclick = async (e) => {
    if (e.target.closest("[data-panel-close]")) { closePanel(); return; }
    if (e.target.closest("[data-print]")) return printSlip(current);
    if (e.target.closest("[data-copy-address]")) {
      const a = current.address;
      const text = `${current.customer.name}\n${a.street}, ${a.number}${a.complement ? ` - ${a.complement}` : ""}\n${a.district} - ${a.city}/${a.state}\nCEP ${a.cep}`;
      try { await navigator.clipboard.writeText(text); toast("Endereço copiado"); } catch { toast("Não foi possível copiar", { type: "bad" }); }
      return;
    }
    const to = e.target.closest("[data-to]");
    if (to) {
      const status = to.dataset.to;
      if (status === "cancelado" && !(await confirmBox(`Cancelar o pedido ${current.code}? As peças voltam para o estoque.`, { confirm: "Cancelar pedido", danger: true }))) return;
      const trackingCode = status === "enviado" ? $("#ship-code", body)?.value.trim() : "";
      if (status === "enviado" && !trackingCode && !(await confirmBox("Marcar como enviado sem código de rastreio? (ex.: entrega em mãos ou motoboy)", { confirm: "Enviar sem rastreio" }))) return;
      to.disabled = true;
      try {
        current = await api(`/orders/${current.code}/status`, { method: "PATCH", body: { status, ...(trackingCode ? { trackingCode, carrier: $("#ship-carrier", body).value } : {}) } });
        toast(`${current.code}: ${STATUS[status]}`);
        renderOrder();
        refreshBadges();
        document.dispatchEvent(new CustomEvent("orders:changed"));
      } catch (err) { errorToast(err); to.disabled = false; }
    }
  };
  body.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      if (f.id === "tracking-form") {
        current = await api(`/orders/${current.code}/tracking`, { method: "PATCH", body: { trackingCode: f.trackingCode.value, carrier: f.carrier.value } });
        toast("Rastreio salvo");
      }
      if (f.id === "note-form") {
        current = await api(`/orders/${current.code}/note`, { method: "PATCH", body: { note: f.note.value } });
        toast("Nota salva");
      }
      renderOrder();
    } catch (err) { errorToast(err); }
  };
}

export async function refreshBadges() {
  try {
    const d = await api("/dashboard");
    const o = $("#nav-orders");
    o.hidden = !(d.toShip + d.awaiting.count);
    o.textContent = d.toShip + d.awaiting.count;
    o.title = `${d.awaiting.count} aguardando pagamento, ${d.toShip} para enviar`;
    const s = $("#nav-stock");
    s.hidden = !d.counts.lowStock;
    s.textContent = d.counts.lowStock;
  } catch { /* silencioso */ }
}

export { LINE };
