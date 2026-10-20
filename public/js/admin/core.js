import { $, $$, ApiError, brl, esc, toast } from "../lib.js";

export { $, $$, brl, esc, toast };

export const state = { me: null, meta: null, onUnauthorized: null };

/** Chamada à API do painel: cookie de sessão + JSON. 401 → volta para o login. */
export async function api(path, { method = "GET", body, raw, contentType } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (raw) headers["Content-Type"] = contentType;
  let res;
  try {
    res = await fetch(`/api/admin${path}`, { method, headers, credentials: "same-origin", body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  } catch {
    throw new ApiError(0, { error: "Sem conexão com o servidor" });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/login") { state.onUnauthorized?.(); throw new ApiError(401, data); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/* ---------- formatação ---------- */
export const fmtDate = (iso, opts = { dateStyle: "short", timeStyle: "short" }) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", ...opts }) : "—";
export const fmtDay = (ymd) => ymd.split("-").reverse().slice(0, 2).join("/");
export const pct = (n) => `${n > 0 ? "+" : ""}${(n * 100).toFixed(Math.abs(n) < 0.1 ? 1 : 0)}%`;
export const num = (n) => (n || 0).toLocaleString("pt-BR");
export const compactBRL = (c) => {
  const v = (c || 0) / 100;
  if (v >= 1000) return `R$ ${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
  return `R$ ${Math.round(v).toLocaleString("pt-BR")}`;
};
/** "1.234,56" / "99,9" / "99" → centavos */
export function parseMoney(s) {
  const clean = String(s ?? "").replace(/[^\d,.-]/g, "");
  if (!clean) return null;
  const normalized = clean.includes(",") ? clean.replace(/\./g, "").replace(",", ".") : clean;
  const v = Number(normalized);
  return Number.isFinite(v) ? Math.round(v * 100) : NaN;
}
export const moneyField = (c) => (c == null ? "" : (c / 100).toFixed(2).replace(".", ","));

export const STATUS = {
  aguardando_pagamento: "Aguardando pagamento", pago: "Pago", em_separacao: "Em separação",
  enviado: "Enviado", entregue: "Entregue", cancelado: "Cancelado",
};
export const NEXT = {
  aguardando_pagamento: ["pago", "cancelado"], pago: ["em_separacao", "cancelado"],
  em_separacao: ["enviado", "cancelado"], enviado: ["entregue"], entregue: [], cancelado: [],
};
export const PAYMENT = { pix: "Pix", cartao: "Cartão (link)", whatsapp: "WhatsApp" };
export const SHIPPING = { padrao: "Padrão", expresso: "Expressa" };
export const LINE = { adapt: "US Adapt", essential: "US Essential" };

export const pill = (key, label) => `<span class="pill" data-s="${esc(key)}">${esc(label ?? STATUS[key] ?? key)}</span>`;
export function delta(change) {
  if (change == null || !Number.isFinite(change)) return `<span class="delta">sem base de comparação</span>`;
  const cls = change > 0.0005 ? "up" : change < -0.0005 ? "down" : "";
  const arrow = cls === "up" ? "▲" : cls === "down" ? "▼" : "";
  return `<span class="delta ${cls}">${arrow} ${pct(change)}</span>`;
}
export const waLink = (phone) => `https://wa.me/55${String(phone).replace(/\D/g, "")}`;

/* ---------- moldura da tela ---------- */
export function frame(title, actionsHTML = "") {
  $("#view-title").textContent = title;
  $("#view-actions").innerHTML = actionsHTML;
  document.title = `${title} — Painel Seja US`;
}
export const view = () => $("#view");

/* ---------- painel lateral ---------- */
let lastFocus;
export function openPanel(html) {
  const p = $("#side-panel");
  lastFocus = document.activeElement;
  $("#side-panel-body").innerHTML = html;
  $("#panel-backdrop").hidden = false;
  p.removeAttribute("inert");
  p.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => { p.classList.add("open"); $("#panel-backdrop").classList.add("show"); });
  setTimeout(() => $("[data-panel-close]", p)?.focus(), 60);
}
export function closePanel() {
  const p = $("#side-panel");
  if (!p.classList.contains("open")) return;
  p.classList.remove("open");
  $("#panel-backdrop").classList.remove("show");
  p.setAttribute("inert", "");
  p.setAttribute("aria-hidden", "true");
  setTimeout(() => { $("#panel-backdrop").hidden = true; }, 300);
  lastFocus?.focus?.();
}
export const panelBody = () => $("#side-panel-body");
export const closeBtn = (attr = "data-panel-close") =>
  `<button class="icon-btn" type="button" ${attr} aria-label="Fechar"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;

/* ---------- modal ---------- */
export function openModal(html) {
  const d = $("#admin-modal");
  $("#admin-modal-body").innerHTML = `<button class="icon-btn modal-close" type="button" data-close aria-label="Fechar"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>${html}`;
  if (!d.open) d.showModal();
  return $("#admin-modal-body");
}
export const closeModal = () => $("#admin-modal").close();

export function confirmBox(message, { confirm = "Confirmar", danger = false } = {}) {
  return new Promise((resolve) => {
    const body = openModal(`<h2>Confirmar</h2><p>${esc(message)}</p>
      <div class="actions-row"><button class="btn ${danger ? "btn-danger" : "btn-dark"}" data-yes>${esc(confirm)}</button><button class="btn btn-ghost" data-no>Voltar</button></div>`);
    const d = $("#admin-modal");
    const done = (v) => { d.removeEventListener("close", onClose); resolve(v); if (d.open) d.close(); };
    const onClose = () => resolve(false);
    d.addEventListener("close", onClose, { once: true });
    $("[data-yes]", body).addEventListener("click", () => done(true), { once: true });
    $("[data-no]", body).addEventListener("click", () => done(false), { once: true });
  });
}

/** Mostra erros de validação do servidor ({ fields }) nos campos de um formulário. */
export function showFieldErrors(form, err) {
  $$(".field.invalid", form).forEach((f) => { f.classList.remove("invalid"); $(".err", f)?.remove(); });
  const fields = err?.body?.fields || (err?.body?.field ? { [err.body.field]: err.message } : null);
  if (!fields) return false;
  let first;
  for (const [k, msg] of Object.entries(fields)) {
    const input = form.querySelector(`[name="${CSS.escape(k)}"]`) || form.querySelector(`[data-field="${CSS.escape(k.split(".")[0])}"]`);
    const field = input?.closest(".field");
    if (field) {
      field.classList.add("invalid");
      field.insertAdjacentHTML("beforeend", `<span class="err">${esc(msg)}</span>`);
      first ??= input;
    }
  }
  first?.focus();
  return true;
}

export function errorToast(err) {
  if (err?.status === 401) return;
  const fields = err?.body?.fields;
  const detail = fields ? Object.values(fields)[0] : "";
  toast(detail ? `${err.message}: ${detail}` : err?.message || "Erro inesperado", { type: "bad", timeout: 4500 });
}

export function loading() {
  view().innerHTML = `<div class="kpis">${'<div class="kpi skeleton" style="aspect-ratio:auto;height:96px"></div>'.repeat(4)}</div><div class="card-box skeleton" style="aspect-ratio:auto;height:300px"></div>`;
}

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== "" && v != null) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};
