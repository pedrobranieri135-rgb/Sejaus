import { $, $$, api, ApiError, brl, debounce, esc, store, toast } from "./lib.js";
import { openCheckout } from "./checkout.js";

const MAX_QTY = 10;
const LINE_LABEL = { adapt: "US Adapt", essential: "US Essential" };
const STATUS = {
  aguardando_pagamento: "Aguardando pagamento",
  pago: "Pagamento aprovado",
  em_separacao: "Em separação",
  enviado: "Enviado",
  entregue: "Entregue",
  cancelado: "Cancelado",
};

export const state = {
  meta: null,
  products: [],
  filters: { line: "", category: "", size: "", q: "", sort: "" },
  cart: store.get("us.cart", []).filter((i) => Number.isInteger(i?.sku) && i.qty > 0),
  favs: new Set(store.get("us.favs", [])),
  cep: store.get("us.cep", ""),
  coupon: store.get("us.coupon", ""),
  quote: null,
};

/* ============ util ============ */
const offPct = (p) => Math.round((1 - p.priceCents / p.compareAtCents) * 100);
const bySlug = (slug) => state.products.find((p) => p.slug === slug);
const firstAvailableVariant = (p) => Math.max(0, p.variants.findIndex((v) => v.skus.some((s) => s.available)));

function bump(el) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }

function setWhatsappLinks() {
  const n = state.meta?.store?.whatsapp;
  const text = encodeURIComponent("Olá, US! Vim pelo site e quero ajuda para escolher meu look.");
  $$("[data-whatsapp]").forEach((a) => { a.href = `https://wa.me/${n}?text=${text}`; });
}

/* ============ HERO comparador ============ */
function initSplit() {
  const split = $("#split");
  const range = $("#split-range");
  const narrow = matchMedia("(max-width: 900px)");
  const set = (v) => {
    v = Number(v);
    split.style.setProperty("--pos", `${v}%`);
    // no celular não cabem os dois textos: mostra só o do lado que ocupa mais tela
    split.dataset.focus = narrow.matches ? (v < 50 ? "essential" : "adapt") : v < 32 ? "essential" : v > 68 ? "adapt" : "";
  };
  narrow.addEventListener("change", () => set(range.value));
  // teclado (setas) via range invisível
  range.addEventListener("input", () => set(range.value));

  // arraste só pelo símbolo/linha — botões do hero continuam clicáveis
  const handle = $("#split-handle");
  const moveTo = (clientX) => {
    const r = split.getBoundingClientRect();
    const v = Math.min(92, Math.max(8, ((clientX - r.left) / r.width) * 100));
    range.value = v;
    set(v.toFixed(2));
  };
  handle.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".handle-knob, .handle-hit")) return;
    e.preventDefault();
    e.target.setPointerCapture(e.pointerId); // eventos seguintes sobem até o handle
    split.classList.add("dragging");
    split.classList.remove("intro");
  });
  handle.addEventListener("pointermove", (e) => {
    if (split.classList.contains("dragging")) moveTo(e.clientX);
  });
  const stop = (e) => {
    split.classList.remove("dragging");
    if (e.target.hasPointerCapture?.(e.pointerId)) e.target.releasePointerCapture(e.pointerId);
  };
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  split.classList.add("intro");
  setTimeout(() => split.classList.remove("intro"), 2600);
  set(range.value);
}

/* ============ LOJA ============ */
function renderCategoryChips() {
  const used = new Set(state.products.filter((p) => !state.filters.line || p.line === state.filters.line).map((p) => p.category));
  const cats = Object.entries(state.meta.categories).filter(([k]) => used.has(k));
  if (state.filters.category && !used.has(state.filters.category)) state.filters.category = "";
  $("#category-chips").innerHTML = [["", "Todas"], ...cats]
    .map(([k, label]) => `<button class="chip" type="button" data-cat="${esc(k)}" aria-pressed="${state.filters.category === k}">${esc(label)}</button>`)
    .join("");
}

function renderSizeFilter() {
  const sizes = [...new Set(state.products.filter((p) => !state.filters.line || p.line === state.filters.line).flatMap((p) => p.sizes))];
  const order = ["Único", "P", "P/M", "M", "M/G", "G", "G/GG", "GG", "XGG"];
  sizes.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (state.filters.size && !sizes.includes(state.filters.size)) state.filters.size = "";
  $("#size-filter").innerHTML = `<option value="">Todos os tamanhos</option>` +
    sizes.map((s) => `<option value="${esc(s)}" ${s === state.filters.size ? "selected" : ""}>Tamanho ${esc(s)}</option>`).join("");
}

function moveTabInk() {
  const sel = $('.line-tabs [aria-selected="true"]');
  const ink = $(".tab-ink");
  if (!sel) return;
  ink.style.width = `${sel.offsetWidth}px`;
  ink.style.transform = `translateX(${sel.offsetLeft}px)`;
}

