// utilidades compartilhadas (sem dependências)

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Escapa qualquer texto antes de ir para innerHTML. */
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

const fmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const brl = (cents) => fmt.format((cents || 0) / 100);

export const onlyDigits = (s) => String(s ?? "").replace(/\D/g, "");

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const store = {
  get(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* modo privado: segue sem persistir */ }
  },
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || "Falha de conexão");
    this.status = status;
    this.body = body || {};
  }
}

export async function api(path, { method = "GET", body, headers = {}, signal } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method, signal,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError(0, { error: "Sem conexão. Verifique sua internet e tente de novo." });
  }
  let data = null;
  try { data = await res.json(); } catch { /* resposta sem corpo */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export function toast(message, { type = "", action, onAction, timeout = 3200 } = {}) {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.setAttribute("role", type === "bad" ? "alert" : "status");
  el.textContent = message;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action;
    b.addEventListener("click", () => { onAction?.(); close(); });
    el.append(b);
  }
  box.append(el);
  const close = () => { el.classList.add("out"); setTimeout(() => el.remove(), 300); };
  setTimeout(close, timeout);
}

// máscaras de input
export const masks = {
  cpf: (v) => onlyDigits(v).slice(0, 11).replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2"),
  phone: (v) => {
    const d = onlyDigits(v).slice(0, 11);
    if (d.length <= 2) return d.length ? `(${d}` : "";
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  },
  cep: (v) => onlyDigits(v).slice(0, 8).replace(/(\d{5})(\d{1,3})$/, "$1-$2"),
};

export function isValidCpf(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-key`);
