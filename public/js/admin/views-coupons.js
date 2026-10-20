import {
  $, $$, api, brl, closeModal, confirmBox, errorToast, esc, fmtDate, frame, LINE, loading, moneyField,
  openModal, parseMoney, pill, showFieldErrors, toast, view,
} from "./core.js";

export async function couponsView() {
  frame("Cupons", `<button class="btn btn-dark btn-sm" id="new-coupon">Novo cupom</button>`);
  loading();
  let list = await api("/coupons");
  const render = () => {
    view().innerHTML = `
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Código</th><th>Regra</th><th>Validade</th><th class="num">Usos</th><th class="num">Vendas com o cupom</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.length ? list.map((c) => `<tr>
          <td class="strong">${esc(c.code)}</td>
          <td>${esc(c.summary)}${c.oncePerCustomer ? `<br><span class="muted">1 uso por cliente</span>` : ""}</td>
          <td>${c.startsAt || c.expiresAt ? `${c.startsAt ? fmtDate(c.startsAt, { dateStyle: "short" }) : "agora"} → ${c.expiresAt ? fmtDate(c.expiresAt, { dateStyle: "short" }) : "sem fim"}` : `<span class="muted">sem prazo</span>`}</td>
          <td class="num">${c.uses}${c.maxUses ? ` / ${c.maxUses}` : ""}</td>
          <td class="num">${c.stats.orders ? `${brl(c.stats.revenue)}<br><span class="muted">${c.stats.orders} pedido(s)${c.kind === "shipping" ? " com frete grátis" : `, −${brl(c.stats.discount)}`}</span>` : "—"}</td>
          <td>${pill(c.status, c.status[0].toUpperCase() + c.status.slice(1))}</td>
          <td><div class="actions-row"><button class="btn btn-ghost btn-sm" data-edit="${esc(c.code)}">Editar</button><button class="btn btn-ghost btn-sm" data-del="${esc(c.code)}">Excluir</button></div></td>
        </tr>`).join("") : `<tr><td colspan="7" class="empty-row">Nenhum cupom ainda. Crie o primeiro para impulsionar as vendas.</td></tr>`}</tbody>
      </table></div>`;
  };
  render();
  const reload = async () => { list = await api("/coupons"); render(); };
  $("#new-coupon").addEventListener("click", () => couponForm(null, reload));
  view().addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-edit]");
    if (ed) return couponForm(list.find((c) => c.code === ed.dataset.edit), reload);
    const del = e.target.closest("[data-del]");
    if (del) {
      if (!(await confirmBox(`Excluir o cupom ${del.dataset.del}? Se ele já foi usado, será apenas desativado.`, { confirm: "Excluir", danger: true }))) return;
      try {
        const r = await api(`/coupons/${encodeURIComponent(del.dataset.del)}`, { method: "DELETE" });
        toast(r.deleted ? "Cupom excluído" : "Cupom já usado: foi desativado");
        reload();
      } catch (err) { errorToast(err); }
    }
  });
}

const toLocalDate = (iso) => (iso ? new Date(new Date(iso).getTime() - 3 * 3600_000).toISOString().slice(0, 10) : "");

