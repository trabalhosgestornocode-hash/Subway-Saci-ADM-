// Card "Simulação de preço" da Visão Geral do Dashboard iFood.
//
// CONCEITO: os DOIS canais ao mesmo tempo, lado a lado — não mais um seletor
// "Canal" que alterna entre eles. O objetivo é comparar: o mesmo produto,
// vendido no balcão e no iFood, com tabelas de preço diferentes, rende
// margens diferentes — e isso só fica óbvio vendo os dois juntos.
//
// Cada lado tem seu PRÓPRIO seletor de tabela, independente: o balcão pode
// estar na tabela B e o iFood na Z4 ao mesmo tempo. Trocar um não mexe no
// outro (são duas requisições separadas, cada uma com sua tabela).
//
// Fonte dos números — nada é hardcoded, tudo vem do backend
// (dashboardExecutivo.simulador.service.js):
//   * preço  -> produto_precos da tabela escolhida naquele canal;
//   * custo  -> ficha técnica real do produto (mesmo grafo do CMV);
//   * taxa   -> % real de Taxas e Comissões apurado no mês/unidade (iFood).
// Trocar de unidade, de mês ou mexer no custo dos insumos muda os dois lados,
// porque os dois lados são recalculados no servidor a cada render.
import { escapeHtml, fmtMoeda, fmtPct, statusCmv } from "./utils.js";
import { TABELAS } from "./config.js";
import { dashExecSimuladorPreco } from "./api.js";
import { registrarResetDeContexto, geracaoContexto, contextoMudou } from "./contextoEscopo.js";

/** Tabela escolhida em cada lado. Independentes por design (ver cabeçalho). */
const estado = { balcao: "A", ifood: "A" };

const PAINEIS = [
  { canal: "balcao", rotulo: "Balcão", icone: "🏪" },
  { canal: "ifood", rotulo: "iFood", icone: "📱" },
];

// A tabela escolhida é preferência de leitura de UMA unidade — ao trocar de
// unidade a tabela pode nem existir no catálogo da nova. Volta ao padrão.
registrarResetDeContexto(() => {
  estado.balcao = "A";
  estado.ifood = "A";
});

