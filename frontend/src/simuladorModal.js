// Simulador de preço: mexe no preço e vê CMV, comissão, lucro líquido e margem ao vivo.
import { COMISSAO } from "./config.js";
import { fmtMoeda, fmtPct, escapeHtml, statusCmv } from "./utils.js";

const CANAL_LABEL = { balcao: "Balcão", ifood: "iFood", uber: "Uber", app: "App", outro: "Outro" };
const CANAIS = ["balcao", "ifood", "uber"];

let overlay = null;
function fechar() {
  overlay?.remove();
  overlay = null;
  document.removeEventListener("keydown", onKey);
}
function onKey(e) { if (e.key === "Escape") fechar(); }

export function abrirSimulador(row) {
  fechar();
  const custo = Number(row.custo) || 0;
  const precoAtual = Number(row.preco) || Math.max(custo * 2, 1);
  let canal = CANAIS.includes(row.canal) ? row.canal : "balcao";
  let preco = precoAtual;
  const maxPreco = Math.max(Math.ceil(precoAtual * 2), Math.ceil(custo * 3), 10);

  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal modal-sim"></div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) fechar(); });
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKey);

  const m = overlay.querySelector(".modal");
  m.innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head">
      <h2>🧮 Simular preço</h2>
      <div class="modal-tags"><span class="chip">${escapeHtml(row.nome)}</span></div>
    </div>

    <div class="sim-topo">
      <div class="sim-info"><span>Custo (ficha técnica)</span><strong>${fmtMoeda(custo)}</strong></div>
      <div class="sim-info"><span>Preço atual</span><strong>${fmtMoeda(precoAtual)}</strong></div>
      <div class="sim-info">
        <span>Canal</span>
        <select id="sim-canal">${CANAIS.map((c) => `<option value="${c}" ${c === canal ? "selected" : ""}>${CANAL_LABEL[c]} · ${(COMISSAO[c] * 100).toFixed(0)}%</option>`).join("")}</select>
      </div>
    </div>

    <div class="sim-preco-box">
      <label>Preço de venda simulado <strong id="sim-preco-lbl"></strong></label>
      <input id="sim-slider" type="range" min="0" max="${maxPreco}" step="0.5" value="${preco}" />
      <div class="sim-preco-num">R$ <input id="sim-preco" type="number" min="0" step="0.5" value="${preco}" /></div>
    </div>

    <div class="sim-resultados" id="sim-out"></div>
    <div class="sim-ref" id="sim-ref"></div>
  `;
  m.querySelector(".modal-close").addEventListener("click", fechar);

  const $ = (s) => m.querySelector(s);
  function calc() {
    const com = COMISSAO[canal] ?? 0;
    const lucro = preco * (1 - com) - custo;
    const cmv = preco > 0 ? (custo / preco) * 100 : null;
    const margem = preco > 0 ? (lucro / preco) * 100 : null;
    const st = statusCmv(cmv);

    $("#sim-preco-lbl").textContent = fmtMoeda(preco);
    $("#sim-out").innerHTML = `
      <div class="sim-card"><span>CMV</span><b><span class="pill ${st.classe}">${fmtPct(cmv)}</span></b></div>
      <div class="sim-card"><span>Comissão (${(com * 100).toFixed(0)}%)</span><b class="neg">- ${fmtMoeda(preco * com)}</b></div>
      <div class="sim-card ${lucro < 0 ? "ruim" : "bom"}"><span>Lucro líquido</span><b>${fmtMoeda(lucro)}</b></div>
      <div class="sim-card"><span>Margem</span><b>${fmtPct(margem)}</b></div>`;

    const alvo = (x) => (custo > 0 ? fmtMoeda((custo * 100) / x) : "—");
    $("#sim-ref").innerHTML = `<span class="sim-ref-t">🎯 Preço para CMV alvo:</span> <b>30%</b> ${alvo(30)} &nbsp;·&nbsp; <b>28%</b> ${alvo(28)} &nbsp;·&nbsp; <b>25%</b> ${alvo(25)}`;
  }

  $("#sim-slider").addEventListener("input", (e) => { preco = Number(e.target.value); $("#sim-preco").value = preco; calc(); });
  $("#sim-preco").addEventListener("input", (e) => { preco = Number(e.target.value) || 0; $("#sim-slider").value = Math.min(preco, maxPreco); calc(); });
  $("#sim-canal").addEventListener("change", (e) => { canal = e.target.value; calc(); });
  calc();
}
