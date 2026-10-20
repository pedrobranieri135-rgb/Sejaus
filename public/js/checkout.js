import { $, $$, api, ApiError, brl, esc, isValidCpf, masks, newKey, onlyDigits, store, toast } from "./lib.js";
import { closeCart, openCart, refreshQuote, state } from "./app.js";

const UFS = ["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];
const STEPS = ["Seus dados", "Entrega", "Pagamento"];

const co = {
  step: 1,
  key: null,
  submitting: false,
  errors: {},
  formError: "",
  couponRejected: false,
  autofilled: {}, // valores que vieram do ViaCEP (podem ser trocados por outro CEP)
  data: {
    customer: { name: "", email: "", phone: "", cpf: "" },
    address: { cep: "", street: "", number: "", complement: "", district: "", city: "", state: "" },
    shipping: "padrao",
    payment: "pix",
  },
};

const dlg = () => $("#checkout-modal");
const body = () => $("#checkout-body");

/* ---------- validação (espelha o servidor) ---------- */
function validateStep(step) {
  const e = {};
  const { customer: c, address: a } = co.data;
  if (step === 1) {
    if (c.name.trim().length < 3 || !c.name.trim().includes(" ")) e["customer.name"] = "Informe nome e sobrenome";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email.trim())) e["customer.email"] = "E-mail inválido";
    if (!/^\d{10,11}$/.test(onlyDigits(c.phone))) e["customer.phone"] = "Telefone com DDD";
    if (!isValidCpf(c.cpf)) e["customer.cpf"] = "CPF inválido";
  }
  if (step === 2) {
    if (onlyDigits(a.cep).length !== 8) e["address.cep"] = "CEP inválido";
    if (a.street.trim().length < 2) e["address.street"] = "Informe a rua";
    if (!a.number.trim()) e["address.number"] = "Informe o número";
    if (a.district.trim().length < 2) e["address.district"] = "Informe o bairro";
    if (a.city.trim().length < 2) e["address.city"] = "Informe a cidade";
    if (!UFS.includes(a.state)) e["address.state"] = "Selecione a UF";
  }
  return e;
}

const stepOfField = (f) => (f.startsWith("customer") ? 1 : f.startsWith("address") || f === "shipping" ? 2 : 3);

/* ---------- render ---------- */
function field(path, label, attrs = "", cls = "c6") {
  const [g, k] = path.split(".");
  const v = co.data[g][k];
  const err = co.errors[path];
  return `<label class="field ${cls} ${err ? "invalid" : ""}"><span>${esc(label)}</span>
    <input name="${path}" value="${esc(v)}" ${attrs} aria-invalid="${!!err}" ${err ? `aria-describedby="err-${k}"` : ""}>
    ${err ? `<span class="err" id="err-${k}">${esc(err)}</span>` : ""}</label>`;
}

function summaryHTML() {
  const q = state.quote;
  if (!q) return "";
  const opt = q.shipping?.options.find((o) => o.id === co.data.shipping);
  const total = q.subtotalCents - q.discountCents + (opt?.priceCents ?? 0);
  return `
    <h3 style="font-family:var(--f-display);font-size:1rem">Resumo</h3>
    ${q.lines.map((l) => `<div class="sum-line"><img src="${esc(l.image)}" alt=""><span>${l.qty}x ${esc(l.name)}<br><span class="muted">${esc(l.color)} / ${esc(l.size)}</span></span><b>${brl(l.lineTotalCents)}</b></div>`).join("")}
    <div class="totals">
      <div><span>Subtotal</span><span>${brl(q.subtotalCents)}</span></div>
      ${q.discountCents ? `<div class="disc"><span>Cupom ${esc(q.coupon?.code)}</span><span>− ${brl(q.discountCents)}</span></div>` : ""}
      <div><span>Frete</span><span>${opt ? (opt.priceCents ? brl(opt.priceCents) : "Grátis") : "—"}</span></div>
      <div class="grand"><span>Total</span><span>${brl(total)}</span></div>
    </div>`;
}