function couponForm(c, onSaved) {
  const v = c || { code: "", kind: "percent", value: 10, minSubtotalCents: 0, maxUses: null, startsAt: null, expiresAt: null, active: true, firstPurchaseOnly: false, oncePerCustomer: false, line: null, description: "" };
  const body = openModal(`
    <h2>${c ? `Editar ${esc(c.code)}` : "Novo cupom"}</h2>
    <form id="coupon-form" class="form-section" novalidate>
      <div class="fgrid">
        <label class="field s3"><span>Código</span><input name="code" value="${esc(v.code)}" maxlength="30" placeholder="EX.: VERAO15" style="text-transform:uppercase" required></label>
        <label class="field s3"><span>Tipo de desconto</span><select name="kind">
          <option value="percent" ${v.kind === "percent" ? "selected" : ""}>Porcentagem (%)</option>
          <option value="fixed" ${v.kind === "fixed" ? "selected" : ""}>Valor fixo (R$)</option>
          <option value="shipping" ${v.kind === "shipping" ? "selected" : ""}>Frete grátis (entrega padrão)</option></select></label>
        <label class="field s2" data-kind="percent"><span>Desconto (%)</span><input name="pct" type="number" min="1" max="90" value="${v.kind === "percent" ? v.value : 10}"></label>
        <div class="field s2" data-kind="fixed"><span>Desconto (R$)</span><span class="money-input"><input name="fixed" inputmode="decimal" value="${v.kind === "fixed" ? moneyField(v.value) : ""}" placeholder="20,00"></span></div>
        <div class="field s2"><span>Compra mínima</span><span class="money-input"><input name="minSubtotalCents" inputmode="decimal" value="${v.minSubtotalCents ? moneyField(v.minSubtotalCents) : ""}" placeholder="sem mínimo"></span></div>
        <label class="field s2"><span>Limite total de usos</span><input name="maxUses" type="number" min="1" value="${v.maxUses ?? ""}" placeholder="ilimitado"></label>
        <label class="field s2"><span>Vale para</span><select name="line"><option value="">Toda a loja</option><option value="adapt" ${v.line === "adapt" ? "selected" : ""}>Só US Adapt</option><option value="essential" ${v.line === "essential" ? "selected" : ""}>Só US Essential</option></select></label>
        <label class="field s3"><span>Começa em <span class="hint">(opcional)</span></span><input name="startsAt" type="date" value="${toLocalDate(v.startsAt)}"></label>
        <label class="field s3"><span>Termina em <span class="hint">(opcional)</span></span><input name="expiresAt" type="date" value="${toLocalDate(v.expiresAt)}"></label>
        <label class="check s3"><input type="checkbox" name="firstPurchaseOnly" ${v.firstPurchaseOnly ? "checked" : ""}><span>Só na primeira compra<small>Confere CPF e e-mail do cliente</small></span></label>
        <label class="check s3"><input type="checkbox" name="oncePerCustomer" ${v.oncePerCustomer ? "checked" : ""}><span>Uma vez por cliente</span></label>
        <label class="field s6"><span>Texto que o cliente vê <span class="hint">(opcional, gerado automaticamente)</span></span><input name="description" value="${esc(v.description)}" maxlength="120"></label>
        <label class="switch s6"><input type="checkbox" name="active" ${v.active ? "checked" : ""}><i></i> Cupom ativo</label>
      </div>
      <p class="coupon-preview" id="coupon-preview"></p>
      <div class="actions-row"><button class="btn btn-dark" type="submit">${c ? "Salvar cupom" : "Criar cupom"}</button><button class="btn btn-ghost" type="button" data-close>Cancelar</button></div>
    </form>`);
  const f = $("#coupon-form", body);
  // o dia de término vale inteiro (até 23:59 de Brasília)
  const endOfDay = (d) => (d ? new Date(`${d}T23:59:59-03:00`).toISOString() : null);
  const payload = () => {
    const kind = f.kind.value;
    return {
      code: f.code.value.trim().toUpperCase(), kind,
      value: kind === "percent" ? Number(f.pct.value || 0) : kind === "fixed" ? parseMoney(f.fixed.value) ?? 0 : 0,
      minSubtotalCents: parseMoney(f.minSubtotalCents.value) ?? 0,
      maxUses: f.maxUses.value ? Number(f.maxUses.value) : null,
      startsAt: f.startsAt.value || null,
      expiresAt: endOfDay(f.expiresAt.value),
      active: f.active.checked, firstPurchaseOnly: f.firstPurchaseOnly.checked, oncePerCustomer: f.oncePerCustomer.checked,
      line: f.line.value || null, description: f.description.value.trim(),
    };
  };
  const refresh = () => {
    $$("[data-kind]", f).forEach((el) => { el.hidden = el.dataset.kind !== f.kind.value; });
    const p = payload();
    const what = p.kind === "percent" ? `${p.value || 0}% OFF` : p.kind === "fixed" ? `${brl(p.value)} OFF` : "Frete grátis";
    const rules = [
      p.line && `em ${LINE[p.line]}`, p.minSubtotalCents && `acima de ${brl(p.minSubtotalCents)}`, p.firstPurchaseOnly && "na primeira compra",
      p.oncePerCustomer && "1 vez por cliente", p.maxUses && `até ${p.maxUses} usos`, f.expiresAt.value && `até ${f.expiresAt.value.split("-").reverse().join("/")}`,
    ].filter(Boolean);
    $("#coupon-preview", f).textContent = `${p.code || "CÓDIGO"}: ${what}${rules.length ? ` ${rules.join(", ")}` : ""}`;
  };
  f.addEventListener("input", refresh);
  f.addEventListener("change", refresh);
  refresh();
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api(c ? `/coupons/${encodeURIComponent(c.code)}` : "/coupons", { method: c ? "PUT" : "POST", body: payload() });
      toast(c ? "Cupom salvo" : "Cupom criado e já vale na loja");
      closeModal();
      onSaved();
    } catch (err) {
      const fields = err.body?.fields;
      if (fields?.value) fields[f.kind.value === "percent" ? "pct" : "fixed"] = fields.value;
      if (!showFieldErrors(f, err)) errorToast(err);
    }
  });
}
