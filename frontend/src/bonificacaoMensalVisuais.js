// Componentes visuais reutilizáveis da Bonificação Mensal — gauge
// semicircular, sparkline e "escada" de faixas. SVG/HTML puro, sem
// dependência nova (leve o bastante pra ter vários na mesma tela sem
// travar, ao contrário de várias instâncias de Chart.js).
import { escapeHtml } from "./utils.js";

// ---------------------------------------------------------------------------
// GAUGE SEMICIRCULAR — usado por Bebidas/Adicionais/Diversos/CMV.
// Técnica: path com pathLength=100 + stroke-dasharray/offset (mesma lógica
// de um "circular progress" de CSS, aplicada a um arco aberto). A barra de
// preenchimento anima via transição CSS de stroke-dashoffset (item 18).
// ---------------------------------------------------------------------------
function pontoNoArco(cx, cy, r, fracao) {
  const ang = ((180 - fracao * 180) * Math.PI) / 180;
  return { x: cx + r * Math.cos(ang), y: cy - r * Math.sin(ang) };
}

/**
 * @param {{valorAtual:number|null, min:number, max:number, marcos:Array<{fracao:number,titulo:string,atingido:boolean}>, cor:string, tamanho?:number}} p
 */
export function gaugeSvg({ valorAtual, min, max, marcos = [], cor, tamanho = 116 }) {
  const cx = tamanho / 2, cy = tamanho * 0.58, r = tamanho * 0.4;
  const p0 = pontoNoArco(cx, cy, r, 0), p1 = pontoNoArco(cx, cy, r, 1);
  const trilho = `M ${p0.x} ${p0.y} A ${r} ${r} 0 0 1 ${p1.x} ${p1.y}`;
  const fracaoAtual = valorAtual == null || max === min ? 0 : Math.max(0, Math.min(1, (valorAtual - min) / (max - min)));

  const marcosSvg = marcos.map((m) => {
    const f = Math.max(0, Math.min(1, m.fracao));
    const pInt = pontoNoArco(cx, cy, r - 9, f), pExt = pontoNoArco(cx, cy, r + 9, f);
    return `<line x1="${pInt.x.toFixed(1)}" y1="${pInt.y.toFixed(1)}" x2="${pExt.x.toFixed(1)}" y2="${pExt.y.toFixed(1)}"
      class="bm-gauge-marco${m.atingido ? " atingido" : ""}" stroke-width="2"><title>${escapeHtml(m.titulo)}</title></line>`;
  }).join("");

  return `<svg viewBox="0 0 ${tamanho} ${tamanho * 0.66}" class="bm-gauge" role="img" aria-label="Progresso">
    <path d="${trilho}" class="bm-gauge-trilho" pathLength="100" fill="none" stroke-linecap="round"></path>
    <path d="${trilho}" class="bm-gauge-fill" pathLength="100" stroke-dasharray="100" stroke-dashoffset="${(100 - fracaoAtual * 100).toFixed(2)}"
      fill="none" stroke-linecap="round" style="stroke:${cor}"></path>
    ${marcosSvg}
  </svg>`;
}

// ---------------------------------------------------------------------------
// SPARKLINE — mini gráfico de tendência inline (item 14). Sem Chart.js: são
// muitos, pequenos, e SVG puro é bem mais leve que várias instâncias canvas.
// ---------------------------------------------------------------------------
/** @param {Array<number|null|undefined>} valores @param {{largura?:number, altura?:number, cor?:string}} [opts] */
export function sparklineSvg(valores, { largura = 84, altura = 26, cor = "#0f8a4c" } = {}) {
  const pontos = (valores || []).map((v, i) => (v == null ? null : { i, v: Number(v) }));
  const validos = pontos.filter(Boolean);
  if (validos.length < 2) return "";
  const min = Math.min(...validos.map((p) => p.v)), max = Math.max(...validos.map((p) => p.v));
  const n = valores.length - 1 || 1;
  const escY = (v) => (max === min ? altura / 2 : altura - 3 - ((v - min) / (max - min)) * (altura - 6));
  const coordsPorPonto = validos.map((p) => `${(p.i / n) * largura},${escY(p.v).toFixed(1)}`);
  const ultimo = validos[validos.length - 1];
  return `<svg viewBox="0 0 ${largura} ${altura}" class="bm-spark" role="img" aria-label="Tendência">
    <polyline points="${coordsPorPonto.join(" ")}" fill="none" stroke="${cor}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"></polyline>
    <circle cx="${(ultimo.i / n) * largura}" cy="${escY(ultimo.v).toFixed(1)}" r="2.25" fill="${cor}"></circle>
  </svg>`;
}