function stepHTML() {
  const d = co.data;
  if (co.step === 1) {
    return `<div class="form-grid">
      ${field("customer.name", "Nome completo", 'autocomplete="name" maxlength="80" required')}
      ${field("customer.email", "E-mail", 'type="email" autocomplete="email" maxlength="120" required', "c3")}
      ${field("customer.phone", "Celular / WhatsApp", 'inputmode="tel" autocomplete="tel" data-mask="phone" required', "c3")}
      ${field("customer.cpf", "CPF (para nota fiscal)", 'inputmode="numeric" data-mask="cpf" required', "c3")}
    </div>`;
  }
  if (co.step === 2) {
    const ship = state.quote?.shipping;
    return `<div class="form-grid">
      ${field("address.cep", "CEP", 'inputmode="numeric" autocomplete="postal-code" data-mask="cep" required', "c2")}
      ${field("address.street", "Rua", 'autocomplete="address-line1" maxlength="120" required', "c4")}
      ${field("address.number", "Número", 'maxlength="10" required', "c2")}
      ${field("address.complement", "Complemento (opcional)", 'autocomplete="address-line2" maxlength="60"', "c4")}
      ${field("address.district", "Bairro", 'maxlength="60" required', "c2")}
      ${field("address.city", "Cidade", 'autocomplete="address-level2" maxlength="60" required', "c2")}
      <label class="field c2 ${co.errors["address.state"] ? "invalid" : ""}"><span>Estado (UF)</span>
        <select name="address.state" autocomplete="address-level1"><option value="">--</option>${UFS.map((u) => `<option ${u === d.address.state ? "selected" : ""}>${u}</option>`).join("")}</select>
        ${co.errors["address.state"] ? `<span class="err">${esc(co.errors["address.state"])}</span>` : ""}</label>
    </div>
    <div class="choice-list" role="radiogroup" aria-label="Forma de entrega">
      ${ship ? ship.options.map((o) => `
        <label class="choice"><input type="radio" name="shipping" value="${o.id}" ${d.shipping === o.id ? "checked" : ""}>
          <span><b>${esc(o.label)}</b><span>${o.days[0]} a ${o.days[1]} dias úteis / ${esc(ship.region)}</span></span>
          <strong>${o.priceCents ? brl(o.priceCents) : "Grátis"}</strong></label>`).join("")
        : `<p class="muted">Digite o CEP para ver as opções de entrega.</p>`}
    </div>`;
  }
  return `<div class="choice-list" role="radiogroup" aria-label="Forma de pagamento">
      <label class="choice"><input type="radio" name="payment" value="pix" ${d.payment === "pix" ? "checked" : ""}>
        <span><b>Pix</b><span>Código copia e cola na hora. Aprovação imediata após o pagamento.</span></span></label>
      <label class="choice"><input type="radio" name="payment" value="cartao" ${d.payment === "cartao" ? "checked" : ""}>
        <span><b>Cartão de crédito em até 3x</b><span>Você recebe um link de pagamento seguro no WhatsApp. Não pedimos dados do cartão aqui.</span></span></label>
      <label class="choice"><input type="radio" name="payment" value="whatsapp" ${d.payment === "whatsapp" ? "checked" : ""}>
        <span><b>Combinar pelo WhatsApp</b><span>Fale com a equipe US para tirar dúvidas antes de pagar.</span></span></label>
    </div>
    <div class="pix-box" style="font-size:.875rem">
      <div><b>Entrega para</b> ${esc(d.customer.name)}<br>${esc(d.address.street)}, ${esc(d.address.number)}${d.address.complement ? ` — ${esc(d.address.complement)}` : ""}, ${esc(d.address.district)}, ${esc(d.address.city)}/${esc(d.address.state)}, ${esc(masks.cep(d.address.cep))}</div>
      <button class="linklike" type="button" data-goto="2">Alterar endereço</button>
    </div>
    <p class="muted">Seu pedido fica reservado por 48 horas aguardando o pagamento.</p>`;
}

function render() {
  const blockedByIssues = state.quote?.issues?.length > 0;
  body().innerHTML = `
  <button class="icon-btn modal-close" data-close aria-label="Fechar"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
  <div class="co-grid">
    <form class="co-main" id="co-form" novalidate>
      <h2 id="co-title">Finalizar compra</h2>
      <ol class="steps">${STEPS.map((s, i) => `<li class="${i + 1 < co.step ? "done" : i + 1 === co.step ? "current" : ""}" ${i + 1 === co.step ? 'aria-current="step"' : ""}>${esc(s)}</li>`).join("")}</ol>
      ${co.formError ? `<div class="form-error" role="alert">${esc(co.formError)}${co.couponRejected ? ` <button class="linklike" type="button" data-drop-coupon>Continuar sem o cupom</button>` : ""}</div>` : ""}
      ${stepHTML()}
      <div class="co-nav">
        ${co.step > 1 ? `<button class="btn btn-ghost" type="button" data-back>Voltar</button>` : `<span></span>`}
        <button class="btn btn-dark" type="submit" ${co.submitting || blockedByIssues ? "disabled" : ""}>
          ${co.submitting ? `<span class="spinner" aria-hidden="true"></span> Enviando pedido` : co.step < 3 ? "Continuar" : "Confirmar pedido"}
        </button>
      </div>
    </form>
    <aside class="co-side" aria-label="Resumo do pedido">${summaryHTML()}</aside>
  </div>`;
  const firstInvalid = $(".field.invalid input, .field.invalid select", body());
  if (firstInvalid) firstInvalid.focus();
}

