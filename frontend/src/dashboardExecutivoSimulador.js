// Card "Simulação de preço" da Visão Geral do Dashboard iFood — Balcão/iFood
// + tabela (A-F...), reagindo ao vivo. Reutiliza a MESMA fonte de tabelas do
// resto do sistema (frontend/src/config.js#TABELAS) — não inventa lista
// própria — e todo número vem do backend (preço real de produto_precos,
// custo real da ficha técnica via custo.js). Este seletor é local ao card:
// trocar Canal/Tabela aqui NÃO mexe na tabela de preço global da unidade.
import { escapeHtml, fmtMoeda, fmtPct, statusCmv } from "./utils.js";
import { TABELAS } from "./config.js";
import { dashExecSimuladorPreco } from "./api.js";

const CANAIS = [["balcao", "Balcão"], ["ifood", "iFood"]];

const estado = { canal: "ifood", tabela: "A" };

/**
 * Monta (ou remonta) o card dentro do elemento `containerId`. Chame de novo
 * sempre que a unidade OU o mês/ano selecionados no Dashboard iFood mudarem
 * — a taxa do iFood é apurada por mês, então o simulador precisa olhar
 * exatamente o mesmo período que a Visão Geral está mostrando (nunca "hoje"
 * por padrão: é aí que morava o bug de "Margem —" com o mês certo ao lado).
 * @param {string} containerId @param {string|null} unidadeId @param {number} mes @param {number} ano
 */
export function montarSimuladorPreco(containerId, unidadeId, mes, ano) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!unidadeId) {
    container.innerHTML = "";
    return;
  }
  render(container, unidadeId, mes, ano);
}

function render(container, unidadeId, mes, ano) {
  const tabelasDoCanal = TABELAS[estado.canal] ?? [];
  if (!tabelasDoCanal.includes(estado.tabela)) estado.tabela = tabelasDoCanal[0] ?? "A";

  // Painel horizontal e compacto: título+seletores numa linha, indicadores
  // em "chips" (label pequeno em cima, número em destaque embaixo) na linha
  // de baixo — nada de tabela longa com várias divisórias.
  container.innerHTML = `
    <section class="dex-painel dex-simulador">
      <div class="dex-sim-cabecalho">
        <div class="dex-sim-titulo-wrap">
          <h3>🧮 Simulação de preço — Churrasco 15cm</h3>
          <p class="dex-sim-desc">Como a tabela de preço afeta a rentabilidade do produto — custo e preço reais, sempre atualizados.</p>
        </div>
        <div class="dex-sim-selects">
          <label class="cfg-campo"><span>Canal</span>
            <select id="dex-sim-canal">${CANAIS.map(([v, l]) => `<option value="${v}" ${v === estado.canal ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label class="cfg-campo"><span>Tabela</span>
            <select id="dex-sim-tabela">${tabelasDoCanal.map((t) => `<option value="${escapeHtml(t)}" ${t === estado.tabela ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}</select></label>
        </div>
      </div>
      <div id="dex-sim-resultado" class="dex-sim-resultado"><div class="estado-mini"><div class="spinner"></div>Calculando…</div></div>
    </section>`;

  container.querySelector("#dex-sim-canal").addEventListener("change", (e) => {
    estado.canal = e.target.value;
    render(container, unidadeId, mes, ano); // troca a lista de tabelas -> refaz o card inteiro
  });
  container.querySelector("#dex-sim-tabela").addEventListener("change", (e) => {
    estado.tabela = e.target.value;
    carregar(container, unidadeId, mes, ano);
  });
  carregar(container, unidadeId, mes, ano);
}

async function carregar(container, unidadeId, mes, ano) {
  const box = container.querySelector("#dex-sim-resultado");
  if (!box) return;
  try {
    const { data } = await dashExecSimuladorPreco({ unidadeId, canal: estado.canal, tabela: estado.tabela, mes, ano });
    box.innerHTML = resultadoHtml(data);
  } catch (e) {
    box.innerHTML = `<div class="estado-mini"><span class="emoji">⚠️</span><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function resultadoHtml(d) {
  if (d.preco == null) {
    return `<div class="estado-mini"><p>${escapeHtml(d.indisponivel ?? "Preço não cadastrado para esta combinação.")}</p></div>`;
  }
  const st = statusCmv(d.cmvPct);
  const chip = (label, vHtml, cls = "") => `<div class="dex-sim-chip ${cls}"><span>${label}</span><b>${vHtml}</b></div>`;
  const chips = [
    chip("Preço", `${fmtMoeda(d.preco)}${d.precoDesatualizado ? ' <span class="dex-sim-badge">2024</span>' : ""}`),
    chip("Custo", fmtMoeda(d.custo)),
    chip("CMV", `<span class="pill ${st.classe}">${fmtPct(d.cmvPct)}</span>`),
  ];
  if (d.canal === "ifood" && d.taxaEstimadaPct != null) {
    // % e R$ juntos, como pedido — a taxa em si também tem um lado "R$".
    chips.push(chip("Taxa iFood", `${fmtPct(d.taxaEstimadaPct)} <small>${fmtMoeda(d.taxaEstimadaReais)}</small>`));
  }
  if (d.receitaAposTaxas != null) {
    chips.push(chip("Após taxas", fmtMoeda(d.receitaAposTaxas)));
  }
  chips.push(chip(
    // R$ em destaque, % como apoio — nunca só o percentual sozinho.
    "Margem estimada",
    d.margemEstimada == null ? "—" : `${fmtMoeda(d.margemEstimada)} <small>${fmtPct(d.margemEstimadaPct)}</small>`,
    "dex-sim-chip-destaque",
  ));

  // Uma nota só, combinando a fonte da taxa (quando existe) com o aviso de
  // que isso não é lucro líquido — mantém o rodapé compacto (um tooltip, não
  // um parágrafo).
  const notaTexto = [d.taxaEstimadaFonte, d.margemNota].filter(Boolean).join(" ");
  const notaTip = notaTexto ? `<span class="vd-tip" data-tip="${escapeHtml(notaTexto)}" tabindex="0">i</span>` : "";

  return `
    <div class="dex-sim-chips">${chips.join("")}</div>
    ${d.indisponivel ? `<p class="dex-sim-aviso">ℹ️ ${escapeHtml(d.indisponivel)}</p>`
      : notaTip ? `<p class="dex-sim-aviso">${notaTip} Sobre este cálculo — não é lucro líquido</p>` : ""}`;
}