const normalize = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function filtered() {
  const f = state.filters;
  let list = state.products.filter((p) =>
    (!f.line || p.line === f.line) &&
    (!f.category || p.category === f.category) &&
    (!f.size || p.variants.some((v) => v.skus.some((s) => s.size === f.size && s.available))));
  if (f.q) {
    const terms = normalize(f.q).split(/\s+/).filter(Boolean);
    list = list.filter((p) => {
      const hay = normalize([p.name, p.categoryLabel, p.description, LINE_LABEL[p.line], ...p.variants.map((v) => v.color)].join(" "));
      return terms.every((t) => hay.includes(t));
    });
  }
  if (f.sort === "price_asc") list = [...list].sort((a, b) => a.priceCents - b.priceCents);
  if (f.sort === "price_desc") list = [...list].sort((a, b) => b.priceCents - a.priceCents);
  if (f.sort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return list;
}

function cardHTML(p) {
  const vi = firstAvailableVariant(p);
  const v = p.variants[vi];
  const [a, b] = [v.images[0], v.images[1] || p.variants[(vi + 1) % p.variants.length].images[0]];
  const tags = [
    p.compareAtCents ? `<span class="tag tag-dark">-${offPct(p)}%</span>` : "",
    ...p.badges.map((t) => `<span class="tag">${esc(t)}</span>`),
    !p.inStock ? `<span class="tag tag-out">Esgotado</span>` : "",
  ].join("");
  const sizes = v.skus.map((s) => `<button class="size-pill" type="button" data-quick="${s.id}" ${s.available ? "" : "disabled"} aria-label="Adicionar tamanho ${esc(s.size)} à sacola">${esc(s.size)}</button>`).join("");
  return `
  <article class="card" data-slug="${esc(p.slug)}" data-vi="${vi}">
   <div class="card-visual">
    <div class="card-media line-${esc(p.line)}" data-open="${esc(p.slug)}" role="button" tabindex="0" aria-label="Ver ${esc(p.name)}">
      <div class="imgs">
        <img src="${esc(a.sm)}" alt="${esc(p.name)} — ${esc(v.color)}" loading="lazy" width="520" height="650">
        ${b && b.sm !== a.sm ? `<img class="alt" src="${esc(b.sm)}" alt="" loading="lazy" width="520" height="650">` : ""}
      </div>
    </div>
    <div class="card-tags">${tags}</div>
    <button class="fav-btn" type="button" data-fav="${esc(p.slug)}" aria-pressed="${state.favs.has(p.slug)}" aria-label="Favoritar ${esc(p.name)}">
      <svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>
    </button>
    ${p.inStock ? `<div class="quick-add"><span class="quick-add-label">Adicionar rápido · ${esc(v.color)}</span>${sizes}</div>` : ""}
   </div>
    <div class="card-info">
      <span class="card-line">${esc(LINE_LABEL[p.line])}</span>
      <button class="card-name" type="button" data-open="${esc(p.slug)}">${esc(p.name)}</button>
      <span class="price">${p.compareAtCents ? `<s>${brl(p.compareAtCents)}</s> ` : ""}${brl(p.priceCents)}<small>até 3x no cartão</small></span>
      <div class="swatches" role="group" aria-label="Cores">
        ${p.variants.map((c, i) => `<button class="swatch" type="button" style="--sw:${esc(c.hex)}" data-swatch="${i}" aria-pressed="${i === vi}" aria-label="${esc(c.color)}" title="${esc(c.color)}"></button>`).join("")}
      </div>
    </div>
  </article>`;
}

function renderGrid() {
  const list = filtered();
  const grid = $("#grid");
  grid.setAttribute("aria-busy", "false");
  $("#result-count").textContent = `${list.length} ${list.length === 1 ? "peça" : "peças"}`;
  if (!list.length) {
    grid.innerHTML = `<div class="empty"><h3>Nada encontrado com esses filtros</h3><p class="muted">Tente outro tamanho ou limpe a busca.</p><button class="btn btn-dark" type="button" data-clear-filters>Limpar filtros</button></div>`;
    return;
  }
  grid.innerHTML = list.map(cardHTML).join("");
}

function setCardVariant(card, vi) {
  const p = bySlug(card.dataset.slug);
  const v = p.variants[vi];
  card.dataset.vi = vi;
  const [img, alt] = $$(".imgs img", card);
  img.src = v.images[0].sm;
  img.alt = `${p.name} — ${v.color}`;
  if (alt) alt.src = (v.images[1] || v.images[0]).sm;
  $$(".swatch", card).forEach((s, i) => s.setAttribute("aria-pressed", String(i === vi)));
  const qa = $(".quick-add", card);
  if (qa) {
    qa.innerHTML = `<span class="quick-add-label">Adicionar rápido · ${esc(v.color)}</span>` +
      v.skus.map((s) => `<button class="size-pill" type="button" data-quick="${s.id}" ${s.available ? "" : "disabled"} aria-label="Adicionar tamanho ${esc(s.size)} à sacola">${esc(s.size)}</button>`).join("");
  }
}

function applyFilters({ chips = false } = {}) {
  $$(".line-tabs [role=tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.line === state.filters.line)));
  moveTabInk();
  if (chips) { renderCategoryChips(); renderSizeFilter(); }
  $$("#category-chips .chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.cat === state.filters.category)));
  renderGrid();
}

function initShop() {
  $(".line-tabs").addEventListener("click", (e) => {
    const t = e.target.closest("[role=tab]");
    if (!t) return;
    state.filters.line = t.dataset.line;
    applyFilters({ chips: true });
  });
  $("#category-chips").addEventListener("click", (e) => {
    const c = e.target.closest("[data-cat]");
    if (!c) return;
    state.filters.category = c.dataset.cat;
    applyFilters();
  });
  $("#size-filter").addEventListener("change", (e) => { state.filters.size = e.target.value; applyFilters(); });
  $("#sort").addEventListener("change", (e) => { state.filters.sort = e.target.value; applyFilters(); });
  $("#search").addEventListener("input", debounce((e) => { state.filters.q = e.target.value.trim().slice(0, 60); applyFilters(); }, 180));

  $$("[data-line-link]").forEach((a) => a.addEventListener("click", () => {
    state.filters = { ...state.filters, line: a.dataset.lineLink, category: "", size: "" };
    applyFilters({ chips: true });
  }));

  $("#grid").addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (e.target.closest("[data-clear-filters]")) {
      state.filters = { line: "", category: "", size: "", q: "", sort: "" };
      $("#search").value = ""; $("#sort").value = "";
      return applyFilters({ chips: true });
    }
    if (!card) return;
    const sw = e.target.closest("[data-swatch]");
    if (sw) return setCardVariant(card, Number(sw.dataset.swatch));
    const fav = e.target.closest("[data-fav]");
    if (fav) return toggleFav(fav.dataset.fav);
    const quick = e.target.closest("[data-quick]");
    if (quick) return addToCart(Number(quick.dataset.quick), 1, { from: quick });
    if (e.target.closest("[data-open]")) openProduct(card.dataset.slug, Number(card.dataset.vi));
  });
  $("#grid").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches(".card-media")) {
      e.preventDefault();
      const card = e.target.closest(".card");
      openProduct(card.dataset.slug, Number(card.dataset.vi));
    }
  });
  window.addEventListener("resize", debounce(moveTabInk, 100));
}