function renderDone(order) {
  const p = order.payment;
  body().innerHTML = `
  <button class="icon-btn modal-close" data-close aria-label="Fechar"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
  <div class="done-view">
    <span class="done-mark"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
    <h2>Pedido recebido!</h2>
    <p>Guarde este código: com ele e o e-mail <b>${esc(order.customer.email)}</b> você acompanha o pedido aqui no site.</p>
    <p class="order-code">${esc(order.code)}</p>
    <p>Total: <b>${brl(order.totalCents)}</b></p>
    ${p?.pix ? `
      <div class="pix-box">
        <b>Pague com Pix copia e cola</b>
        <code>${esc(p.pix.copyPaste)}</code>
        <button class="btn btn-dark" type="button" data-copy="${esc(p.pix.copyPaste)}">Copiar código Pix</button>
        <span class="muted">O pedido fica reservado por ${p.pix.expiresInHours} horas. Depois de pagar, envie o comprovante no WhatsApp.</span>
      </div>` : ""}
    ${order.paymentMethod === "cartao" ? `<p class="muted">Você vai receber o link de pagamento com cartão no WhatsApp. Para agilizar, envie a mensagem abaixo.</p>` : ""}
    <div class="done-actions">
      ${p?.whatsappUrl ? `<a class="btn ${p.pix ? "btn-ghost" : "btn-dark"}" href="${esc(p.whatsappUrl)}" target="_blank" rel="noopener">Enviar pedido no WhatsApp</a>` : ""}
      <a class="btn btn-ghost" href="#rastreio" data-track="${esc(order.code)}" data-email="${esc(order.customer.email)}">Acompanhar pedido</a>
    </div>
  </div>`;
}

/* ---------- ações ---------- */
function readForm() {
  const form = $("#co-form");
  if (!form) return;
  for (const el of $$("input[name], select[name]", form)) {
    if (el.type === "radio") { if (el.checked) co.data[el.name] = el.value; continue; }
    const [g, k] = el.name.split(".");
    if (k) co.data[g][k] = el.value;
  }
}

let lastCepLookup = "";
async function lookupCep(cep) {
  if (cep === lastCepLookup) return;
  lastCepLookup = cep;
  state.cep = cep; store.set("us.cep", cep);
  const quoteP = refreshQuote();
  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    if (!j.erro) {
      const a = co.data.address;
      // troca o que veio do CEP anterior; preserva o que o cliente digitou à mão
      const auto = co.autofilled;
      const take = (key, value) => { if (!a[key] || a[key] === auto[key]) { a[key] = value || ""; auto[key] = a[key]; } };
      take("street", j.logradouro);
      take("district", j.bairro);
      a.city = j.localidade || a.city;
      a.state = j.uf || a.state;
      auto.city = a.city;
      delete co.errors["address.cep"];
    } else {
      co.errors["address.cep"] = "CEP não encontrado";
      // não deixa endereço de outro CEP para trás
      for (const k of ["street", "district", "city"]) if (co.data.address[k] && co.data.address[k] === co.autofilled[k]) co.data.address[k] = "";
    }
  } catch { /* ViaCEP fora do ar: usuário preenche manualmente */ }
  await quoteP;
  if (co.step === 2 && dlg().open) {
    const focused = document.activeElement?.name;
    render();
    if (focused) $(`[name="${focused}"]`, body())?.focus();
  }
}

