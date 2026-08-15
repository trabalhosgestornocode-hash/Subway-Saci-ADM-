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
import { icon } from "./icons.js";

/** Tabela escolhida em cada lado (independentes por design — ver cabeçalho) +
 * se o card está expandido. Recolhido é o padrão (item 1 do pedido de UX):
 * o simulador é uma ferramenta complementar, não pode competir em espaço com
 * os indicadores financeiros logo abaixo dele na Visão Geral. */
const estado = { balcao: "A", ifood: "A", expandido: false };

const PAINEIS = [
  { canal: "balcao", rotulo: "Balcão", icone: "store" },
  { canal: "ifood", rotulo: "iFood", icone: "smartphone" },
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
          <h3>${icon("calculator", { size: 15 })} Simulação de preço — Churrasco 15cm</h3>
          <p class="dex-sim-desc" ${estado.expandido ? "" : "hidden"}>Balcão e iFood lado a lado — preço e custo reais, cada canal com sua tabela.</p>
        </div>
        <button class="btn btn-ghost btn-sm dex-sim-toggle" id="dex-sim-toggle" type="button" aria-expanded="${estado.expandido}">
          ${estado.expandido ? "Recolher" : "Expandir simulador"}
        </button>
      </div>

      <div id="dex-sim-resumo" class="dex-sim-resumo" ${estado.expandido ? "hidden" : ""}>
        <div class="estado-mini"><div class="spinner"></div>Calculando…</div>
      </div>

      <div id="dex-sim-corpo" class="dex-sim-corpo" ${estado.expandido ? "" : "hidden"}>
        <div class="dex-sim-duplo">
          ${PAINEIS.map((p) => painelHtml(p)).join("")}
        </div>
        <div id="dex-sim-comparacao" class="dex-sim-comparacao" hidden></div>
      </div>
    </section>`;

  container.querySelector("#dex-sim-toggle").addEventListener("click", () => {
    estado.expandido = !estado.expandido;
    aplicarEstadoExpandido(container);
  });

  for (const { canal } of PAINEIS) {
    container.querySelector(`#dex-sim-tabela-${canal}`).addEventListener("change", (e) => {
      estado[canal] = e.target.value;
      // Recarrega SÓ o lado alterado — o outro canal não é afetado por esta
      // troca (é justamente a independência que o card promete). A comparação
      // e o resumo compacto são recalculados quando o lado novo chega.
      carregarLado(container, canal, unidadeId, mes, ano);
    });
  }

  carregarTudo(container, unidadeId, mes, ano);
}

/**
 * Alterna entre o resumo compacto (padrão) e os dois painéis completos — só
 * troca a visibilidade (`hidden`), nunca reconstrói o DOM. Os selects de
 * tabela de cada canal e os dados já carregados continuam exatamente onde
 * estavam (item 1 do pedido: não perder o estado das tabelas ao recolher).
 */
function aplicarEstadoExpandido(container) {
  const resumo = container.querySelector("#dex-sim-resumo");
  const corpo = container.querySelector("#dex-sim-corpo");
  const desc = container.querySelector(".dex-sim-desc");
  const btn = container.querySelector("#dex-sim-toggle");
  if (resumo) resumo.hidden = estado.expandido;
  if (corpo) corpo.hidden = !estado.expandido;
  if (desc) desc.hidden = !estado.expandido;
  if (btn) {
    btn.textContent = estado.expandido ? "Recolher" : "Expandir simulador";
    btn.setAttribute("aria-expanded", String(estado.expandido));
  }
}

