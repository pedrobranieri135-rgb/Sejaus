// Gráficos em SVG puro: uma série, uma cor (--chart), grade recessiva, dica ao passar o mouse.
import { brl, esc } from "../lib.js";
import { compactBRL, fmtDay } from "./core.js";

const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};

/**
 * Faturamento por dia. Até 31 pontos → colunas; acima → linha com área.
 * data: [{ date, revenueCents, orders }]
 */
export function timeChart(el, data, { height = 240 } = {}) {
  if (!data.length || data.every((d) => !d.revenueCents)) {
    el.innerHTML = `<div class="chart-empty">Sem vendas pagas neste período.</div>`;
    return;
  }
  const W = Math.max(320, el.clientWidth || 640);
  const H = height;
  const pad = { l: 56, r: 12, t: 12, b: 28 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = niceMax(Math.max(...data.map((d) => d.revenueCents)));
  const y = (v) => pad.t + ih - (v / max) * ih;
  const step = iw / data.length;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
  const labelEvery = Math.ceil(data.length / Math.floor(iw / 56));
  const asColumns = data.length <= 31;
  const bw = Math.min(24, step * 0.62);

  let marks = "";
  if (asColumns) {
    marks = data.map((d, i) => {
      const h = Math.max(d.revenueCents ? 2 : 0, ih - (y(d.revenueCents) - pad.t));
      const x = pad.l + i * step + (step - bw) / 2;
      const top = pad.t + ih - h;
      const r = Math.min(4, h);
      // topo arredondado (4px), base reta
      return h ? `<path class="bar" data-i="${i}" d="M${x},${pad.t + ih}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${pad.t + ih}Z"/>` : "";
    }).join("");
  } else {
    const pts = data.map((d, i) => [pad.l + i * step + step / 2, y(d.revenueCents)]);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
    marks = `<path class="area" d="${line}L${pts.at(-1)[0]},${pad.t + ih}L${pts[0][0]},${pad.t + ih}Z"/><path class="line" d="${line}"/>
      <circle class="dot" r="4" cx="${pts.at(-1)[0]}" cy="${pts.at(-1)[1]}"/>`;
  }

  el.innerHTML = `
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Faturamento por dia">
        ${ticks.map((t) => `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis-text" x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${esc(compactBRL(t))}</text>`).join("")}
        ${data.map((d, i) => (i % labelEvery === 0 ? `<text class="axis-text" x="${pad.l + i * step + step / 2}" y="${H - 8}" text-anchor="middle">${fmtDay(d.date)}</text>` : "")).join("")}
        ${marks}
        <line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/>
        ${data.map((d, i) => `<rect class="hit" data-i="${i}" x="${pad.l + i * step}" y="${pad.t}" width="${step}" height="${ih}"/>`).join("")}
      </svg>
      <div class="chart-tip" role="status"></div>
    </div>`;

  const svg = el.querySelector("svg");
  const tip = el.querySelector(".chart-tip");
  const cross = el.querySelector(".cross");
  const bars = [...el.querySelectorAll(".bar")];
  const show = (i) => {
    const d = data[i];
    const cx = pad.l + i * step + step / 2;
    const scale = svg.getBoundingClientRect().width / W;
    tip.innerHTML = `${fmtDay(d.date)}<b>${brl(d.revenueCents)}</b>${d.orders} ${d.orders === 1 ? "pedido" : "pedidos"}`;
    tip.style.left = `${cx * scale}px`;
    tip.style.top = `${y(d.revenueCents) * scale}px`;
    tip.classList.add("show");
    if (asColumns) bars.forEach((b) => b.classList.toggle("dim", Number(b.dataset.i) !== i));
    else { cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible"); }
  };
  const hide = () => { tip.classList.remove("show"); bars.forEach((b) => b.classList.remove("dim")); cross.setAttribute("visibility", "hidden"); };
  svg.addEventListener("pointermove", (e) => { const h = e.target.closest(".hit"); if (h) show(Number(h.dataset.i)); });
  svg.addEventListener("pointerleave", hide);
}

/** Tabela equivalente (acessível) para o gráfico de tempo. */
export function timeTable(data) {
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Dia</th><th class="num">Pedidos pagos</th><th class="num">Faturamento</th></tr></thead>
    <tbody>${data.map((d) => `<tr><td>${fmtDay(d.date)}</td><td class="num">${d.orders}</td><td class="num">${brl(d.revenueCents)}</td></tr>`).join("")}</tbody></table></div>`;
}

/** Barras horizontais com rótulo e valor na ponta. rows: [{ label, value, display }] */
export function hbars(rows, { empty = "Sem dados no período." } = {}) {
  if (!rows.length) return `<div class="chart-empty">${esc(empty)}</div>`;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `<div class="hbars">${rows.map((r) => `
    <div class="hbar" title="${esc(r.label)}: ${esc(r.display)}">
      <span class="hbar-label">${esc(r.label)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="--w:${(r.value / max) * 100}%"></span></span>
      <span class="hbar-val">${esc(r.display)}</span>
    </div>`).join("")}</div>`;
}
