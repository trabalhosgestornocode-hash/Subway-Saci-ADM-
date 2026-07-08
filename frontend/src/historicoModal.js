// Modal de histórico do produto: linha do tempo com QUEM alterou, O QUE mudou
// (valor anterior -> novo) e QUANDO. Dados vêm de /api/v1/produtos/:id/historico.
import { obterHistoricoProduto } from "./api.js";
import { fmtMoeda, escapeHtml, fmtRelativo } from "./utils.js";

const CAT_LABEL = {
  sanduiche: "Sanduíche", salada: "Salada", bebida: "Bebida", sobremesa: "Sobremesa",
  chips: "Chips", adicional: "Adicional", acompanhamento: "Acompanhamento",
  combo: "Combo", submontagem: "Submontagem", outro: "Outro",
};
const TAM_LABEL = { "15cm": "15 cm", "30cm": "30 cm", salada: "Salada", unico: "Único" };

// Formata o valor de acordo com o campo alterado.
export function fmtValor(campo, v) {
  if (v === null || v === undefined || v === "") return "—";
  if (campo === "preco") return fmtMoeda(Number(v));
  if (campo === "ativo") return v === "true" || v === true ? "Ativo" : "Inativo";
  if (campo === "tipo") return CAT_LABEL[v] || String(v);
  if (campo === "tamanho") return TAM_LABEL[v] || String(v);
  return String(v);
}

function fmtDataHora(iso) {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function iniciais(nome, email) {
  const base = (nome || email || "?").trim();
  const partes = base.split(/[@\s.]+/).filter(Boolean);
  return ((partes[0]?.[0] || "?") + (partes[1]?.[0] || "")).toUpperCase();
}

let overlay = null;
function fechar() {
  overlay?.remove();
  overlay = null;
  document.removeEventListener("keydown", onKey);
}
function onKey(e) { if (e.key === "Escape") fechar(); }

export async function abrirHistoricoModal(produtoId, nomeProduto = "") {
  fechar();
  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal"><div class="estado"><div class="spinner"></div>Carregando histórico…</div></div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) fechar(); });
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKey);

  try {
    const { data } = await obterHistoricoProduto(produtoId);
    render(data, nomeProduto);
  } catch (e) {
    overlay.querySelector(".modal").innerHTML =
      `<button class="modal-close" aria-label="Fechar">×</button><div class="estado erro"><span class="emoji">⚠️</span><h3>Erro ao carregar</h3><p>${escapeHtml(e.message)}</p></div>`;
    overlay.querySelector(".modal-close").addEventListener("click", fechar);
  }
}

function render(data, nomeFallback) {
  const nome = data.produto || nomeFallback || "Produto";
  const alteracoes = data.alteracoes || [];

  let corpo;
  if (data.pendente) {
    corpo = `
      <div class="estado">
        <span class="emoji">🗂️</span>
        <h3>Auditoria ainda não ativada</h3>
        <p>Execute a migration <code>002_produto_historico.sql</code> no Supabase para começar a registrar as alterações. A partir daí, cada edição feita neste produto aparecerá aqui automaticamente.</p>
      </div>`;
  } else if (!alteracoes.length) {
    corpo = `
      <div class="estado">
        <span class="emoji">🕑</span>
        <h3>Nenhuma alteração registrada</h3>
        <p>As edições feitas neste produto (nome, categoria, status e preços) passarão a aparecer aqui, com autor e data.</p>
      </div>`;
  } else {
    const topo = alteracoes[0];
    const resumo = `
      <div class="hist-resumo">
        <span class="hist-resumo-dot"></span>
        <div>
          <b>Última alteração ${fmtRelativo(topo.created_at)}</b>
          <small>${escapeHtml(topo.usuario_nome || topo.usuario_email || "usuário desconhecido")} · ${fmtDataHora(topo.created_at)}</small>
        </div>
        <span class="hist-total">${alteracoes.length} alteraç${alteracoes.length > 1 ? "ões" : "ão"}</span>
      </div>`;

    const itens = alteracoes.map((a) => {
      const autor = a.usuario_nome || a.usuario_email || "Usuário desconhecido";
      const mudancas = a.mudancas.map((mc) => `
        <li class="hist-mudanca">
          <span class="hist-campo">${escapeHtml(mc.rotulo)}</span>
          <span class="hist-de">${escapeHtml(fmtValor(mc.campo, mc.valor_anterior))}</span>
          <span class="hist-seta">→</span>
          <span class="hist-para">${escapeHtml(fmtValor(mc.campo, mc.valor_novo))}</span>
        </li>`).join("");
      return `
        <li class="hist-evento">
          <span class="hist-avatar" title="${escapeHtml(a.usuario_email || "")}">${escapeHtml(iniciais(a.usuario_nome, a.usuario_email))}</span>
          <div class="hist-corpo">
            <div class="hist-cabecalho">
              <b>${escapeHtml(autor)}</b>
              <span class="hist-quando" title="${fmtDataHora(a.created_at)}">${fmtRelativo(a.created_at)}</span>
            </div>
            <div class="hist-data">${fmtDataHora(a.created_at)}</div>
            <ul class="hist-mudancas">${mudancas}</ul>
          </div>
        </li>`;
    }).join("");

    corpo = `${resumo}<ul class="hist-timeline">${itens}</ul>`;
  }

  overlay.querySelector(".modal").innerHTML = `
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head">
      <h2>🕑 Histórico do produto</h2>
      <div class="modal-tags"><span class="chip">${escapeHtml(nome)}</span></div>
    </div>
    ${corpo}
  `;
  overlay.querySelector(".modal-close").addEventListener("click", fechar);
}