function painelHtml({ canal, rotulo, icone }) {
  const tabelas = TABELAS[canal] ?? [];
  return `
    <div class="dex-sim-lado" data-canal="${canal}">
      <div class="dex-sim-lado-topo">
        <span class="dex-sim-lado-titulo">${icon(icone, { size: 14 })} ${rotulo}</span>
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
    box.innerHTML = `<div class="estado-mini">${icon("alert-triangle", { size: 15 })}<p>${escapeHtml(e.message)}</p></div>`;
  }
  renderComparacao(container);
  atualizarResumo(container);
}

/**
 * Resumo compacto (estado padrão, recolhido) — só os 5 números que mais
 * importam pra uma decisão rápida: os dois preços, a diferença entre eles e
 * as duas margens. Mesmos dados de `ultimo` que já alimentam o rodapé de
 * comparação do modo expandido — não recalcula nada, só reapresenta.
 */
function resumoHtml() {
  const b = ultimo.balcao, i = ultimo.ifood;
  const item = (label, valorHtml) => `<div class="dex-sim-resumo-item"><span>${label}</span><b>${valorHtml}</b></div>`;
  const itens = [
    item("Balcão", b?.preco != null ? fmtMoeda(b.preco) : "—"),
    item("iFood", i?.preco != null ? fmtMoeda(i.preco) : "—"),
  ];
  if (b?.preco != null && i?.preco != null) {
    const diff = i.preco - b.preco;
    const sinal = Math.abs(diff) < 0.005 ? "" : diff > 0 ? "+" : "−";
    itens.push(item("Diferença", `${sinal}${fmtMoeda(Math.abs(diff))}`));
  }
  itens.push(item("Margem Balcão", b?.margemEstimada != null ? fmtMoeda(b.margemEstimada) : "—"));
  itens.push(item("Margem iFood", i?.margemEstimada != null ? fmtMoeda(i.margemEstimada) : "—"));
  return itens.join("");
}

function atualizarResumo(container) {
  const box = container.querySelector("#dex-sim-resumo");
  if (box) box.innerHTML = resumoHtml();
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
    // % que a diferença representa sobre o preço do iFood — é a leitura que
    // conecta direto com as taxas do canal: se a diferença bater perto do
    // total de taxas (iFood + serviço + motoboy), o preço do iFood só está
    // "recompondo" o valor do balcão depois dos descontos, não gerando mais
    // margem de verdade. Por isso mostramos do lado a meta de total de
    // deduções do modelo logístico da unidade — é o número de referência
    // pra comparar contra essa diferença real.
    const pctDelta = i.preco ? ((i.preco - b.preco) / i.preco) * 100 : null;
    itens.push(itemComparacao("Diferença de preço", i.preco - b.preco, fmtMoeda, { pctDelta }) + refModeloHtml(i));
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

/**
 * Linha de referência: a meta de total de deduções do modelo logístico da
 * unidade (Marketplace/Full Service — ver metas_indicadores). É estática,
 * não "boa" nem "ruim" como a diferença real acima — por isso não usa
 * itemComparacao (que sempre pinta verde/vermelho). Some quando a unidade
 * não tem meta configurada para o modelo (não inventa número).
 * @param {object|null} i resultado do lado iFood
 */
function refModeloHtml(i) {
  if (i?.metaTotalDeducoesPct == null) return "";
  const modelo = i.modeloLogisticoRotulo ? ` (${escapeHtml(i.modeloLogisticoRotulo)})` : "";
  return `<div class="dex-sim-comp-ref">Esperado pelo modelo${modelo}: <b>${fmtPct(i.metaTotalDeducoesPct)}</b></div>`;
}

function itemComparacao(label, delta, fmt, { menorMelhor = false, pctDelta = null } = {}) {
  const zero = Math.abs(delta) < 0.005;
  const bom = menorMelhor ? delta < 0 : delta > 0;
  const classe = zero ? "neutro" : bom ? "positivo" : "negativo";
  const sinal = zero ? "" : delta > 0 ? "+" : "−";
  // % da diferença sobre a base (hoje só usado em "Diferença de preço") —
  // mesmo sinal do valor principal, então não repete a lógica de zero/bom.
  const pctHtml = pctDelta != null ? ` <small>${sinal}${fmtPct(Math.abs(pctDelta))}</small>` : "";
  return `<div class="dex-sim-comp-item ${classe}">
    <span>${label}</span><b>${sinal}${fmt(Math.abs(delta))}${pctHtml}</b>
  </div>`;
}
