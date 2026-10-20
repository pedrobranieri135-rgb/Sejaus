import {
  $, $$, api, brl, closeModal, confirmBox, debounce, errorToast, esc, frame, LINE, loading, moneyField, openModal,
  parseMoney, pill, showFieldErrors, state, toast, view,
} from "./core.js";

// fotos chegam como { id, sm, lg } (servidor ou Supabase Storage)
const thumb = (img) => img?.sm || "";

/* =================== LISTA =================== */
const listState = { q: "", line: "", status: "" };

export async function productsView() {
  frame("Produtos", `<button class="btn btn-ghost btn-sm" id="bulk-btn">Preços em massa</button><a class="btn btn-dark btn-sm" href="#/produtos/novo">Novo produto</a>`);
  loading();
  let products = await api("/products");
  view().innerHTML = `
    <div class="filters">
      <label class="search-field"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>
        <input type="search" id="p-q" placeholder="Buscar produto ou cor" value="${esc(listState.q)}"></label>
      <select id="p-line" aria-label="Linha"><option value="">Todas as linhas</option><option value="adapt">US Adapt</option><option value="essential">US Essential</option></select>
      <select id="p-status" aria-label="Situação"><option value="">Todas as situações</option><option value="on">Ativos na loja</option><option value="off">Pausados</option><option value="low">Com estoque baixo</option><option value="out">Sem estoque</option><option value="promo">Em promoção</option></select>
    </div>
    <div id="p-table"></div>`;
  $("#p-line").value = listState.line;
  $("#p-status").value = listState.status;

  const render = () => {
    const q = listState.q.toLowerCase();
    const list = products.filter((p) =>
      (!q || `${p.name} ${p.variants.map((v) => v.color).join(" ")}`.toLowerCase().includes(q)) &&
      (!listState.line || p.line === listState.line) &&
      (!listState.status || (listState.status === "on" && p.active) || (listState.status === "off" && !p.active) ||
        (listState.status === "low" && p.lowStock) || (listState.status === "out" && p.outOfStock) || (listState.status === "promo" && p.compareAtCents)));
    $("#p-table").innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>Produto</th><th>Linha</th><th class="num">Preço</th><th class="num">Estoque</th><th class="num">Vendidos</th><th>Na loja</th><th></th></tr></thead>
      <tbody>${list.length ? list.map((p) => `
        <tr>
          <td><a class="cell-product" href="#/produtos/${p.id}" style="text-decoration:none;color:inherit"><img class="thumb" src="${esc(thumb(p.variants[0]?.images[0]))}" alt="" loading="lazy">
            <span><b>${esc(p.name)}</b><span class="muted">${p.variants.length} ${p.variants.length === 1 ? "cor" : "cores"} · ${esc(p.categoryLabel)}</span></span></a></td>
          <td>${esc(LINE[p.line])}</td>
          <td class="num">${p.compareAtCents ? `<s class="muted">${brl(p.compareAtCents)}</s><br>` : ""}<b>${brl(p.priceCents)}</b></td>
          <td class="num">${p.outOfStock ? pill("zero", "Sem estoque") : `${p.stock} un.${p.lowStock ? `<br>${pill("low", "baixo")}` : ""}`}</td>
          <td class="num">${p.sold}</td>
          <td><label class="switch"><input type="checkbox" data-active="${p.id}" ${p.active ? "checked" : ""} aria-label="Mostrar ${esc(p.name)} na loja"><i></i></label></td>
          <td><a class="btn btn-ghost btn-sm" href="#/produtos/${p.id}">Editar</a></td>
        </tr>`).join("") : `<tr><td colspan="7" class="empty-row">Nenhum produto com esses filtros.</td></tr>`}</tbody></table></div>
      <p class="muted">${list.length} de ${products.length} produtos</p>`;
  };
  render();
  $("#p-q").addEventListener("input", debounce((e) => { listState.q = e.target.value; render(); }, 150));
  $("#p-line").addEventListener("change", (e) => { listState.line = e.target.value; render(); });
  $("#p-status").addEventListener("change", (e) => { listState.status = e.target.value; render(); });
  view().addEventListener("change", async (e) => {
    const sw = e.target.closest("[data-active]");
    if (!sw) return;
    try {
      await api(`/products/${sw.dataset.active}/active`, { method: "PATCH", body: { active: sw.checked } });
      const p = products.find((x) => x.id === Number(sw.dataset.active));
      p.active = sw.checked;
      toast(sw.checked ? `${p.name} voltou para a loja` : `${p.name} foi pausado`);
    } catch (err) { sw.checked = !sw.checked; errorToast(err); }
  });
  $("#bulk-btn").addEventListener("click", () => bulkModal(async () => { products = await api("/products"); render(); }));
}

/* =================== PREÇOS EM MASSA =================== */
function bulkModal(onDone) {
  const cats = state.meta.categories;
  const body = openModal(`
    <h2>Preços em massa</h2>
    <form id="bulk-form" class="form-section" novalidate>
      <div class="fgrid">
        <label class="field s6"><span>O que fazer</span><select name="action">
          <option value="promo">Criar promoção (mostra o preço antigo riscado)</option>
          <option value="clear_promo">Encerrar promoção (volta ao preço original)</option>
          <option value="increase">Reajustar para cima</option>
          <option value="decrease">Reduzir preço (sem mostrar "de/por")</option></select></label>
        <label class="field s2" data-pct><span>Porcentagem</span><input name="percent" type="number" min="1" max="90" step="1" value="10"></label>
        <label class="field s2"><span>Linha</span><select name="line"><option value="">Todas</option><option value="adapt">US Adapt</option><option value="essential">US Essential</option></select></label>
        <label class="field s2"><span>Categoria</span><select name="category"><option value="">Todas</option>${Object.entries(cats).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></label>
        <label class="check s6"><input type="checkbox" name="round" checked><span>Arredondar para final ,90<small>Ex.: R$ 79,20 vira R$ 79,90</small></span></label>
      </div>
      <div id="bulk-preview" class="diff-table"></div>
      <div class="actions-row"><button class="btn btn-ghost" type="button" data-preview>Ver prévia</button><button class="btn btn-dark" type="submit" disabled>Aplicar</button></div>
    </form>`);
  const f = $("#bulk-form", body);
  const payload = () => ({
    action: f.action.value, percent: Number(f.percent.value || 0), line: f.line.value, category: f.category.value, rounding: f.round.checked ? "90" : "none",
  });
  const preview = async () => {
    $("[data-pct]", f).hidden = f.action.value === "clear_promo";
    try {
      const r = await api("/products/bulk-price?preview=1", { method: "POST", body: payload() });
      $("#bulk-preview", f).innerHTML = r.count ? `<div class="table-wrap"><table class="table"><thead><tr><th>Produto</th><th class="num">Hoje</th><th class="num">Novo</th><th class="num">Preço "de"</th></tr></thead>
        <tbody>${r.changes.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${brl(c.from)}</td><td class="num strong">${brl(c.to)}</td><td class="num">${c.compareAt ? brl(c.compareAt) : "—"}</td></tr>`).join("")}</tbody></table></div>
        <p class="muted">${r.count} produto(s) serão alterados.</p>` : `<p class="muted">Nenhum produto muda com essa combinação.</p>`;
      $("[type=submit]", f).disabled = !r.count;
    } catch (err) { $("#bulk-preview", f).innerHTML = `<p class="form-error">${esc(err.body?.fields ? Object.values(err.body.fields)[0] : err.message)}</p>`; $("[type=submit]", f).disabled = true; }
  };
  f.addEventListener("change", preview);
  $("[data-preview]", f).addEventListener("click", preview);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!(await confirmBox("Aplicar as novas etiquetas de preço agora? A loja muda na hora."))) return bulkModal(onDone);
    try {
      const r = await api("/products/bulk-price", { method: "POST", body: payload() });
      toast(`${r.count} preço(s) atualizado(s)`);
      closeModal();
      onDone();
    } catch (err) { errorToast(err); }
  });
  preview();
}