/** Seta de tendência simples comparando a 1ª e a 2ª metade de uma série (item 12). */
export function tendencia(valores, { menorMelhor = false } = {}) {
  const validos = (valores || []).filter((v) => v != null);
  if (validos.length < 4) return null;
  const metade = Math.floor(validos.length / 2);
  const media = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const antes = media(validos.slice(0, metade)), depois = media(validos.slice(metade));
  const diff = depois - antes;
  if (Math.abs(diff) < 0.01) return { direcao: "estavel", label: "estável", icone: "→" };
  const melhorando = menorMelhor ? diff < 0 : diff > 0;
  return melhorando
    ? { direcao: "melhorando", label: "melhorando", icone: "↗" }
    : { direcao: "piorando", label: "piorando", icone: "↘" };
}

// ---------------------------------------------------------------------------
// ESCADA DE FAIXAS — progressão visual das faixas de um indicador (item 15),
// reaproveitada em miniatura nas "Próximas conquistas" (item 9).
// ---------------------------------------------------------------------------
/**
 * @param {{faixas:Array<{ordem:number,tipo:string,valorMin:number|null,valorMax:number|null,bonus:number|null}>, faixaAtualOrdem:number|null, fmt:(v:number)=>string}} p
 */
export function escadaFaixas({ faixas, faixaAtualOrdem, fmt }) {
  if (!faixas?.length) return "";
  const alvoLabel = (f) => {
    if (f.tipo === "intervalo") return `${fmt(f.valorMin)} – ${fmt(f.valorMax)}`;
    if (f.tipo === "limite_maximo") return `até ${fmt(f.valorMax)}`;
    return `${fmt(f.valorMin)}+`;
  };
  return `<div class="bm-escada">${faixas.map((f, i) => {
    const estado = faixaAtualOrdem == null ? "futura" : f.ordem < faixaAtualOrdem ? "concluida" : f.ordem === faixaAtualOrdem ? "atual" : "futura";
    return `<div class="bm-escada-passo ${estado}">
        <div class="bm-escada-bolha">${estado === "concluida" ? "✓" : f.ordem}</div>
        <div class="bm-escada-txt"><b>${escapeHtml(alvoLabel(f))}</b><span>${f.bonus == null ? "sem valor definido" : "R$ " + Number(f.bonus).toLocaleString("pt-BR")}</span></div>
      </div>${i < faixas.length - 1 ? `<div class="bm-escada-linha ${estado === "concluida" ? "concluida" : ""}"></div>` : ""}`;
  }).join("")}</div>`;
}

// ---------------------------------------------------------------------------
// COUNT-UP — anima um número de 0 (ou do valor anterior) até o valor final.
// requestAnimationFrame simples, sem dependência (item 18).
// ---------------------------------------------------------------------------
export function countUp(elemento, valorFinal, { formatar = (v) => Math.round(v).toString(), duracao = 800 } = {}) {
  if (!elemento || valorFinal == null || !Number.isFinite(valorFinal)) { if (elemento) elemento.textContent = valorFinal == null ? "—" : formatar(valorFinal); return; }
  // Aba oculta/em segundo plano: requestAnimationFrame fica suspenso pelo
  // navegador (Page Visibility API) — mostra o valor final direto em vez de
  // deixar o número preso em 0 até o usuário voltar pra aba.
  if (typeof document !== "undefined" && document.hidden) { elemento.textContent = formatar(valorFinal); return; }
  const inicio = 0;
  const t0 = performance.now();
  const passo = (agora) => {
    const t = Math.min(1, (agora - t0) / duracao);
    const ease = 1 - Math.pow(1 - t, 3);
    elemento.textContent = formatar(inicio + (valorFinal - inicio) * ease);
    if (t < 1) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
}