/**
 * Monta (ou remonta) o card dentro do elemento `containerId`. Chame de novo
 * sempre que a unidade OU o mês/ano do Dashboard iFood mudarem — a taxa do
 * iFood é apurada por mês, então o simulador precisa olhar exatamente o mesmo
 * período que a Visão Geral está mostrando.
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
  // Garante que a tabela guardada existe na lista do canal (a lista do balcão
  // e a do iFood são diferentes — ver config.js#TABELAS).
  for (const { canal } of PAINEIS) {
    const lista = TABELAS[canal] ?? [];
    if (!lista.includes(estado[canal])) estado[canal] = lista[0] ?? "A";
  }

  container.innerHTML = `
    <section class="dex-painel dex-simulador">
      <div class="dex-sim-cabecalho">
        <div class="dex-sim-titulo-wrap">
          <h3>🧮 Simulação de preço — Churrasco 15cm</h3>
          <p class="dex-sim-desc">Balcão e iFood lado a lado — preço e custo reais, cada canal com sua tabela.</p>
        </div>
      </div>

      <div class="dex-sim-duplo">
        ${PAINEIS.map((p) => painelHtml(p)).join("")}
      </div>

      <div id="dex-sim-comparacao" class="dex-sim-comparacao" hidden></div>
    </section>`;

  for (const { canal } of PAINEIS) {
    container.querySelector(`#dex-sim-tabela-${canal}`).addEventListener("change", (e) => {
      estado[canal] = e.target.value;
      // Recarrega SÓ o lado alterado — o outro canal não é afetado por esta
      // troca (é justamente a independência que o card promete). A comparação
      // no rodapé é recalculada quando o lado novo chega.
      carregarLado(container, canal, unidadeId, mes, ano);
    });
  }

  carregarTudo(container, unidadeId, mes, ano);
}

function painelHtml({ canal, rotulo, icone }) {
  const tabelas = TABELAS[canal] ?? [];
  return `
    <div class="dex-sim-lado" data-canal="${canal}">
      <div class="dex-sim-lado-topo">
        <span class="dex-sim-lado-titulo">${icone} ${rotulo}</span>
        <label class="dex-sim-lado-tabela">
          <span>Tabela</span>
          <select id="dex-sim-tabela-${canal}" aria-label="Tabela de preço do ${rotulo}">
            ${tabelas.map((t) => `<option value="${escapeHtml(t)}" ${t === estado[canal] ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}
          </select>
        </label>
      </div>
      <div id="dex-sim-res-${canal}" class="dex-sim-lado-corpo">
        <div class="estado-mini"><div class="spinner"></div>Calculando…</div>
      </div>
    </div>`;
}

// Resultado mais recente de cada lado — é o que alimenta a comparação do
// rodapé. `null` enquanto o lado não respondeu (ou respondeu sem preço):
// comparar com dado ausente produziria uma "diferença" inventada.
const ultimo = { balcao: null, ifood: null };

async function carregarTudo(container, unidadeId, mes, ano) {
  await Promise.all(PAINEIS.map(({ canal }) => carregarLado(container, canal, unidadeId, mes, ano)));
}

async function carregarLado(container, canal, unidadeId, mes, ano) {
  const box = container.querySelector(`#dex-sim-res-${canal}`);
  if (!box) return;
  box.innerHTML = `<div class="estado-mini"><div class="spinner"></div>Calculando…</div>`;
  const g = geracaoContexto();
  try {
    const { data } = await dashExecSimuladorPreco({ unidadeId, canal, tabela: estado[canal], mes, ano });
    if (contextoMudou(g)) return; // resposta da unidade anterior — descarta
    ultimo[canal] = data;
    box.innerHTML = ladoHtml(data);
  } catch (e) {
    if (contextoMudou(g)) return;
    ultimo[canal] = null;
    box.innerHTML = `<div class="estado-mini"><span class="emoji">⚠️</span><p>${escapeHtml(e.message)}</p></div>`;
  }
  renderComparacao(container);
}

function linha(label, valorHtml, cls = "") {
  return `<div class="dex-sim-linha ${cls}"><span>${label}</span><b>${valorHtml}</b></div>`;
}

function ladoHtml(d) {
  if (d.preco == null) {
    return `<div class="estado-mini"><p>${escapeHtml(d.indisponivel ?? "Preço não cadastrado para esta tabela.")}</p></div>`;
  }
  const st = statusCmv(d.cmvPct);
  const linhas = [
    linha("Preço", `${fmtMoeda(d.preco)}${d.precoDesatualizado ? ' <span class="dex-sim-badge">2024</span>' : ""}`),
    linha("Custo", fmtMoeda(d.custo)),
    linha("CMV", `<span class="pill ${st.classe}">${fmtPct(d.cmvPct)}</span>`),
  ];

  // Só o iFood tem taxa de canal — o balcão não carrega uma dedução que não
  // existe (é o que torna a comparação das duas margens honesta).
  if (d.canal === "ifood") {
    linhas.push(linha("Taxas e Comissões", d.taxaEstimadaPct == null ? "—" : `${fmtPct(d.taxaEstimadaPct)} <small>${fmtMoeda(d.taxaEstimadaReais)}</small>`));
    linhas.push(linha("Receita após taxas", d.receitaAposTaxas == null ? "—" : fmtMoeda(d.receitaAposTaxas)));
  }

  linhas.push(linha(
    "Margem estimada",
    d.margemEstimada == null ? "—" : `${fmtMoeda(d.margemEstimada)} <small>${fmtPct(d.margemEstimadaPct)}</small>`,
    "dex-sim-linha-destaque",
  ));

  const notaTexto = [d.taxaEstimadaFonte, d.margemNota].filter(Boolean).join(" ");
  const notaTip = notaTexto ? `<span class="vd-tip" data-tip="${escapeHtml(notaTexto)}" tabindex="0">i</span>` : "";

  return `
    <div class="dex-sim-linhas">${linhas.join("")}</div>
    ${d.indisponivel ? `<p class="dex-sim-aviso">ℹ️ ${escapeHtml(d.indisponivel)}</p>`
      : notaTip ? `<p class="dex-sim-aviso">${notaTip} Sobre este cálculo — não é lucro líquido</p>` : ""}`;
}

/**
 * Rodapé de comparação. Só aparece quando os DOIS lados têm o número em
 * questão — comparar contra um lado indisponível daria uma diferença falsa
 * (ex.: "−R$ 32,00" só porque o iFood ainda não tem taxa apurada no mês).
 * Sinal sempre relativo ao iFood: positivo = iFood acima do balcão.
 */
function renderComparacao(container) {
  const box = container.querySelector("#dex-sim-comparacao");
  if (!box) return;
  const b = ultimo.balcao, i = ultimo.ifood;

  const itens = [];
  if (b?.preco != null && i?.preco != null) {
    itens.push(itemComparacao("Diferença de preço", i.preco - b.preco, fmtMoeda));
  }
  if (b?.cmvPct != null && i?.cmvPct != null) {
    // CMV: menor é melhor, então a seta verde/vermelha se inverte.
    itens.push(itemComparacao("Diferença de CMV", i.cmvPct - b.cmvPct, (v) => fmtPct(v), { menorMelhor: true }));
  }
  if (b?.margemEstimada != null && i?.margemEstimada != null) {
    itens.push(itemComparacao("Diferença de margem", i.margemEstimada - b.margemEstimada, fmtMoeda));
  }

  if (!itens.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = `<span class="dex-sim-comp-rotulo">iFood × Balcão</span>${itens.join("")}`;
}

function itemComparacao(label, delta, fmt, { menorMelhor = false } = {}) {
  const zero = Math.abs(delta) < 0.005;
  const bom = menorMelhor ? delta < 0 : delta > 0;
  const classe = zero ? "neutro" : bom ? "positivo" : "negativo";
  const sinal = zero ? "" : delta > 0 ? "+" : "−";
  return `<div class="dex-sim-comp-item ${classe}">
    <span>${label}</span><b>${sinal}${fmt(Math.abs(delta))}</b>
  </div>`;
}