/* =================== EDITOR =================== */
const PRESETS = { "P ao XGG": ["P", "M", "G", "GG", "XGG"], "P ao G": ["P", "M", "G"], "Único": ["Único"], "P/M e G/GG": ["P/M", "G/GG"] };
let ed = null;

const blank = () => ({
  name: "", slug: "", line: "essential", category: "conjuntos", priceCents: null, compareAtCents: null, description: "", fabric: "",
  features: [], badges: [], sizeGuide: null, active: true,
  variants: [{ color: "", hex: "#141414", images: [], skus: PRESETS["P ao G"].map((size) => ({ size, qty: 0 })) }],
});

export async function productEditView(params) {
  const isNew = params.id === "novo";
  frame(isNew ? "Novo produto" : "Editar produto", `<a class="btn btn-ghost btn-sm" href="#/produtos">Voltar</a>`);
  loading();
  ed = isNew ? blank() : await api(`/products/${encodeURIComponent(params.id)}`);
  ed._isNew = isNew;
  renderEditor();
}

function renderEditor() {
  const p = ed;
  const cats = state.meta.categories;
  view().innerHTML = `
  <form id="product-form" novalidate>
    <div class="editor">
      <div style="display:grid;gap:20px">
        <section class="form-section"><h2>Informações</h2>
          <div class="fgrid">
            <label class="field s6"><span>Nome do produto</span><input name="name" value="${esc(p.name)}" maxlength="120" required placeholder="Ex.: Conjunto Top e Legging"></label>
            <label class="field s6"><span>Descrição</span><textarea name="description" maxlength="2000" placeholder="Tecido, caimento, diferenciais…">${esc(p.description)}</textarea></label>
            <label class="field s3"><span>Composição do tecido <span class="hint">(opcional)</span></span><input name="fabric" value="${esc(p.fabric || "")}" maxlength="120" placeholder="90% Poliamida | 10% Elastano"></label>
            <label class="field s3"><span>Endereço na loja <span class="hint">(gerado pelo nome se vazio)</span></span><input name="slug" value="${esc(p.slug || "")}" maxlength="120" placeholder="conjunto-top-legging"></label>
            <div class="field s6" data-field="features"><span>Destaques <span class="hint">(Enter para adicionar, até 8)</span></span>${chips("features", p.features, "Ex.: Zero transparência")}</div>
          </div>
        </section>

        <section class="form-section" data-field="variants"><h2>Cores, fotos e estoque <span class="hint">— a 1ª foto de cada cor é a capa</span></h2>
          <div id="variants" style="display:grid;gap:14px">${p.variants.map(variantHTML).join("")}</div>
          <button class="btn btn-ghost btn-sm" type="button" data-add-variant style="justify-self:start">+ Adicionar cor</button>
        </section>
      </div>

      <div class="editor-side">
        <section class="form-section"><h2>Venda</h2>
          <label class="switch"><input type="checkbox" name="active" ${p.active ? "checked" : ""}><i></i> Visível na loja</label>
          <div class="field"><span>Preço de venda</span><span class="money-input"><input name="priceCents" inputmode="decimal" value="${esc(moneyField(p.priceCents))}" placeholder="0,00" required></span></div>
          <div class="field"><span>Preço "de" <span class="hint">(opcional, aparece riscado)</span></span><span class="money-input"><input name="compareAtCents" inputmode="decimal" value="${esc(moneyField(p.compareAtCents))}" placeholder="sem promoção"></span></div>
          <p class="preview-price" id="price-preview"></p>
        </section>
        <section class="form-section"><h2>Organização</h2>
          <label class="field"><span>Linha</span><select name="line"><option value="adapt" ${p.line === "adapt" ? "selected" : ""}>US Adapt (masculino)</option><option value="essential" ${p.line === "essential" ? "selected" : ""}>US Essential (feminino)</option></select></label>
          <label class="field"><span>Categoria</span><select name="category">${Object.entries(cats).map(([k, l]) => `<option value="${k}" ${p.category === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
          <div class="field" data-field="badges"><span>Selos <span class="hint">(até 3, ex.: Novo)</span></span>${chips("badges", p.badges, "Novo, Queridinho…")}</div>
          <label class="check"><input type="checkbox" name="sizeGuide" ${p.sizeGuide ? "checked" : ""}><span>Mostrar tabela de medidas da camiseta Adapt</span></label>
        </section>
        ${!p._isNew ? `<section class="form-section"><h2>Desempenho</h2><p class="muted">${p.sold} peça(s) vendida(s) · ${p.stock} em estoque</p>
          <a class="muted" href="/#p/${esc(p.slug)}" target="_blank" rel="noopener">Ver na loja</a>
          <button class="btn btn-ghost btn-sm" type="button" data-delete style="color:var(--danger)">Excluir produto</button></section>` : ""}
      </div>
    </div>
    <div class="sticky-save" style="margin-top:20px"><span class="muted" id="save-state">${p._isNew ? "Produto novo" : "Alterações não salvas aparecem aqui"}</span>
      <a class="btn btn-ghost" href="#/produtos">Cancelar</a><button class="btn btn-dark" type="submit">${p._isNew ? "Criar produto" : "Salvar alterações"}</button></div>
  </form>`;
  bindEditor();
  updatePricePreview();
}

function chips(name, values, placeholder) {
  return `<div class="chips-input" data-chips="${name}">${values.map((v, i) => `<span>${esc(v)}<button type="button" data-chip-remove="${i}" aria-label="Remover ${esc(v)}">×</button></span>`).join("")}
    <input data-chip-input="${name}" placeholder="${esc(placeholder)}" maxlength="${name === "badges" ? 20 : 40}" aria-label="${name === "badges" ? "Adicionar selo" : "Adicionar destaque"}"></div>`;
}

function variantHTML(v, vi) {
  return `
  <div class="variant" data-vi="${vi}">
    <div class="variant-head">
      <label class="field"><span>Cor</span><input type="color" class="color-input" data-v="hex" value="${esc(v.hex)}" aria-label="Tom da cor"></label>
      <label class="field"><span>Nome da cor</span><input data-v="color" value="${esc(v.color)}" maxlength="40" placeholder="Ex.: Preto"></label>
      <div class="field"><span>Total em estoque</span><input value="${v.skus.reduce((s, k) => s + Number(k.qty || 0), 0)} un." disabled></div>
      ${ed.variants.length > 1 ? `<button class="btn btn-ghost btn-sm" type="button" data-remove-variant>Remover cor</button>` : "<span></span>"}
    </div>
    <div class="images" data-images>
      ${v.images.map((img, i) => `<div class="img-tile">${i === 0 ? `<span class="main-tag">Capa</span>` : ""}<img src="${esc(thumb(img))}" alt="Foto ${i + 1}">
        <div class="tile-actions"><button type="button" data-img-left="${i}" aria-label="Mover para a esquerda" ${i === 0 ? "disabled" : ""}>‹</button><button type="button" data-img-remove="${i}" aria-label="Remover foto">×</button><button type="button" data-img-right="${i}" aria-label="Mover para a direita" ${i === v.images.length - 1 ? "disabled" : ""}>›</button></div></div>`).join("")}
      ${v.images.length < 8 ? `<label class="img-add" data-drop>+ Fotos<br>JPG/PNG<input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden data-upload></label>` : ""}
    </div>
    <div>
      <div class="size-presets"><span class="muted">Grade rápida:</span>${Object.keys(PRESETS).map((k) => `<button type="button" data-preset="${esc(k)}">${esc(k)}</button>`).join("")}</div>
      <div class="sizes-table" style="margin-top:10px">
        <div class="size-row muted"><span>Tamanho</span><span>Quantidade</span><span></span></div>
        ${v.skus.map((s, si) => `<div class="size-row" data-si="${si}"><input data-s="size" value="${esc(s.size)}" maxlength="10" aria-label="Tamanho"><input data-s="qty" type="number" min="0" max="100000" value="${Number(s.qty)}" aria-label="Quantidade do tamanho ${esc(s.size)}">
          <button class="icon-btn" type="button" data-remove-size aria-label="Remover tamanho ${esc(s.size)}" ${v.skus.length <= 1 ? "disabled" : ""}><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join("")}
      </div>
      <button class="linklike" type="button" data-add-size style="margin-top:8px">+ tamanho</button>
    </div>
  </div>`;
}

function readEditor() {
  const f = $("#product-form");
  ed.name = f.name.value; ed.slug = f.slug.value; ed.description = f.description.value; ed.fabric = f.fabric.value;
  ed.active = f.active.checked; ed.line = f.line.value; ed.category = f.category.value; ed.sizeGuide = f.sizeGuide.checked ? "adapt" : null;
  ed.priceCents = parseMoney(f.priceCents.value); ed.compareAtCents = parseMoney(f.compareAtCents.value);
  $$(".variant", f).forEach((el) => {
    const v = ed.variants[Number(el.dataset.vi)];
    v.color = $("[data-v=color]", el).value; v.hex = $("[data-v=hex]", el).value;
    $$(".size-row[data-si]", el).forEach((row) => {
      const s = v.skus[Number(row.dataset.si)];
      s.size = $("[data-s=size]", row).value.trim(); s.qty = Number($("[data-s=qty]", row).value || 0);
    });
  });
}

function rerender() { readEditor(); const y = scrollY; renderEditor(); scrollTo(0, y); markDirty(); }
function markDirty() { const s = $("#save-state"); if (s) s.textContent = "Alterações não salvas"; }

function updatePricePreview() {
  const f = $("#product-form");
  const price = parseMoney(f.priceCents.value);
  const cmp = parseMoney(f.compareAtCents.value);
  const el = $("#price-preview");
  if (!price) { el.textContent = ""; return; }
  el.innerHTML = cmp && cmp > price
    ? `Na loja: <s>${brl(cmp)}</s><b>${brl(price)}</b> · ${Math.round((1 - price / cmp) * 100)}% OFF`
    : `Na loja: <b>${brl(price)}</b> ou 3x de ${brl(Math.ceil(price / 3))}`;
}

const MAX_UPLOAD = 3.8 * 1024 * 1024; // a Vercel aceita até 4,5 MB por requisição
const MAX_SIDE = 2000; // o site usa no máximo 1000 px; 2000 dá folga para telas retina

/**
 * Reduz a foto no navegador (lado maior até 2000 px, JPEG 88%) quando ela é grande demais.
 * Foto de celular com 8–12 MB vira ~600 KB sem perda visível. Fotos já leves seguem intactas.
 */
async function shrinkIfNeeded(file) {
  if (file.size <= MAX_UPLOAD && file.size <= 1.5 * 1024 * 1024) return file;
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { return file; } // formato que o navegador não abre: o servidor responde com a mensagem certa
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // PNG transparente vira fundo branco (o JPEG não tem transparência)
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  for (const q of [0.88, 0.8, 0.7]) {
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", q));
    if (blob && blob.size <= MAX_UPLOAD) return blob;
  }
  return null;
}

async function uploadFiles(vi, files) {
  const v = ed.variants[vi];
  const list = [...files].slice(0, 8 - v.images.length);
  if (!list.length) return;
  readEditor();
  toast(`Enviando ${list.length} foto(s)…`);
  for (const original of list) {
    if (original.size > 40 * 1024 * 1024) { toast(`${original.name}: arquivo grande demais (máx. 40 MB)`, { type: "bad" }); continue; }
    const file = await shrinkIfNeeded(original);
    if (!file) { toast(`${original.name}: não foi possível reduzir a foto`, { type: "bad" }); continue; }
    try {
      const r = await api("/uploads", { method: "POST", raw: file, contentType: file.type || "image/jpeg" });
      v.images.push(r); // { id, sm, lg }
    } catch (err) { errorToast(err); }
  }
  rerender();
}

function bindEditor() {
  const f = $("#product-form");
  f.addEventListener("input", (e) => {
    markDirty();
    if (e.target.name === "priceCents" || e.target.name === "compareAtCents") updatePricePreview();
  });
  f.addEventListener("keydown", (e) => {
    const ci = e.target.closest("[data-chip-input]");
    if (ci && (e.key === "Enter" || e.key === ",")) {
      e.preventDefault();
      const val = ci.value.trim().replace(/,$/, "");
      const key = ci.dataset.chipInput;
      const max = key === "badges" ? 3 : 8;
      if (val && ed[key].length < max && !ed[key].includes(val)) { ed[key].push(val); rerender(); $(`[data-chip-input="${key}"]`).focus(); }
    }
  });
  f.addEventListener("change", (e) => {
    const up = e.target.closest("[data-upload]");
    if (up) uploadFiles(Number(up.closest(".variant").dataset.vi), up.files);
  });
  f.addEventListener("dragover", (e) => { const d = e.target.closest("[data-drop]"); if (d) { e.preventDefault(); d.classList.add("drag"); } });
  f.addEventListener("dragleave", (e) => e.target.closest("[data-drop]")?.classList.remove("drag"));
  f.addEventListener("drop", (e) => {
    const d = e.target.closest("[data-drop]");
    if (!d) return;
    e.preventDefault();
    uploadFiles(Number(d.closest(".variant").dataset.vi), e.dataTransfer.files);
  });
  f.addEventListener("click", async (e) => {
    const t = e.target;
    const vEl = t.closest(".variant");
    const vi = vEl ? Number(vEl.dataset.vi) : -1;
    const chipRm = t.closest("[data-chip-remove]");
    if (chipRm) { readEditor(); ed[chipRm.closest("[data-chips]").dataset.chips].splice(Number(chipRm.dataset.chipRemove), 1); return rerender(); }
    if (t.closest("[data-add-variant]")) { readEditor(); ed.variants.push({ color: "", hex: "#888888", images: [], skus: ed.variants[0].skus.map((s) => ({ size: s.size, qty: 0 })) }); return rerender(); }
    if (t.closest("[data-remove-variant]")) {
      if (!(await confirmBox(`Remover a cor "${ed.variants[vi].color || "sem nome"}"? Se ela já tem pedidos, o sistema vai pedir para zerar o estoque em vez disso.`, { confirm: "Remover", danger: true }))) return;
      readEditor(); ed.variants.splice(vi, 1); return rerender();
    }
    if (t.closest("[data-add-size]")) { readEditor(); ed.variants[vi].skus.push({ size: "", qty: 0 }); rerender(); $$(`.variant[data-vi="${vi}"] [data-s=size]`).at(-1)?.focus(); return; }
    if (t.closest("[data-remove-size]")) { readEditor(); ed.variants[vi].skus.splice(Number(t.closest("[data-si]").dataset.si), 1); return rerender(); }
    const preset = t.closest("[data-preset]");
    if (preset) {
      readEditor();
      const v = ed.variants[vi];
      const old = new Map(v.skus.map((s) => [s.size, s]));
      v.skus = PRESETS[preset.dataset.preset].map((size) => old.get(size) ?? { size, qty: 0 });
      return rerender();
    }
    const move = (from, to) => { readEditor(); const im = ed.variants[vi].images; [im[from], im[to]] = [im[to], im[from]]; rerender(); };
    if (t.closest("[data-img-left]")) { const i = Number(t.closest("[data-img-left]").dataset.imgLeft); return move(i, i - 1); }
    if (t.closest("[data-img-right]")) { const i = Number(t.closest("[data-img-right]").dataset.imgRight); return move(i, i + 1); }
    if (t.closest("[data-img-remove]")) { readEditor(); ed.variants[vi].images.splice(Number(t.closest("[data-img-remove]").dataset.imgRemove), 1); return rerender(); }
    if (t.closest("[data-delete]")) {
      if (!(await confirmBox(`Excluir "${ed.name}"? Se já tiver pedidos, ele só será pausado para manter o histórico.`, { confirm: "Excluir", danger: true }))) return;
      try {
        const r = await api(`/products/${ed.id}`, { method: "DELETE" });
        toast(r.deleted ? "Produto excluído" : "Produto tem pedidos: foi pausado e saiu da loja");
        location.hash = "#/produtos";
      } catch (err) { errorToast(err); }
    }
  });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    readEditor();
    const btn = $("[type=submit]", f);
    if (ed.priceCents == null || Number.isNaN(ed.priceCents)) {
      showFieldErrors(f, { body: { fields: { priceCents: "Informe o preço" } } });
      return;
    }
    const body = {
      name: ed.name, slug: ed.slug || "", line: ed.line, category: ed.category, priceCents: ed.priceCents,
      compareAtCents: Number.isNaN(ed.compareAtCents) ? null : ed.compareAtCents, description: ed.description, fabric: ed.fabric || null,
      features: ed.features, badges: ed.badges, sizeGuide: ed.sizeGuide, active: ed.active,
      variants: ed.variants.map((v) => ({ ...(v.id ? { id: v.id } : {}), color: v.color, hex: v.hex, images: v.images.map((img) => img.id),
        skus: v.skus.map((s) => ({ ...(s.id ? { id: s.id } : {}), size: s.size, qty: s.qty })) })),
    };
    btn.disabled = true;
    try {
      const saved = await api(ed._isNew ? "/products" : `/products/${ed.id}`, { method: ed._isNew ? "POST" : "PUT", body });
      toast(ed._isNew ? "Produto criado e publicado" : "Alterações salvas");
      if (ed._isNew) { location.hash = `#/produtos/${saved.id}`; return; }
      ed = saved; ed._isNew = false;
      renderEditor();
      $("#save-state").textContent = "Tudo salvo";
    } catch (err) {
      btn.disabled = false;
      if (!showFieldErrors(f, err) || err.body?.fields?.variants || Object.keys(err.body?.fields || {}).some((k) => k.startsWith("variants"))) errorToast(err);
    }
  });
}

/* =================== ESTOQUE =================== */
export async function stockView(params) {
  frame("Estoque");
  loading();
  let rows = await api("/stock");
  const st = { q: "", f: params.f || "" };
  view().innerHTML = `
    <div class="filters">
      <label class="search-field"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg><input type="search" id="s-q" placeholder="Produto ou cor"></label>
      <div class="seg" id="s-seg"><button type="button" data-f="" aria-pressed="true">Todos</button><button type="button" data-f="low">Baixo (1–2)</button><button type="button" data-f="zero">Zerados</button></div>
    </div>
    <p class="muted">Digite a nova quantidade e saia do campo (ou Enter) para salvar.</p>
    <div id="s-table"></div>`;
  const render = () => {
    const q = st.q.toLowerCase();
    const list = rows.filter((r) => (!q || `${r.name} ${r.color}`.toLowerCase().includes(q)) && (!st.f || (st.f === "low" ? r.qty > 0 && r.qty <= 2 : r.qty === 0)));
    $$("#s-seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.f === st.f)));
    $("#s-table").innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>Produto</th><th>Cor</th><th>Tamanho</th><th>Situação</th><th class="num">Quantidade</th></tr></thead>
      <tbody>${list.length ? list.slice(0, 600).map((r) => `<tr><td><a href="#/produtos/${r.productId}">${esc(r.name)}</a>${r.active ? "" : ` ${pill("off", "pausado")}`}</td><td>${esc(r.color)}</td><td class="strong">${esc(r.size)}</td>
        <td>${r.qty === 0 ? pill("zero", "Zerado") : r.qty <= 2 ? pill("low", "Baixo") : pill("on", "Ok")}</td>
        <td class="num"><input type="number" min="0" max="100000" value="${r.qty}" data-sku="${r.sku}" style="width:90px;height:36px;border:1px solid var(--line);border-radius:8px;padding:0 10px;text-align:right" aria-label="Quantidade ${esc(r.name)} ${esc(r.color)} ${esc(r.size)}"></td></tr>`).join("")
        : `<tr><td colspan="5" class="empty-row">Nada por aqui.</td></tr>`}</tbody></table></div>`;
  };
  render();
  $("#s-q").addEventListener("input", debounce((e) => { st.q = e.target.value; render(); }, 150));
  $("#s-seg").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (b) { st.f = b.dataset.f; render(); } });
  view().addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("[data-sku]")) e.target.blur(); });
  view().addEventListener("change", async (e) => {
    const input = e.target.closest("[data-sku]");
    if (!input) return;
    const qty = Number(input.value);
    const row = rows.find((r) => r.sku === Number(input.dataset.sku));
    if (!Number.isInteger(qty) || qty < 0) { input.value = row.qty; return toast("Quantidade inválida", { type: "bad" }); }
    try {
      await api(`/stock/${input.dataset.sku}`, { method: "PATCH", body: { qty } });
      row.qty = qty;
      toast(`${row.name} ${row.color} ${row.size}: ${qty} un.`);
      const statusCell = input.closest("tr").children[3];
      statusCell.innerHTML = qty === 0 ? pill("zero", "Zerado") : qty <= 2 ? pill("low", "Baixo") : pill("on", "Ok");
    } catch (err) { input.value = row.qty; errorToast(err); }
  });
}