/* ============ FAVORITOS ============ */
function toggleFav(slug) {
  if (state.favs.has(slug)) state.favs.delete(slug); else state.favs.add(slug);
  store.set("us.favs", [...state.favs]);
  const on = state.favs.has(slug);
  $$(`[data-fav="${CSS.escape(slug)}"]`).forEach((b) => b.setAttribute("aria-pressed", String(on)));
  renderFavCount();
  toast(on ? "Salvo nos favoritos" : "Removido dos favoritos");
}

function renderFavCount() {
  const b = $("#fav-count");
  const n = [...state.favs].filter(bySlug).length;
  b.hidden = n === 0;
  b.textContent = n;
}

function openFavs() {
  const items = [...state.favs].map(bySlug).filter(Boolean);
  const body = $("#favs-modal-body");
  body.innerHTML = `
    <button class="icon-btn modal-close" data-close aria-label="Fechar"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    <h2 id="fav-title" class="pm-title-sm" style="font-family:var(--f-display);font-size:1.4rem">Favoritos</h2>
    ${items.length ? `<div class="fav-list">${items.map((p) => `
      <div class="fav-item">
        <img src="${esc(p.variants[0].images[0].sm)}" alt="">
        <div><b>${esc(p.name)}</b><div class="muted">${brl(p.priceCents)}</div></div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-dark" style="min-height:38px;padding:0 16px" data-fav-open="${esc(p.slug)}">Ver</button>
          <button class="icon-btn" data-fav-remove="${esc(p.slug)}" aria-label="Remover ${esc(p.name)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </div>
      </div>`).join("")}</div>`
      : `<p class="muted" style="margin-top:12px">Toque no coração das peças para guardar aqui.</p>`}`;
  const dlg = $("#favs-modal");
  if (!dlg.open) dlg.showModal();
}

/* ============ PRODUTO ============ */
const pm = { p: null, vi: 0, sku: null, qty: 1, img: 0 };

