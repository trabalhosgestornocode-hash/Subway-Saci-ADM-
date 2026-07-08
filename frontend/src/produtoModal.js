// Modal de detalhe do produto: ficha técnica (ingredientes) + preços/CMV.
import { obterProduto } from "./api.js";
import { fmtMoeda, fmtPct, fmtTexto, escapeHtml, statusCmv } from "./utils.js";

const CAT_LABEL = {
  sanduiche: "Sanduíche", salada: "Salada", bebida: "Bebida", sobremesa: "Sobremesa",
  chips: "Chips", adicional: "Adicional", acompanhamento: "Acompanhamento",
  combo: "Combo", submontagem: "Submontagem", outro: "Outro",
};
const CANAL_LABEL = { balcao: "Balcão", ifood: "iFood", uber: "Uber", app: "App", outro: "Outro" };
const catLabel = (t) => CAT_LABEL[t] || fmtTexto(t);
const canalLabel = (c) => CANAL_LABEL[c] || fmtTexto(c);

function fmtQtd(q, un) {
  const n = Number(q);
  if (un === "kg") return (n * 1000).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " g";
  if (un === "l") return (n * 1000).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " ml";
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " " + (un || "un");
}

let overlay = null;
function fechar() {
  overlay?.remove();
  overlay = null;
  document.removeEventListener("keydown", onKey);
}
function onKey(e) { if (e.key === "Escape") fechar(); }

export async function abrirProdutoModal(produtoId) {
  fechar();
  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal"><div class="estado"><div class="spinner"></div>Carregando ficha técnica…</div></div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) fechar(); });
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKey);

  try {
    const { data } = await obterProduto(produtoId);
    render(data);
  } catch (e) {
    overlay.querySelector(".modal").innerHTML =
      `<button class="modal-close" aria-label="Fechar">×</button><div class="estado erro"><span class="emoji">⚠️</span><h3>Erro ao carregar</h3><p>${escapeHtml(e.message)}</p></div>`;
    overlay.querySelector(".modal-close").addEventListener("click", fechar);
  }
}

function render(p) {
  const ingRows = (p.ingredientes ?? []).length
    ? p.ingredientes.map((i) => `
        <tr>
          <td>${escapeHtml(i.nome)}</td>
          <td class="num">${fmtQtd(i.quantidade, i.unidade)}</td>
          <td class="num">${fmtMoeda(i.custo_unitario)}</td>
          <td class="num">${fmtMoeda(i.custo_total)}</td>
        </tr>`).join("")
    : `<tr><td colspan="4"><div class="estado"><span class="emoji">📋</span><p>Sem ficha técnica cadastrada para este produto.</p></div></td></tr>`;

  const precoRows = (p.precos ?? []).length
    ? p.precos.map((pr) => {
        const cmv = pr.preco > 0 ? (Number(p.custo) / Number(pr.preco)) * 100 : null;
        const st = statusCmv(cmv);
        return `<tr>
          <td>${canalLabel(pr.canal)}</td>
          <td>${fmtTexto(pr.tabela)}</td>
          <td class="num">${fmtMoeda(pr.preco)}${pr.desatualizado ? ' <span class="badge">2024</span>' : ""}</td>
          <td class="num"><span class="pill ${st.classe}">${fmtPct(cmv)}</span></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="4"><div class="estado"><p>Sem preços cadastrados.</p></div></td></tr>`;

  overlay.querySelector(".modal").innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head">
      <h2>${escapeHtml(p.nome)}</h2>
      <div class="modal-tags">
        ${p.tamanho ? `<span class="chip">${escapeHtml(p.tamanho)}</span>` : ""}
        <span class="chip">${catLabel(p.tipo)}</span>
      </div>
    </div>
    <div class="modal-custo"><span>Custo total (ficha técnica)</span><strong>${fmtMoeda(p.custo)}</strong></div>

    <div class="modal-sec-titulo">🧾 Ingredientes</div>
    <div class="tabela-wrap">
      <table class="grid grid-modal">
        <thead><tr><th>Ingrediente</th><th class="num">Qtd</th><th class="num">Custo un.</th><th class="num">Custo</th></tr></thead>
        <tbody>${ingRows}</tbody>
      </table>
    </div>

    <div class="modal-sec-titulo">💵 Preços por canal</div>
    <div class="tabela-wrap">
      <table class="grid grid-modal">
        <thead><tr><th>Canal</th><th>Tabela</th><th class="num">Preço</th><th class="num">CMV</th></tr></thead>
        <tbody>${precoRows}</tbody>
      </table>
    </div>
  `;
  overlay.querySelector(".modal-close").addEventListener("click", fechar);
}