async function submit() {
  co.submitting = true; co.formError = ""; co.couponRejected = false; render();
  const d = co.data;
  try {
    const order = await api("/orders", {
      method: "POST",
      headers: { "Idempotency-Key": co.key },
      body: {
        items: state.cart.map(({ sku, qty }) => ({ sku, qty })),
        customer: { ...d.customer },
        address: { ...d.address, cep: onlyDigits(d.address.cep) },
        shipping: d.shipping,
        payment: d.payment,
        coupon: state.coupon || undefined,
      },
    });
    // sucesso: limpa sacola e gera nova chave para o próximo pedido
    state.cart = []; store.set("us.cart", []);
    state.coupon = ""; store.set("us.coupon", "");
    co.key = null; co.step = 1;
    await refreshQuote();
    renderDone(order);
  } catch (err) {
    co.submitting = false;
    if (err instanceof ApiError && err.status === 409) {
      dlg().close();
      await refreshQuote();
      openCart();
      toast("Algumas peças acabaram de esgotar. Ajuste a sacola para continuar.", { type: "bad", timeout: 5000 });
      return;
    }
    if (err instanceof ApiError && err.body.fields) {
      co.errors = err.body.fields;
      co.step = Math.min(...Object.keys(err.body.fields).map(stepOfField));
      co.formError = "Revise os campos destacados.";
    } else if (err instanceof ApiError && err.body.field === "coupon") {
      co.formError = `${err.message}.`;
      co.couponRejected = true;
    } else {
      co.formError = err.message || "Não foi possível enviar o pedido. Tente novamente.";
    }
    render();
  }
}

export async function openCheckout() {
  if (!state.cart.length) return toast("Sua sacola está vazia", { type: "bad" });
  closeCart();
  co.key ??= newKey(); // mesma chave em re-tentativas = sem pedido duplicado
  co.errors = {}; co.formError = ""; co.submitting = false;
  if (state.cep && !co.data.address.cep) co.data.address.cep = masks.cep(state.cep);
  await refreshQuote();
  if (state.quote?.issues?.length) { openCart(); return toast("Ajuste os itens da sacola antes de finalizar", { type: "bad" }); }
  render();
  if (!dlg().open) dlg().showModal();
  if (co.data.address.cep && onlyDigits(co.data.address.cep).length === 8) lookupCep(onlyDigits(co.data.address.cep));
}

function init() {
  const m = dlg();
  m.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.mask) el.value = masks[el.dataset.mask](el.value);
    if (el.name) {
      const [g, k] = el.name.split(".");
      if (k) co.data[g][k] = el.value;
      if (co.errors[el.name]) { delete co.errors[el.name]; el.closest(".field")?.classList.remove("invalid"); el.closest(".field")?.querySelector(".err")?.remove(); }
    }
    if (el.name === "address.cep" && onlyDigits(el.value).length === 8) lookupCep(onlyDigits(el.value));
  });
  m.addEventListener("change", (e) => {
    if (e.target.name === "shipping" || e.target.name === "payment") { co.data[e.target.name] = e.target.value; $(".co-side", m).innerHTML = summaryHTML(); }
    if (e.target.name === "address.state") co.data.address.state = e.target.value;
  });
  m.addEventListener("submit", (e) => {
    e.preventDefault();
    if (co.submitting) return;
    readForm();
    const errs = validateStep(co.step);
    co.errors = errs; co.formError = "";
    if (Object.keys(errs).length) return render();
    if (co.step === 2 && !state.quote?.shipping) { co.formError = "Aguarde o cálculo do frete para o seu CEP."; return render(); }
    if (co.step < 3) { co.step++; render(); $("#co-form", m).scrollIntoView({ block: "start" }); return; }
    submit();
  });
  m.addEventListener("click", (e) => {
    if (e.target.closest("[data-drop-coupon]")) {
      state.coupon = ""; store.set("us.coupon", "");
      co.couponRejected = false; co.formError = "";
      refreshQuote().then(() => { render(); toast("Cupom removido. Confira o novo total e confirme."); });
      return;
    }
    if (e.target.closest("[data-back]")) { readForm(); co.step--; co.errors = {}; co.formError = ""; render(); }
    const g = e.target.closest("[data-goto]");
    if (g) { co.step = Number(g.dataset.goto); render(); }
    const tr = e.target.closest("[data-track]");
    if (tr) {
      const f = $("#track-form");
      e.preventDefault();
      f.code.value = tr.dataset.track;
      f.email.value = tr.dataset.email;
      m.close();
      f.requestSubmit();
      // o modal devolve o foco ao botão de origem ao fechar; rola depois disso
      setTimeout(() => $("#rastreio").scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    }
  });
}

init();