function renderProduct() {
  const { p, vi } = pm;
  const v = p.variants[vi];
  const sku = v.skus.find((s) => s.id === pm.sku);
  const img = v.images[Math.min(pm.img, v.images.length - 1)];
  const guide = p.sizeGuide && state.meta.sizeGuides[p.sizeGuide];
  $("#product-modal-body").innerHTML = `
  <button class="icon-btn modal-close" data-close aria-label="Fechar"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
  <div class="pm-grid">
    <div class="pm-gallery">
      <div class="pm-main" id="pm-main"><img src="${esc(img.lg)}" alt="${esc(p.name)} — ${esc(v.color)}"></div>
      ${v.images.length > 1 ? `<div class="pm-thumbs">${v.images.map((im, i) => `<button type="button" data-img="${i}" aria-pressed="${i === pm.img}" aria-label="Foto ${i + 1}"><img src="${esc(im.sm)}" alt=""></button>`).join("")}</div>` : ""}
    </div>
    <div class="pm-info">
      <div>
        <p class="card-line">${esc(LINE_LABEL[p.line])} / ${esc(p.categoryLabel)}</p>
        <h2 id="pm-title">${esc(p.name)}</h2>
      </div>
      <p class="pm-price">${p.compareAtCents ? `<s>${brl(p.compareAtCents)}</s> <span class="tag tag-dark">${offPct(p)}% OFF</span><br>` : ""}${brl(p.priceCents)}<small>ou em até 3x no cartão</small></p>
      <div>
        <div class="opt-head"><span>Cor: <b>${esc(v.color)}</b></span></div>
        <div class="swatches" role="group" aria-label="Cores">
          ${p.variants.map((c, i) => `<button class="swatch lg" type="button" style="--sw:${esc(c.hex)}" data-pm-color="${i}" aria-pressed="${i === vi}" aria-label="${esc(c.color)}" title="${esc(c.color)}"></button>`).join("")}
        </div>
      </div>
      <div>
        <div class="opt-head"><span>Tamanho${sku ? `: <b>${esc(sku.size)}</b>` : ""}</span>
          ${guide ? `<button class="linklike" type="button" data-size-guide="${esc(p.sizeGuide)}">Tabela de medidas</button>` : `<a class="linklike" data-whatsapp target="_blank" rel="noopener" href="#">Dúvida no tamanho?</a>`}
        </div>
        <div class="pm-sizes" role="group" aria-label="Tamanhos">
          ${v.skus.map((s) => `<button class="size-pill" type="button" data-pm-size="${s.id}" aria-pressed="${s.id === pm.sku}" ${s.available ? "" : "disabled"} title="${s.available ? "" : "Esgotado nesta cor"}">${esc(s.size)}</button>`).join("")}
        </div>
        <p class="low-note" aria-live="polite">${sku?.low ? "Últimas unidades neste tamanho" : !v.skus.some((s) => s.available) ? "Esta cor esgotou. Veja as outras cores." : ""}</p>
      </div>
      <div class="pm-actions">
        <div class="qty" role="group" aria-label="Quantidade">
          <button type="button" data-pm-qty="-1" aria-label="Diminuir" ${pm.qty <= 1 ? "disabled" : ""}>−</button>
          <output aria-live="polite">${pm.qty}</output>
          <button type="button" data-pm-qty="1" aria-label="Aumentar" ${pm.qty >= MAX_QTY ? "disabled" : ""}>+</button>
        </div>
        <button class="btn btn-dark" type="button" data-pm-add>${sku ? "Adicionar à sacola" : "Escolha um tamanho"}</button>
        <button class="fav-btn" style="position:static" type="button" data-fav="${esc(p.slug)}" aria-pressed="${state.favs.has(p.slug)}" aria-label="Favoritar"><svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg></button>
      </div>
      ${p.features.length ? `<ul class="pm-feats">${p.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
      <p class="pm-desc">${esc(p.description)}</p>
      ${p.fabric ? `<p class="pm-fabric">Composição: ${esc(p.fabric)}</p>` : ""}
    </div>
  </div>`;
  setWhatsappLinks();
}

export function openProduct(slug, vi) {
  const p = bySlug(slug);
  if (!p) return toast("Produto não encontrado", { type: "bad" });
  const startVi = Number.isInteger(vi) && p.variants[vi] ? vi : firstAvailableVariant(p);
  Object.assign(pm, { p, vi: startVi, sku: null, qty: 1, img: 0 });
  const avail = p.variants[startVi].skus.filter((s) => s.available);
  if (avail.length === 1) pm.sku = avail[0].id;
  renderProduct();
  const dlg = $("#product-modal");
  if (!dlg.open) dlg.showModal();
  history.replaceState(null, "", `#p/${slug}`);
}

function initProductModal() {
  const dlg = $("#product-modal");
  dlg.addEventListener("close", () => { if (location.hash.startsWith("#p/")) history.replaceState(null, "", location.pathname); });
  dlg.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("[data-pm-color]")) {
      pm.vi = Number(t.closest("[data-pm-color]").dataset.pmColor);
      const size = pm.p.variants.flatMap((v) => v.skus).find((s) => s.id === pm.sku)?.size;
      const same = pm.p.variants[pm.vi].skus.find((s) => s.size === size && s.available);
      pm.sku = same?.id ?? null; pm.img = 0;
      return renderProduct();
    }
    if (t.closest("[data-pm-size]")) { pm.sku = Number(t.closest("[data-pm-size]").dataset.pmSize); return renderProduct(); }
    if (t.closest("[data-pm-qty]")) { pm.qty = Math.min(MAX_QTY, Math.max(1, pm.qty + Number(t.closest("[data-pm-qty]").dataset.pmQty))); return renderProduct(); }
    if (t.closest("[data-img]")) { pm.img = Number(t.closest("[data-img]").dataset.img); return renderProduct(); }
    if (t.closest("[data-fav]")) { toggleFav(pm.p.slug); return; }
    if (t.closest("[data-pm-add]")) {
      if (!pm.sku) {
        const sizes = $(".pm-sizes", dlg);
        sizes.animate([{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(0)" }], { duration: 300 });
        $(".low-note", dlg).textContent = "Selecione um tamanho para continuar";
        return;
      }
      addToCart(pm.sku, pm.qty);
      dlg.close();
      return;
    }
  });
  // zoom acompanhando o ponteiro
  dlg.addEventListener("pointermove", (e) => {
    const main = e.target.closest("#pm-main");
    if (!main || !main.classList.contains("zoom")) return;
    const r = main.getBoundingClientRect();
    main.firstElementChild.style.transformOrigin = `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
  });
  dlg.addEventListener("click", (e) => {
    const main = e.target.closest("#pm-main");
    if (main) main.classList.toggle("zoom");
  });
}

/* ============ TABELA DE MEDIDAS ============ */
function openSizeGuide(key) {
  const g = state.meta.sizeGuides[key];
  if (!g) return;
  $("#size-modal-body").innerHTML = `
    <button class="icon-btn modal-close" data-close aria-label="Fechar"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    <h2 id="sg-title" style="font-family:var(--f-display);font-size:1.35rem;padding-right:40px">${esc(g.title)}</h2>
    <div class="diagram">
      <svg viewBox="0 0 130 120" aria-hidden="true"><path d="M40 10 22 16 4 38l16 12 8-8v70h74V42l8 8 16-12-18-22-18-6c-3 8-10 12-25 12S43 18 40 10z" fill="#141414"/>
        <path d="M30 60h70" stroke="#A9CBE3" stroke-width="2"/><text x="65" y="56" fill="#A9CBE3" font-size="9" text-anchor="middle" font-family="Montserrat">A</text>
        <path d="M112 44v66" stroke="#4F87AD" stroke-width="2"/><text x="120" y="80" fill="#4F87AD" font-size="9" font-family="Montserrat">B</text>
        <path d="M4 38l16 12" stroke="#4F87AD" stroke-width="2" transform="translate(-2 -6)"/><text x="2" y="58" fill="#4F87AD" font-size="9" font-family="Montserrat">C</text></svg>
      <p class="muted">A = largura do tórax, B = altura (comprimento), C = comprimento da manga. Meça uma camiseta que veste bem em você e compare.</p>
    </div>
    <table class="size-table">
      <thead><tr>${g.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${g.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>
    <p class="muted">${esc(g.note)}</p>`;
  $("#size-modal").showModal();
}

/* ============ SACOLA ============ */
function saveCart() { store.set("us.cart", state.cart); renderCartCount(); }

function renderCartCount() {
  const n = state.cart.reduce((s, i) => s + i.qty, 0);
  const b = $("#cart-count");
  b.hidden = n === 0;
  b.textContent = n;
}

export function addToCart(sku, qty = 1, { silent = false } = {}) {
  const line = state.cart.find((i) => i.sku === sku);
  const current = line?.qty ?? 0;
  const next = Math.min(MAX_QTY, current + qty);
  if (next === current) return toast(`Máximo de ${MAX_QTY} unidades por item`, { type: "bad" });
  if (line) line.qty = next; else state.cart.push({ sku, qty: next });
  saveCart();
  bump($("#cart-count"));
  if (!silent) toast("Adicionado à sacola", { action: "Ver sacola", onAction: openCart });
  refreshQuote();
}

let quoteCtrl;
export async function refreshQuote() {
  if (!state.cart.length) { state.quote = null; renderCart(); return null; }
  quoteCtrl?.abort();
  quoteCtrl = new AbortController();
  $("#cart-drawer").setAttribute("aria-busy", "true");
  try {
    const q = await api("/cart/quote", {
      method: "POST", signal: quoteCtrl.signal,
      body: { items: state.cart.map(({ sku, qty }) => ({ sku, qty })), cep: state.cep || undefined, coupon: state.coupon || undefined },
    });
    // remove do carrinho o que não existe mais
    const missing = q.issues.filter((i) => i.type === "missing").map((i) => i.sku);
    if (missing.length) {
      state.cart = state.cart.filter((i) => !missing.includes(i.sku));
      saveCart();
      toast("Um item saiu de linha e foi removido da sacola", { type: "bad" });
    }
    state.quote = q;
    renderCart();
    return q;
  } catch (err) {
    if (err.name === "AbortError") return null;
    if (err instanceof ApiError && err.status === 400 && err.body.fields?.cep) {
      state.cep = ""; store.set("us.cep", "");
      toast("CEP inválido", { type: "bad" });
      return refreshQuote();
    }
    toast(err.message, { type: "bad" });
    return null;
  } finally {
    $("#cart-drawer").removeAttribute("aria-busy");
  }
}

function renderCart() {
  const q = state.quote;
  const lines = $("#cart-lines");
  const foot = $("#cart-foot");
  const free = $("#free-ship");
  renderCartCount(); // contador sempre em dia (inclusive quando a sacola esvazia após a compra)
  if (!state.cart.length) {
    free.innerHTML = "";
    lines.innerHTML = `<div class="drawer-empty"><svg viewBox="0 0 48 32"><use href="#mark-us"/></svg><p><b>Sua sacola está vazia</b></p><p class="muted">Escolha suas peças favoritas e elas aparecem aqui.</p><button class="btn btn-dark" type="button" data-close-drawer data-goto-shop>Ver produtos</button></div>`;
    foot.innerHTML = "";
    return;
  }
  if (!q) return;
  const issueBySku = new Map(q.issues.map((i) => [i.sku, i]));
  const freeLimit = q.freeShippingCents;
  const pct = Math.min(100, ((q.subtotalCents - q.discountCents) / freeLimit) * 100);
  free.innerHTML = q.remainingForFreeCents > 0
    ? `Faltam <b>${brl(q.remainingForFreeCents)}</b> para o frete grátis<div class="progress"><i style="--p:${pct}%"></i></div>`
    : `Você ganhou <b>frete grátis</b> na entrega padrão<div class="progress"><i style="--p:100%"></i></div>`;

  lines.innerHTML = q.lines.map((l) => {
    const issue = issueBySku.get(l.sku);
    return `
    <div class="line ${issue ? "issue" : ""}">
      <img src="${esc(l.image)}" alt="">
      <div>
        <div class="ln-name">${esc(l.name)}</div>
        <div class="ln-meta">${esc(l.color)} / ${esc(l.size)} / ${brl(l.unitPriceCents)}</div>
        <div class="qty sm" role="group" aria-label="Quantidade de ${esc(l.name)}">
          <button type="button" data-line-qty="-1" data-sku="${l.sku}" aria-label="Diminuir">−</button>
          <span>${l.qty}</span>
          <button type="button" data-line-qty="1" data-sku="${l.sku}" aria-label="Aumentar" ${l.qty >= l.maxQty ? "disabled" : ""}>+</button>
        </div>
        ${issue ? `<p class="line-issue">${esc(issue.message)}${issue.maxQty > 0 ? ` <button class="linklike" type="button" data-fix="${l.sku}" data-max="${issue.maxQty}">Ajustar para ${issue.maxQty}</button>` : ""}</p>` : ""}
      </div>
      <div class="line-right"><b>${brl(l.lineTotalCents)}</b><button class="remove-btn" type="button" data-remove="${l.sku}">Remover</button></div>
    </div>`;
  }).join("");

  const ship = q.shipping;
  const padrao = ship?.options.find((o) => o.id === "padrao");
  const total = q.subtotalCents - q.discountCents + (padrao?.priceCents ?? 0);
  const blocked = q.issues.length > 0;
  foot.innerHTML = `
    <form class="mini-form" id="coupon-form" novalidate>
      <label class="sr-only" for="coupon-in">Cupom</label>
      <input id="coupon-in" placeholder="Cupom de desconto" value="${esc(state.coupon)}" maxlength="30" autocomplete="off">
      <button class="btn btn-ghost" type="submit">${state.coupon && q.coupon?.valid ? "Trocar" : "Aplicar"}</button>
    </form>
    ${q.coupon ? `<p class="mini-msg ${q.coupon.valid ? "ok" : "bad"}">${esc(q.coupon.valid ? `Cupom ${q.coupon.code}: ${q.coupon.message}` : q.coupon.message)} ${state.coupon ? `<button class="linklike" type="button" data-coupon-remove>remover</button>` : ""}</p>` : ""}
    <form class="mini-form" id="cep-form" novalidate>
      <label class="sr-only" for="cep-in">CEP</label>
      <input id="cep-in" placeholder="Calcular frete: CEP" inputmode="numeric" value="${esc(state.cep.replace(/(\d{5})(\d{3})/, "$1-$2"))}" maxlength="9" autocomplete="postal-code">
      <button class="btn btn-ghost" type="submit">Calcular</button>
    </form>
    ${ship ? `<div class="ship-opts">${ship.options.map((o) => `<div class="ship-opt"><span>${esc(o.label)} <span class="muted">(${o.days[0]} a ${o.days[1]} dias úteis)</span></span><b>${o.priceCents ? brl(o.priceCents) : "Grátis"}</b></div>`).join("")}</div>` : ""}
    <div class="totals">
      <div><span>Subtotal</span><span>${brl(q.subtotalCents)}</span></div>
      ${q.discountCents ? `<div class="disc"><span>Desconto</span><span>− ${brl(q.discountCents)}</span></div>` : ""}
      <div><span>Frete</span><span>${padrao ? (padrao.priceCents ? brl(padrao.priceCents) : "Grátis") : "Informe o CEP"}</span></div>
      <div class="grand"><span>Total</span><span>${brl(total)}</span></div>
    </div>
    <button class="btn btn-dark btn-block" type="button" id="go-checkout" ${blocked ? "disabled" : ""}>${blocked ? "Ajuste os itens para continuar" : "Finalizar compra"}</button>`;
  renderCartCount();
}

function setQty(sku, qty) {
  const line = state.cart.find((i) => i.sku === sku);
  if (!line) return;
  if (qty <= 0) {
    state.cart = state.cart.filter((i) => i.sku !== sku);
    toast("Item removido", { action: "Desfazer", onAction: () => addToCart(sku, line.qty, { silent: true }) });
  } else line.qty = Math.min(MAX_QTY, qty);
  saveCart();
  refreshQuote();
}

let lastFocus;
let cartWanted = false; // fonte da verdade: o quadro de animação só abre se ainda for desejado
export function openCart() {
  cartWanted = true;
  const d = $("#cart-drawer");
  const bd = $("#drawer-backdrop");
  lastFocus = document.activeElement;
  bd.hidden = false;
  requestAnimationFrame(() => { if (cartWanted) { bd.classList.add("show"); d.classList.add("open"); } });
  d.removeAttribute("inert");
  d.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  setTimeout(() => $(".drawer-head .icon-btn", d).focus(), 50);
  refreshQuote();
}

export function closeCart() {
  cartWanted = false;
  const d = $("#cart-drawer");
  const bd = $("#drawer-backdrop");
  d.classList.remove("open");
  bd.classList.remove("show");
  d.setAttribute("inert", "");
  d.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  setTimeout(() => { if (!cartWanted) bd.hidden = true; }, 300);
  lastFocus?.focus?.();
}

function initCart() {
  $("#open-cart").addEventListener("click", openCart);
  $("#drawer-backdrop").addEventListener("click", closeCart);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#cart-drawer").classList.contains("open")) closeCart(); });
  const d = $("#cart-drawer");
  d.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("[data-close-drawer]")) {
      closeCart();
      if (t.closest("[data-goto-shop]")) $("#loja").scrollIntoView();
      return;
    }
    const q = t.closest("[data-line-qty]");
    if (q) { const sku = Number(q.dataset.sku); const line = state.cart.find((i) => i.sku === sku); return setQty(sku, (line?.qty ?? 0) + Number(q.dataset.lineQty)); }
    if (t.closest("[data-remove]")) return setQty(Number(t.closest("[data-remove]").dataset.remove), 0);
    if (t.closest("[data-fix]")) { const b = t.closest("[data-fix]"); return setQty(Number(b.dataset.fix), Number(b.dataset.max)); }
    if (t.closest("[data-coupon-remove]")) { state.coupon = ""; store.set("us.coupon", ""); return refreshQuote(); }
    if (t.closest("#go-checkout")) { closeCart(); openCheckout(); }
  });
  d.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (e.target.id === "coupon-form") {
      state.coupon = $("#coupon-in").value.trim().toUpperCase();
      store.set("us.coupon", state.coupon);
      const q = await refreshQuote();
      if (q?.coupon) toast(q.coupon.valid ? "Cupom aplicado" : q.coupon.message, { type: q.coupon.valid ? "" : "bad" });
    }
    if (e.target.id === "cep-form") {
      const cep = $("#cep-in").value.replace(/\D/g, "");
      if (cep.length !== 8) return toast("Digite os 8 números do CEP", { type: "bad" });
      state.cep = cep; store.set("us.cep", cep);
      refreshQuote();
    }
  });
  d.addEventListener("input", (e) => {
    if (e.target.id === "cep-in") e.target.value = e.target.value.replace(/\D/g, "").slice(0, 8).replace(/(\d{5})(\d{1,3})$/, "$1-$2");
  });
}

/* ============ RASTREIO / NEWSLETTER ============ */
function renderTrack(o) {
  const flow = ["aguardando_pagamento", "pago", "em_separacao", "enviado", "entregue"];
  const at = new Map(o.timeline.map((e) => [e.status, e.at]));
  const steps = o.status === "cancelado"
    ? [...o.timeline.map((e) => e.status)]
    : flow;
  const date = (iso) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  $("#track-result").innerHTML = `
    <p><b>${esc(o.code)}</b> — ${esc(STATUS[o.status])} <span class="muted">/ ${brl(o.totalCents)}</span></p>
    <ul class="timeline">${steps.map((s) => `<li class="${at.has(s) ? "" : "todo"}">${esc(STATUS[s])}${at.has(s) ? `<time datetime="${esc(at.get(s))}">${date(at.get(s))}</time>` : ""}</li>`).join("")}</ul>
    ${o.tracking ? `<div class="pix-box"><b>Código de rastreio: ${esc(o.tracking.code)}</b><a class="btn btn-dark" href="${esc(o.tracking.url)}" target="_blank" rel="noopener">Rastrear entrega</a></div>` : ""}
    ${o.payment?.pix ? `<p class="muted">Pagamento pendente.${o.payment.automatic ? " Pague com o QR Code abaixo; a confirmação é automática." : " Pix copia e cola:"}</p><div class="pix-box${o.payment.automatic ? " pix-auto" : ""}">${o.payment.automatic && o.payment.pix.qrBase64 ? `<img class="pix-qr" src="data:image/png;base64,${esc(o.payment.pix.qrBase64)}" alt="QR Code do Pix" width="220" height="220">` : ""}<code>${esc(o.payment.pix.copyPaste)}</code><button class="btn btn-dark" type="button" data-copy="${esc(o.payment.pix.copyPaste)}">Copiar código Pix</button></div>` : ""}
    ${o.paymentStatus === "pago" ? `<p class="paid-msg">Pagamento confirmado${o.installments > 1 ? ` (cartão em ${o.installments}x)` : ""}.</p>` : ""}`;
}

function initForms() {
  const track = $("#track-form");
  track.code.addEventListener("input", (e) => {
    let v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (v.startsWith("US")) v = v.slice(2);
    e.target.value = v ? `US-${v.slice(0, 6)}` : "";
  });
  track.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("button[type=submit]", track);
    const out = $("#track-result");
    const code = track.code.value.trim();
    const email = track.email.value.trim();
    if (!/^US-[A-Z0-9]{6}$/.test(code) || !email.includes("@")) { out.innerHTML = `<p class="form-error">Confira o código (US-XXXXXX) e o e-mail.</p>`; return; }
    btn.disabled = true;
    try { renderTrack(await api("/orders/track", { method: "POST", body: { code, email } })); }
    catch (err) { out.innerHTML = `<p class="form-error">${esc(err.status === 404 ? "Não encontramos um pedido com esse código e e-mail." : err.message)}</p>`; }
    finally { btn.disabled = false; }
  });

  const news = $("#news-form");
  news.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $(".form-msg", news);
    const btn = $("button", news);
    btn.disabled = true;
    try {
      await api("/newsletter", { method: "POST", body: { email: news.email.value } });
      msg.className = "form-msg ok"; msg.textContent = "Pronto! Você vai receber os próximos lançamentos.";
      news.reset();
    } catch (err) {
      msg.className = "form-msg bad"; msg.textContent = err.body?.fields?.email || err.message;
    } finally { btn.disabled = false; }
  });
}

/* ============ GLOBAL ============ */
function initGlobal() {
  // brilho dos botões segue o ponteiro
  document.addEventListener("pointermove", (e) => {
    const b = e.target.closest?.(".btn");
    if (!b) return;
    const r = b.getBoundingClientRect();
    b.style.setProperty("--mx", `${e.clientX - r.left}px`);
    b.style.setProperty("--my", `${e.clientY - r.top}px`);
  }, { passive: true });

  document.addEventListener("click", async (e) => {
    const sg = e.target.closest("[data-size-guide]");
    if (sg) { e.preventDefault(); return openSizeGuide(sg.dataset.sizeGuide); }
    const close = e.target.closest("[data-close]");
    if (close) return close.closest("dialog")?.close();
    if (e.target.matches("dialog.modal")) return e.target.close(); // clique fora
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); toast("Código Pix copiado"); }
      catch { toast("Não foi possível copiar. Selecione o código e copie manualmente.", { type: "bad" }); }
    }
    const fo = e.target.closest("[data-fav-open]");
    if (fo) { $("#favs-modal").close(); return openProduct(fo.dataset.favOpen); }
    const fr = e.target.closest("[data-fav-remove]");
    if (fr) { toggleFav(fr.dataset.favRemove); return openFavs(); }
  });

  $("#open-favs").addEventListener("click", openFavs);
  $("#open-search").addEventListener("click", () => {
    $("#loja").scrollIntoView({ behavior: "smooth" });
    setTimeout(() => $("#search").focus({ preventScroll: true }), 450);
  });

  const header = $(".site-header");
  const onScroll = () => header.classList.toggle("scrolled", scrollY > 10);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

function routeFromHash() {
  const m = /^#p\/([a-z0-9-]+)$/.exec(location.hash);
  if (m) openProduct(m[1]);
}

async function boot() {
  initSplit();
  initGlobal();
  initShop();
  initProductModal();
  initCart();
  initForms();
  renderCartCount();
  $("#grid").innerHTML = Array.from({ length: 8 }, () => `<div class="skeleton"></div>`).join("");
  try {
    const [meta, list] = await Promise.all([api("/meta"), api("/products")]);
    state.meta = meta;
    if (meta.announcement) $(".promo-bar p").textContent = meta.announcement;
    state.products = list.products;
    setWhatsappLinks();
    renderCategoryChips();
    renderSizeFilter();
    applyFilters();
    renderFavCount();
    routeFromHash();
    if (state.cart.length) refreshQuote();
  } catch (err) {
    $("#grid").innerHTML = `<div class="empty"><h3>Não conseguimos carregar a loja</h3><p class="muted">${esc(err.message)}</p><button class="btn btn-dark" type="button" id="retry">Tentar de novo</button></div>`;
    $("#retry").addEventListener("click", () => location.reload());
  }
  addEventListener("hashchange", routeFromHash);
}

boot();
