// PARSER FOOD DELIVERY — Central de Conciliação Food Delivery: recebe o
// relatório, separa operações, identifica entregadores, classifica
// AUTOMATICAMENTE se um cancelamento recebe taxa (motor de classificação em
// backend/.../parserFoodDelivery.classificacao.js), calcula valores, detalha
// o pagamento de cada entregador e mantém histórico auditável por período.
// Mesmo esqueleto de bonificacaoMensal.js: abas + estado de módulo próprio,
// reset ao trocar de unidade (nunca mistura dados entre unidades).
import { el, escapeHtml, toast, fmtMoeda, fmtDataHora } from "./utils.js";
import { state } from "./state.js";
import { pode } from "./sessao.js";
import {
  pfdImportacoes, pfdImportacaoDetalhe, pfdArquivoImportacao, pfdAlterarClassificacao, pfdExcluirImportacao,
} from "./api.js";
import { abrirImportarFoodDeliveryModal } from "./parserFoodDeliveryImportModal.js";
import { registrarResetDeContexto, geracaoContexto, contextoMudou } from "./contextoEscopo.js";

const ABAS = [
  { id: "visao", icon: "📊", label: "Visão Geral" },
  { id: "pedidos", icon: "🧾", label: "Pedidos" },
  { id: "cancelamentos", icon: "🚫", label: "Cancelamentos" },
  { id: "entregadores", icon: "🛵", label: "Entregadores" },
  { id: "historico", icon: "📚", label: "Histórico" },
];

const STATUS_ROTULO = {
  incluido: { label: "Incluído", classe: "ok" },
  cancelado_com_taxa: { label: "Cancelado com taxa", classe: "warn" },
  excluido: { label: "Excluído", classe: "bad" },
};

// classe do pill na tabela de ignorados — chave é `operacao` (subway com
// classificacaoIgnorado === "Sem entregador" cai no default "muted").
const CLASSE_IGNORADO = {
  acai_no_grau: "bad",
  revisao_necessaria: "warn",
};

// Resultado da classificação AUTOMÁTICA de um cancelamento — paleta reservada
// (vermelho fica só pra marca/erro real; "não recebe taxa" é um resultado
// esperado do sistema, não um erro, por isso é cinza e não vermelho).
const CLASSIFICACAO_ROTULO = {
  recebe_taxa: { label: "Recebe taxa", classe: "ok" },
  nao_recebe_taxa: { label: "Não recebe taxa", classe: "muted" },
  revisar: { label: "Revisão necessária", classe: "warn" },
};
const CONFIANCA_ROTULO = { muito_alta: "Confiança muito alta", alta: "Confiança alta", inconclusiva: "Revisão necessária" };
const FILTROS_CANCELAMENTO = [["todos", "Todos"], ["recebe_taxa", "Recebe taxa"], ["nao_recebe_taxa", "Não recebe"], ["revisar", "Revisão"]];
// Timeline do pedido (motor de classificação) — só renderiza os passos que
// têm timestamp no relatório.
const ETAPAS_TIMELINE = [
  ["dataHora", "Pedido recebido"], ["dataDespachado", "Despachado"], ["dataAceito", "Aceito"],
  ["dataColetado", "Coletado"], ["dataChegadaEntrega", "Chegada para entrega"], ["dataCancelado", "Cancelado"],
];
const PERIODOS_PFD = [["hoje", "Hoje"], ["ontem", "Ontem"], ["7d", "7 dias"], ["mes", "Este mês"], ["custom", "Personalizado"]];

const pfd = {
  aba: "visao",
  atual: null,        // { importacao, resumo, entregadores, pedidos, pedidosIgnorados, [consolidado, fontes] } — importação(ões) aberta(s) no momento
  historico: null,
  carregandoHistorico: false,
  filtros: { busca: "", status: "todos", entregador: "todos" },
  filtrosCancelamentos: { busca: "", status: "todos" },
  periodo: { chave: null, ini: null, fim: null },
  ordEntregadores: "taxas", // taxas | entregas | nome
  verIgnorados: false, // alterna a tabela da aba Pedidos entre Subway e "ignorados"
};

registrarResetDeContexto(() => {
  pfd.aba = "visao";
  pfd.atual = null;
  pfd.historico = null;
  pfd.filtros = { busca: "", status: "todos", entregador: "todos" };
  pfd.filtrosCancelamentos = { busca: "", status: "todos" };
  pfd.periodo = { chave: null, ini: null, fim: null };
  pfd.ordEntregadores = "taxas";
  pfd.verIgnorados = false;
  fecharPfdDrawer();
});

const podeImportar = () => pode("parser_food_delivery.importar");
const podeExcluir = () => pode("parser_food_delivery.excluir");
const podeClassificar = () => pode("parser_food_delivery.classificar");
const vazio = (emoji, titulo, msg, extra = "") =>
  `<div class="estado"><span class="emoji">${emoji}</span><h3>${escapeHtml(titulo)}</h3><p>${escapeHtml(msg)}</p>${extra}</div>`;
const carregando = () => `<div class="estado"><div class="spinner"></div>Carregando…</div>`;
// Skeleton (mesmo componente .vd-skel já usado em vendas.js — sem duplicar
// CSS) pro CONTEÚDO da tela, não a tela inteira: cabeçalho e abas continuam
// visíveis e clicáveis, só a área de dados pisca em "carregando".
const skeletonVisaoGeral = () => `
  <div class="vd-skel vd-skel-linha" style="max-width:420px"></div>
  <div class="vd-cards">${Array.from({ length: 4 }).map(() => '<div class="vd-skel vd-skel-card"></div>').join("")}</div>
  <div class="vd-skels">${Array.from({ length: 5 }).map(() => '<div class="vd-skel vd-skel-linha"></div>').join("")}</div>`;
const skeletonTabela = () => `<div class="vd-skels">${Array.from({ length: 8 }).map(() => '<div class="vd-skel vd-skel-linha"></div>').join("")}</div>`;
const fmtDataBr = (iso) => (iso ? iso.split("-").reverse().join("/") : "—");
const fmtPeriodo = (ini, fim) => (!ini ? "—" : ini === fim ? fmtDataBr(ini) : `${fmtDataBr(ini)} até ${fmtDataBr(fim)}`);
const arred = (n) => Math.round(n * 100) / 100;

export async function renderParserFoodDelivery() {
  const g = geracaoContexto();
  const view = el("#view");
  if (!view) return;
  view.innerHTML = carregando();
  const unidadeNome = state.sessao?.unidade?.nome;
  if (!state.sessao?.unidade?.id) {
    view.innerHTML = vazio("🏪", "Selecione uma unidade", "O Parser Food Delivery é por unidade. Selecione uma unidade no seletor de contexto para continuar.");
    return;
  }
  montarLayout(unidadeNome);
  await carregarHistorico();
  if (contextoMudou(g)) return;
  if (!pfd.atual && pfd.historico?.length) await abrirImportacao(pfd.historico[0].id, { silencioso: true });
  if (contextoMudou(g)) return;
  renderAbaAtual();
}

function montarLayout(unidadeNome) {
  const view = el("#view");
  view.innerHTML = `
    <div class="bm-topo">
      <div class="dex-head-txt">
        <h2><img src="/assets/menu-parser-food-delivery.png" alt="" class="pfd-logo" /> Parser Food Delivery</h2>
        <p>Analise os pedidos Food Delivery, valide automaticamente os cancelamentos e concilie os valores devidos aos entregadores.</p>
      </div>
      <div class="bm-filtros">
        <span class="bm-unidade-chip">🏪 ${escapeHtml(unidadeNome || "—")}</span>
        ${podeImportar() ? `<button class="btn btn-primary btn-sm" id="pfd-importar">⬆️ Importar relatório</button>` : ""}
      </div>
    </div>
    <nav class="dex-nav" aria-label="Seções do Parser Food Delivery">
      ${ABAS.map((a) => `<button class="dex-tab ${a.id === pfd.aba ? "ativo" : ""}" data-aba="${a.id}"><span>${a.icon}</span> ${a.label}</button>`).join("")}
    </nav>
    <div id="pfd-periodo-nav"></div>
    <div id="pfd-conteudo" class="bm-conteudo">${skeletonVisaoGeral()}</div>`;

  el("#pfd-importar")?.addEventListener("click", () => abrirImportarFoodDeliveryModal({ unidadeNome, onSalvo: aoConfirmarImportacao }));
  view.querySelectorAll(".dex-tab").forEach((b) => b.addEventListener("click", () => irParaAba(b.dataset.aba)));
}

function irParaAba(aba) {
  pfd.aba = aba;
  el("#view")?.querySelectorAll(".dex-tab").forEach((b) => b.classList.toggle("ativo", b.dataset.aba === aba));
  renderAbaAtual();
}

async function aoConfirmarImportacao(resultado) {
  const g = geracaoContexto();
  pfd.atual = resultado; // { importacao, resumo, entregadores, pedidos }
  pfd.periodo.chave = null;
  await carregarHistorico();
  if (contextoMudou(g)) return;
  pfd.aba = "visao";
  el("#view")?.querySelectorAll(".dex-tab").forEach((b) => b.classList.toggle("ativo", b.dataset.aba === "visao"));
  renderAbaAtual();
}

async function carregarHistorico() {
  const g = geracaoContexto();
  pfd.carregandoHistorico = true;
  try {
    const { data } = await pfdImportacoes();
    if (contextoMudou(g)) return false;
    pfd.historico = data;
    return true;
  } catch (e) {
    if (contextoMudou(g)) return false;
    toast("Erro ao carregar histórico: " + e.message);
    pfd.historico = pfd.historico || [];
    return false;
  } finally {
    if (!contextoMudou(g)) pfd.carregandoHistorico = false;
  }
}

async function abrirImportacao(id, { silencioso = false } = {}) {
  const g = geracaoContexto();
  try {
    const { data } = await pfdImportacaoDetalhe(id);
    if (contextoMudou(g)) return false;
    pfd.atual = data;
    if (!silencioso) { pfd.aba = "visao"; renderAbaAtual(); }
    else atualizarPeriodoNav();
    return true;
  } catch (e) {
    if (contextoMudou(g)) return false;
    toast("Erro ao abrir importação: " + e.message);
    return false;
  }
}

function renderAbaAtual() {
  const box = el("#pfd-conteudo");
  if (!box) return;
  if (pfd.aba === "historico") { box.innerHTML = skeletonTabela(); renderHistorico(box); atualizarPeriodoNav(); return; }
  if (!pfd.atual) {
    box.innerHTML = vazio("🛵", "Nenhuma importação para este período",
      podeImportar() ? "Importe um relatório Food Delivery ou abra uma importação no Histórico." : "Nenhuma importação disponível para esta unidade ainda.",
      pfd.historico?.length ? `<button class="btn btn-ghost btn-sm" id="pfd-ir-historico">📚 Ver Histórico</button>` : "");
    el("#pfd-ir-historico")?.addEventListener("click", () => irParaAba("historico"));
    atualizarPeriodoNav();
    return;
  }
  if (pfd.aba === "visao") renderVisaoGeral(box);
  else if (pfd.aba === "pedidos") renderPedidos(box);
  else if (pfd.aba === "cancelamentos") renderCancelamentos(box);
  else if (pfd.aba === "entregadores") renderEntregadores(box);
  atualizarPeriodoNav();
}

// ---------------------------------------------------------------------------
// NAVEGAÇÃO DE PERÍODO — chips rápidos + setas ‹ › entre importações
// adjacentes. Períodos que cobrem mais de UMA importação (7 dias/mês/
// personalizado) consolidam os relatórios encontrados no histórico (sem
// endpoint novo: cada detalhe já vem de pfdImportacaoDetalhe, em paralelo).
// ---------------------------------------------------------------------------
function isoLocalPfd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function datasDoPeriodoPfd(p) {
  const hoje = new Date();
  if (p === "hoje") return [isoLocalPfd(hoje), isoLocalPfd(hoje)];
  if (p === "ontem") { const d = new Date(hoje); d.setDate(d.getDate() - 1); return [isoLocalPfd(d), isoLocalPfd(d)]; }
  if (p === "7d") { const d = new Date(hoje); d.setDate(d.getDate() - 6); return [isoLocalPfd(d), isoLocalPfd(hoje)]; }
  if (p === "mes") return [isoLocalPfd(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), isoLocalPfd(hoje)];
  return [null, null];
}

function resumoFonte(imp) {
  return { id: imp.id, nomeArquivo: imp.nomeArquivo, periodoInicio: imp.periodoInicio, periodoFim: imp.periodoFim, criadoEm: imp.criadoEm, usuarioNome: imp.usuarioNome };
}
function somarResumos(lista) {
  const campos = ["totalPedidos", "entregues", "cancelados", "canceladosComTaxa", "canceladosSemTaxa", "canceladosRecebemTaxa", "canceladosNaoRecebemTaxa", "canceladosRevisao", "taxasBrutas", "taxasDescartadas", "taxasValidas"];
  const out = {};
  for (const c of campos) out[c] = arred(lista.reduce((s, r) => s + (r[c] || 0), 0));
  return out;
}
function mesclarEntregadores(lista) {
  const porNome = new Map();
  for (const e of lista) {
    if (!porNome.has(e.entregador)) porNome.set(e.entregador, { entregador: e.entregador, totalPedidos: 0, entregues: 0, canceladosComTaxa: 0, canceladosSemTaxa: 0, canceladosRevisao: 0, taxasValidas: 0 });
    const g = porNome.get(e.entregador);
    g.totalPedidos += e.totalPedidos; g.entregues += e.entregues; g.canceladosComTaxa += e.canceladosComTaxa;
    g.canceladosSemTaxa += e.canceladosSemTaxa; g.canceladosRevisao += (e.canceladosRevisao || 0);
    g.taxasValidas = arred(g.taxasValidas + e.taxasValidas);
  }
  return [...porNome.values()];
}
function consolidarImportacoes(detalhes) {
  const periodoInicio = detalhes.reduce((min, d) => (!min || d.importacao.periodoInicio < min ? d.importacao.periodoInicio : min), null);
  const periodoFim = detalhes.reduce((max, d) => (!max || d.importacao.periodoFim > max ? d.importacao.periodoFim : max), null);
  return {
    consolidado: true,
    importacao: {
      id: null, periodoInicio, periodoFim, nomeArquivo: null, usuarioNome: null, criadoEm: null,
      codigosSemTaxa: [], colunaDetalhesEncontrada: detalhes.every((d) => d.importacao.colunaDetalhesEncontrada !== false),
      totalPedidos: detalhes.reduce((s, d) => s + (d.importacao.totalPedidos || 0), 0),
    },
    resumo: somarResumos(detalhes.map((d) => d.resumo)),
    entregadores: mesclarEntregadores(detalhes.flatMap((d) => d.entregadores)),
    pedidos: detalhes.flatMap((d) => d.pedidos),
    pedidosIgnorados: detalhes.flatMap((d) => d.pedidosIgnorados),
    fontes: detalhes.map((d) => resumoFonte(d.importacao)),
  };
}

async function selecionarPeriodo(chave, custom = {}) {
  const g = geracaoContexto();
  pfd.periodo.chave = chave;
  let ini, fim;
  if (chave === "custom") {
    ini = custom.ini ?? pfd.periodo.ini; fim = custom.fim ?? pfd.periodo.fim;
    pfd.periodo.ini = ini; pfd.periodo.fim = fim;
    if (!ini || !fim) { atualizarPeriodoNav(); return; }
  } else {
    [ini, fim] = datasDoPeriodoPfd(chave);
    pfd.periodo.ini = ini; pfd.periodo.fim = fim;
  }

  const candidatos = (pfd.historico || []).filter((h) => h.periodoInicio && h.periodoFim && h.periodoInicio <= fim && h.periodoFim >= ini);
  if (!candidatos.length) {
    pfd.atual = null; pfd.aba = pfd.aba === "historico" ? "historico" : "visao";
    toast("Nenhuma importação encontrada para este período.");
    renderAbaAtual();
    return;
  }
  if (candidatos.length === 1) { await abrirImportacao(candidatos[0].id); atualizarPeriodoNav(); return; }

  const box = el("#pfd-conteudo");
  if (box) box.innerHTML = skeletonVisaoGeral();
  try {
    const detalhes = await Promise.all(candidatos.map((c) => pfdImportacaoDetalhe(c.id).then((r) => r.data)));
    if (contextoMudou(g)) return; // trocou de unidade enquanto consolidava — não pinta dados da unidade anterior
    pfd.atual = consolidarImportacoes(detalhes);
    pfd.aba = "visao";
  } catch (e) {
    if (contextoMudou(g)) return;
    toast("Erro ao consolidar período: " + e.message);
  }
  renderAbaAtual();
}

function historicoOrdenadoPorPeriodo() {
  return [...(pfd.historico || [])].filter((h) => h.periodoInicio).sort((a, b) => (a.periodoInicio < b.periodoInicio ? -1 : a.periodoInicio > b.periodoInicio ? 1 : 0));
}
async function navegarImportacaoAdjacente(direcao) {
  const lista = historicoOrdenadoPorPeriodo();
  const idx = lista.findIndex((h) => h.id === pfd.atual?.importacao?.id);
  if (idx < 0) return;
  const alvo = lista[idx + direcao];
  if (!alvo) { toast(direcao > 0 ? "Não há importação mais recente." : "Não há importação anterior."); return; }
  pfd.periodo.chave = null;
  await abrirImportacao(alvo.id);
}

function renderPeriodoNavHtml() {
  if (pfd.aba === "historico" || !pfd.historico?.length) return "";
  const custom = pfd.periodo.chave === "custom";
  const mostrarSetas = !custom && pfd.atual && !pfd.atual.consolidado && pfd.atual.importacao?.id;
  return `
    <div class="pfd-periodo-nav">
      <div class="vd-chips">
        ${PERIODOS_PFD.map(([v, l]) => `<button class="vd-chip ${v === pfd.periodo.chave ? "ativo" : ""}" data-periodo="${v}">${l}</button>`).join("")}
      </div>
      ${custom ? `<span class="pfd-periodo-custom">
          <input type="date" id="pfd-periodo-custom-ini" value="${pfd.periodo.ini || ""}">
          <span>—</span>
          <input type="date" id="pfd-periodo-custom-fim" value="${pfd.periodo.fim || ""}">
        </span>` : ""}
      ${mostrarSetas ? `
        <span class="pfd-periodo-setas">
          <button class="btn btn-ghost btn-sm" id="pfd-periodo-anterior" title="Importação anterior">‹</button>
          <b>${fmtPeriodo(pfd.atual.importacao.periodoInicio, pfd.atual.importacao.periodoFim)}</b>
          <button class="btn btn-ghost btn-sm" id="pfd-periodo-seguinte" title="Importação seguinte">›</button>
        </span>` : ""}
    </div>`;
}
function atualizarPeriodoNav() {
  const alvo = el("#pfd-periodo-nav");
  if (!alvo) return;
  alvo.innerHTML = renderPeriodoNavHtml();
  alvo.querySelectorAll("[data-periodo]").forEach((b) => b.addEventListener("click", () => selecionarPeriodo(b.dataset.periodo)));
  const aplicarCustom = () => {
    const ini = el("#pfd-periodo-custom-ini")?.value, fim = el("#pfd-periodo-custom-fim")?.value;
    if (ini && fim) selecionarPeriodo("custom", { ini, fim });
  };
  el("#pfd-periodo-custom-ini")?.addEventListener("change", aplicarCustom);
  el("#pfd-periodo-custom-fim")?.addEventListener("change", aplicarCustom);
  el("#pfd-periodo-anterior")?.addEventListener("click", () => navegarImportacaoAdjacente(-1));
  el("#pfd-periodo-seguinte")?.addEventListener("click", () => navegarImportacaoAdjacente(1));
}

// ---------------------------------------------------------------------------
// DRAWER lateral (mesmo padrão de bonificacaoMensal.js#abrirDrawerDia) —
// reaproveitado tanto pros "Detalhes do relatório" quanto pro detalhe de um
// cancelamento (timeline + classificação + alteração manual).
// ---------------------------------------------------------------------------
let pfdDrawerEl = null;
function fecharPfdDrawer() {
  if (!pfdDrawerEl) return;
  pfdDrawerEl.classList.remove("aberto");
  const alvo = pfdDrawerEl;
  setTimeout(() => alvo.remove(), 220);
  pfdDrawerEl = null;
  document.removeEventListener("keydown", onEscPfdDrawer);
}
function onEscPfdDrawer(e) { if (e.key === "Escape") fecharPfdDrawer(); }
function abrirPfdDrawer(html) {
  fecharPfdDrawer();
  pfdDrawerEl = document.createElement("div");
  pfdDrawerEl.className = "bm-drawer-overlay";
  pfdDrawerEl.innerHTML = `<aside class="bm-drawer"><button class="modal-close" aria-label="Fechar">×</button><div class="bm-drawer-conteudo">${html}</div></aside>`;
  pfdDrawerEl.addEventListener("click", (e) => { if (e.target === pfdDrawerEl) fecharPfdDrawer(); });
  document.body.appendChild(pfdDrawerEl);
  document.addEventListener("keydown", onEscPfdDrawer);
  requestAnimationFrame(() => pfdDrawerEl.classList.add("aberto"));
  pfdDrawerEl.querySelector(".modal-close").addEventListener("click", fecharPfdDrawer);
  return pfdDrawerEl;
}

function abrirDrawerRelatorio() {
  const fontes = pfd.atual.fontes || (pfd.atual.importacao?.id ? [resumoFonte(pfd.atual.importacao)] : []);
  const item = (lbl, val) => `<div class="vd-pv-item"><span>${lbl}</span><b>${val}</b></div>`;
  abrirPfdDrawer(`
    <h3>📄 Detalhes do relatório</h3>
    ${fontes.length ? fontes.map((f) => `
      <div class="bm-drawer-bloco">
        <div class="vd-pv-titulo">${escapeHtml(f.nomeArquivo || "Arquivo")}</div>
        <div class="vd-pv-grid">
          ${item("Período", fmtPeriodo(f.periodoInicio, f.periodoFim))}
          ${item("Importado por", escapeHtml(f.usuarioNome || "—"))}
          ${item("Data/hora", fmtDataHora(f.criadoEm))}
        </div>
      </div>`).join("") : `<p class="dex-diag-vazio">Sem detalhes de origem disponíveis.</p>`}
    ${fontes.length > 1 ? `<p class="dex-diag-vazio">Visão consolidada de ${fontes.length} relatórios — edição/exclusão desabilitadas neste modo.</p>` : ""}
  `);
}

// ---------------------------------------------------------------------------
// VISÃO GERAL
// ---------------------------------------------------------------------------
function distribuicaoBar(itens) {
  const total = itens.reduce((s, i) => s + i.valor, 0) || 1;
  const barras = itens.filter((i) => i.valor > 0)
    .map((i) => `<div class="pfd-dist-segment pfd-dist-${i.cor}" style="width:${(i.valor / total * 100).toFixed(2)}%" title="${escapeHtml(i.label)}: ${i.valor}"></div>`).join("");
  const legenda = itens.map((i) => `<span class="pfd-dist-leg-item"><i class="pfd-dist-dot pfd-dist-${i.cor}"></i>${escapeHtml(i.label)} <b>${i.valor}</b></span>`).join("");
  return `<div class="pfd-dist-bar">${barras}</div><div class="pfd-dist-legenda">${legenda}</div>`;
}

function distribuicaoDoRelatorioHtml() {
  const { importacao, resumo } = pfd.atual;
  const semColunaDetalhes = importacao.colunaDetalhesEncontrada === false;
  const total = importacao.totalPedidos || 0;
  const itens = [
    { label: "Subway Saci", valor: importacao.pedidosSubway ?? resumo.totalPedidos, cor: "ok" },
    { label: "Açaí no Grau", valor: importacao.pedidosAcai ?? 0, cor: "info" },
    { label: "Sem entregador", valor: importacao.pedidosSemEntregador ?? 0, cor: "muted" },
    { label: "Operação indefinida", valor: importacao.pedidosRevisao ?? 0, cor: "warn" },
  ];
  const excluidos = (importacao.pedidosAcai || 0) + (importacao.pedidosSemEntregador || 0) + (importacao.pedidosRevisao || 0);
  return `
    <p style="margin-top:6px"><b>${total}</b> pedidos encontrados</p>
    ${distribuicaoBar(itens)}
    ${semColunaDetalhes ? `<p class="dex-diag-vazio" style="margin-top:8px">⚠️ Este relatório não trouxe a coluna "Detalhes do pedido" — não foi possível separar por operação; todos os pedidos foram considerados Subway Saci.</p>` : ""}
    ${excluidos > 0 ? `<p class="dex-diag-vazio" style="margin-top:6px">${excluidos} pedido(s) foram excluídos da análise principal.</p><button class="btn btn-ghost btn-sm" id="pfd-ver-ignorados-visao" style="margin-top:6px">👁️ Ver pedidos excluídos</button>` : ""}`;
}

function renderVisaoGeral(box) {
  const { importacao, resumo, entregadores } = pfd.atual;
  const consolidado = !!pfd.atual.consolidado;
  const top = [...entregadores].sort((a, b) => b.taxasValidas - a.taxasValidas).slice(0, 5);
  const temRevisaoPendente = resumo.canceladosRevisao > 0;

  const card = (icone, lbl, val, sub = "", destaque = false) => `
    <div class="vd-card${destaque ? " destaque" : ""}">
      <div class="vd-card-topo"><span class="vd-card-ico">${icone}</span><span class="vd-card-lbl">${lbl}</span></div>
      <div class="vd-card-val">${val}</div>${sub ? `<div class="vd-card-sub">${sub}</div>` : ""}
    </div>`;

  box.innerHTML = `
    <div class="pfd-ultima-import">
      ${consolidado
        ? `<span>Período consolidado — <b>${pfd.atual.fontes.length} relatórios</b></span>`
        : `<span>Última importação: <b>${fmtDataHora(importacao.criadoEm)}</b> por <b>${escapeHtml(importacao.usuarioNome || "—")}</b></span>`}
      <button class="btn btn-ghost btn-sm" id="pfd-detalhes-relatorio">📄 Detalhes do relatório</button>
    </div>

    <div class="vd-cards pfd-kpis">
      ${card("🧾", "Pedidos Subway", resumo.totalPedidos, "pedidos válidos da operação")}
      ${card("✅", "Entregues / Finalizados", resumo.entregues)}
      ${card("🚫", "Cancelados", resumo.cancelados)}
      ${card("💰", "Valor devido aos entregadores", fmtMoeda(resumo.taxasValidas), "", true)}
    </div>

    <div class="pfd-indicadores-sec">
      <span class="pill ok">🟢 ${resumo.canceladosRecebemTaxa} cancelados com taxa</span>
      <span class="pill muted">⚪ ${resumo.canceladosNaoRecebemTaxa} cancelados sem taxa</span>
      <span class="pill warn">🟡 ${resumo.canceladosRevisao} para revisar</span>
      <span class="pill bad">➖ ${fmtMoeda(resumo.taxasDescartadas)} descartados</span>
    </div>

    <div class="bm-pv-bloco" style="margin-top:18px">
      <b>📦 Distribuição do relatório</b>
      ${distribuicaoDoRelatorioHtml()}
    </div>

    <div class="pfd-conciliacao">
      <div class="pfd-conc-linha"><span>Taxas encontradas</span><b>${fmtMoeda(resumo.taxasBrutas)}</b></div>
      <div class="pfd-conc-linha pfd-conc-neg"><span>Taxas descartadas</span><b>− ${fmtMoeda(resumo.taxasDescartadas)}</b></div>
      <div class="pfd-conc-divisor"></div>
      <div class="pfd-conc-linha pfd-conc-final"><span>Valor final devido</span><b>${fmtMoeda(resumo.taxasValidas)}</b></div>
    </div>

    <div class="bm-pv-bloco" style="margin-top:18px">
      <b>🔎 Análise dos cancelamentos</b>
      <p class="dex-diag-vazio" style="margin-top:6px">
        ${resumo.cancelados === 0 ? "Nenhum pedido cancelado neste período."
          : temRevisaoPendente ? `Existem <b>${resumo.canceladosRevisao}</b> cancelamento(s) que precisam de validação manual.`
          : "Todos os cancelamentos foram classificados automaticamente."}
      </p>
      ${resumo.cancelados > 0 ? `<button class="btn btn-ghost btn-sm" id="pfd-ver-cancelamentos" style="margin-top:8px">Ver análise dos cancelados →</button>` : ""}
    </div>

    <div class="bm-pv-bloco" style="margin-top:18px">
      <b>🏆 Ranking resumido de entregadores</b>
      <div class="tabela-wrap"><table class="grid">
        <thead><tr><th>Entregador</th><th class="num">Entregas</th><th class="num">Cancel. com taxa</th><th class="num">Cancel. sem taxa</th><th class="num">Taxas válidas</th></tr></thead>
        <tbody>${top.map((e) => `<tr><td>${escapeHtml(e.entregador)}</td><td class="num">${e.entregues}</td><td class="num">${e.canceladosComTaxa}</td><td class="num">${e.canceladosSemTaxa}</td><td class="num">${fmtMoeda(e.taxasValidas)}</td></tr>`).join("")}</tbody>
      </table></div>
      <button class="btn btn-ghost btn-sm" id="pfd-ver-todos-entregadores" style="margin-top:10px">Ver todos os entregadores →</button>
    </div>`;

  el("#pfd-detalhes-relatorio")?.addEventListener("click", abrirDrawerRelatorio);
  el("#pfd-ver-todos-entregadores")?.addEventListener("click", () => irParaAba("entregadores"));
  el("#pfd-ver-cancelamentos")?.addEventListener("click", () => irParaAba("cancelamentos"));
  el("#pfd-ver-ignorados-visao")?.addEventListener("click", () => { pfd.verIgnorados = true; irParaAba("pedidos"); });
}

// ---------------------------------------------------------------------------
// PEDIDOS — tabela pesquisável e filtrável
// ---------------------------------------------------------------------------
const FILTROS_STATUS = [
  ["todos", "Todos"], ["entregues", "Entregues"], ["cancelados", "Cancelados"],
  ["com_taxa", "Com taxa"], ["sem_taxa", "Sem taxa"],
];

function pedidosFiltrados() {
  const termo = pfd.filtros.busca.trim().toLowerCase();
  return pfd.atual.pedidos.filter((p) => {
    if (termo && !`${p.numeroPedido} ${p.entregador || ""}`.toLowerCase().includes(termo)) return false;
    if (pfd.filtros.entregador !== "todos" && p.entregador !== pfd.filtros.entregador) return false;
    if (pfd.filtros.status === "entregues" && p.statusConciliacao !== "incluido") return false;
    if (pfd.filtros.status === "cancelados" && p.statusConciliacao === "incluido") return false;
    if (pfd.filtros.status === "com_taxa" && p.statusConciliacao === "excluido") return false;
    if (pfd.filtros.status === "sem_taxa" && p.statusConciliacao !== "excluido") return false;
    return true;
  });
}

function renderPedidos(box) {
  const entregadoresUnicos = [...new Set(pfd.atual.pedidos.map((p) => p.entregador).filter(Boolean))].sort();
  const qtdIgnorados = pfd.atual.pedidosIgnorados?.length || 0;
  box.innerHTML = `
    <div class="ed-acoes" style="justify-content:flex-start;margin-bottom:12px">
      <button class="btn btn-sm ${pfd.verIgnorados ? "btn-ghost" : "btn-primary"}" id="pfd-toggle-subway">🧾 Pedidos Subway (${pfd.atual.pedidos.length})</button>
      <button class="btn btn-sm ${pfd.verIgnorados ? "btn-primary" : "btn-ghost"}" id="pfd-toggle-ignorados">👁️ Pedidos ignorados (${qtdIgnorados})</button>
    </div>
    ${pfd.verIgnorados ? `<div id="pfd-tabela-pedidos"></div>` : `
    <div class="vd-filtros">
      <div class="busca"><input id="pfd-busca" type="search" placeholder="Buscar por código ou entregador..." value="${escapeHtml(pfd.filtros.busca)}"></div>
      <div class="vd-f-bloco"><span class="vd-f-lbl">Status</span><div class="vd-chips">
        ${FILTROS_STATUS.map(([v, l]) => `<button class="vd-chip ${v === pfd.filtros.status ? "ativo" : ""}" data-status="${v}">${l}</button>`).join("")}
      </div></div>
      <div class="vd-f-bloco"><span class="vd-f-lbl">Entregador</span>
        <select id="pfd-f-entregador"><option value="todos">Todos</option>${entregadoresUnicos.map((n) => `<option value="${escapeHtml(n)}" ${n === pfd.filtros.entregador ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")}</select>
      </div>
    </div>
    <div id="pfd-tabela-pedidos"></div>`}`;

  el("#pfd-toggle-subway").addEventListener("click", () => { pfd.verIgnorados = false; renderPedidos(box); });
  el("#pfd-toggle-ignorados").addEventListener("click", () => { pfd.verIgnorados = true; renderPedidos(box); });

  if (pfd.verIgnorados) { renderTabelaIgnorados(); return; }

  el("#pfd-busca").addEventListener("input", (e) => { pfd.filtros.busca = e.target.value; renderTabelaPedidos(); });
  el("#pfd-f-entregador").addEventListener("change", (e) => { pfd.filtros.entregador = e.target.value; renderTabelaPedidos(); });
  box.querySelectorAll(".vd-chip").forEach((b) => b.addEventListener("click", () => {
    pfd.filtros.status = b.dataset.status;
    box.querySelectorAll(".vd-chip").forEach((x) => x.classList.toggle("ativo", x === b));
    renderTabelaPedidos();
  }));
  renderTabelaPedidos();
}

function renderTabelaPedidos() {
  const alvo = el("#pfd-tabela-pedidos");
  if (!alvo) return;
  const lista = pedidosFiltrados();
  if (!lista.length) { alvo.innerHTML = vazio("🔍", "Nenhum pedido encontrado", "Ajuste a busca ou os filtros."); return; }
  alvo.innerHTML = `<div class="tabela-wrap"><table class="grid">
    <thead><tr><th>Código</th><th>Data</th><th>Entregador</th><th>Situação</th><th class="num">Taxa do entregador</th><th>Status</th><th>Classificação</th></tr></thead>
    <tbody>${lista.map((p) => {
      const st = STATUS_ROTULO[p.statusConciliacao] || { label: p.statusConciliacao, classe: "muted" };
      const cancelado = p.statusConciliacao !== "incluido";
      const efetiva = cancelado ? classificacaoEfetiva(p) : null;
      const cl = efetiva ? (CLASSIFICACAO_ROTULO[efetiva] || { label: efetiva, classe: "muted" }) : null;
      return `<tr>
        <td>${escapeHtml(p.numeroPedido)}</td>
        <td>${fmtDataHora(p.dataHora)}</td>
        <td>${escapeHtml(p.entregador || "—")}</td>
        <td>${escapeHtml(p.situacao || "—")}</td>
        <td class="num">${fmtMoeda(p.taxaEntregador)}</td>
        <td><span class="pill ${st.classe}">${st.label}</span></td>
        <td>${cl ? `<span class="pill ${cl.classe}">${cl.label}</span>` : "—"}</td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>
  <p class="dex-diag-vazio">${lista.length} de ${pfd.atual.pedidos.length} pedidos.</p>`;
}

// ---------------------------------------------------------------------------
// "VER PEDIDOS IGNORADOS" — conferir se o parser não descartou algo
// incorretamente. Mostra código, descrição, motivo e a operação identificada.
// ---------------------------------------------------------------------------
function renderTabelaIgnorados() {
  const alvo = el("#pfd-tabela-pedidos");
  if (!alvo) return;
  const lista = pfd.atual.pedidosIgnorados || [];
  if (!lista.length) { alvo.innerHTML = vazio("✅", "Nenhum pedido ignorado", "Todos os pedidos deste relatório foram identificados como Subway Saci."); return; }
  alvo.innerHTML = `<div class="tabela-wrap"><table class="grid">
    <thead><tr><th>Código</th><th>Descrição / produtos</th><th>Motivo</th><th>Classificação</th></tr></thead>
    <tbody>${lista.map((p) => {
      const classe = CLASSE_IGNORADO[p.operacao] || "muted";
      return `<tr>
        <td>${escapeHtml(p.numeroPedido)}</td>
        <td style="white-space:normal;max-width:360px">${escapeHtml((p.detalhesPedido || "—").slice(0, 160))}</td>
        <td style="white-space:normal;max-width:280px">${escapeHtml(p.motivoIgnorado || "—")}</td>
        <td><span class="pill ${classe}">${escapeHtml(p.classificacaoIgnorado || p.operacao)}</span></td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>
  <p class="dex-diag-vazio">${lista.length} pedido(s) ignorado(s) desta conciliação — não entram em nenhum valor financeiro.</p>`;
}

// ---------------------------------------------------------------------------
// CANCELAMENTOS — a principal aba nova: filtra/pesquisa os cancelados e
// abre o detalhe (timeline + classificação automática + alteração manual).
// ---------------------------------------------------------------------------
/** "Classificação efetiva": se há override manual, deriva do status pós-override; senão usa a decisão automática do motor. */
function classificacaoEfetiva(p) {
  if (p.classificacaoOverrideEm) return p.statusConciliacao === "excluido" ? "nao_recebe_taxa" : "recebe_taxa";
  return p.classificacaoCancelamento || (p.statusConciliacao === "excluido" ? "nao_recebe_taxa" : "recebe_taxa");
}
function pedidosCancelados() { return (pfd.atual?.pedidos || []).filter((p) => p.statusConciliacao !== "incluido"); }
function cancelamentosFiltrados() {
  const termo = pfd.filtrosCancelamentos.busca.trim().toLowerCase();
  return pedidosCancelados().filter((p) => {
    if (termo && !`${p.numeroPedido} ${p.entregador || ""}`.toLowerCase().includes(termo)) return false;
    if (pfd.filtrosCancelamentos.status !== "todos" && classificacaoEfetiva(p) !== pfd.filtrosCancelamentos.status) return false;
    return true;
  });
}

function renderCancelamentos(box) {
  const total = pedidosCancelados().length;
  if (!total) { box.innerHTML = vazio("✅", "Nenhum cancelamento neste período", "Todos os pedidos deste período foram entregues normalmente."); return; }
  box.innerHTML = `
    <div class="vd-filtros">
      <div class="busca"><input id="pfd-canc-busca" type="search" placeholder="Buscar por código ou entregador..." value="${escapeHtml(pfd.filtrosCancelamentos.busca)}"></div>
      <div class="vd-f-bloco"><span class="vd-f-lbl">Classificação</span><div class="vd-chips">
        ${FILTROS_CANCELAMENTO.map(([v, l]) => `<button class="vd-chip ${v === pfd.filtrosCancelamentos.status ? "ativo" : ""}" data-status-canc="${v}">${l}</button>`).join("")}
      </div></div>
    </div>
    <div id="pfd-tabela-cancelamentos"></div>`;
  el("#pfd-canc-busca").addEventListener("input", (e) => { pfd.filtrosCancelamentos.busca = e.target.value; renderTabelaCancelamentos(); });
  box.querySelectorAll("[data-status-canc]").forEach((b) => b.addEventListener("click", () => {
    pfd.filtrosCancelamentos.status = b.dataset.statusCanc;
    box.querySelectorAll("[data-status-canc]").forEach((x) => x.classList.toggle("ativo", x === b));
    renderTabelaCancelamentos();
  }));
  renderTabelaCancelamentos();
}

function renderTabelaCancelamentos() {
  const alvo = el("#pfd-tabela-cancelamentos");
  if (!alvo) return;
  const lista = cancelamentosFiltrados();
  if (!lista.length) { alvo.innerHTML = vazio("🔍", "Nenhum cancelamento encontrado", "Ajuste a busca ou os filtros."); return; }
  alvo.innerHTML = `<div class="tabela-wrap"><table class="grid">
    <thead><tr><th>Pedido</th><th>Entregador</th><th>Confiança</th><th>Classificação</th><th class="num">Taxa</th><th></th></tr></thead>
    <tbody>${lista.map((p) => {
      const efetiva = classificacaoEfetiva(p);
      const cl = CLASSIFICACAO_ROTULO[efetiva] || { label: efetiva, classe: "muted" };
      const conf = p.classificacaoOverrideEm ? "Alterado manualmente" : (CONFIANCA_ROTULO[p.classificacaoNivelConfianca] || "Sem análise automática");
      return `<tr>
        <td>${escapeHtml(p.numeroPedido)}</td>
        <td>${escapeHtml(p.entregador || "—")}</td>
        <td>${escapeHtml(conf)}</td>
        <td><span class="pill ${cl.classe}">${cl.label}</span></td>
        <td class="num">${fmtMoeda(p.taxaEntregador)}</td>
        <td><button class="btn btn-ghost btn-sm" data-ver-canc="${p.id}">Ver detalhes</button></td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>
  <p class="dex-diag-vazio">${lista.length} de ${pedidosCancelados().length} cancelamento(s).</p>`;
  alvo.querySelectorAll("[data-ver-canc]").forEach((b) => b.addEventListener("click", () => abrirDrawerCancelamento(b.dataset.verCanc)));
}

function duracaoHumanaFront(iniIso, fimIso) {
  if (!iniIso || !fimIso) return null;
  const ini = new Date(iniIso).getTime(), fim = new Date(fimIso).getTime();
  if (Number.isNaN(ini) || Number.isNaN(fim) || fim < ini) return null;
  const totalSeg = Math.round((fim - ini) / 1000);
  const min = Math.floor(totalSeg / 60), seg = totalSeg % 60;
  return min > 0 ? `${min}min${String(seg).padStart(2, "0")}s` : `${seg}s`;
}

function eventosTimeline(pedido) {
  return ETAPAS_TIMELINE
    .map(([campo, label], ordem) => ({ campo, label, ordem, data: pedido[campo], ms: new Date(pedido[campo]).getTime() }))
    .filter((e) => e.data && !Number.isNaN(e.ms))
    .sort((a, b) => a.ms - b.ms || a.ordem - b.ordem);
}

function timelineInconsistente(eventos) {
  return eventos.some((e, i) => i > 0 && e.ordem < eventos[i - 1].ordem);
}

function abrirDrawerCancelamento(pedidoId) {
  const p = (pfd.atual?.pedidos || []).find((x) => x.id === pedidoId);
  if (!p) return;
  abrirPfdDrawer(drawerCancelamentoHtml(p));
  wireDrawerCancelamento(p);
}

function drawerCancelamentoHtml(p) {
  const passos = eventosTimeline(p);
  const inconsistente = timelineInconsistente(passos);
  const efetiva = classificacaoEfetiva(p);
  const cl = CLASSIFICACAO_ROTULO[efetiva] || { label: efetiva, classe: "muted" };
  const durColetaCancel = duracaoHumanaFront(p.dataColetado, p.dataCancelado);
  const podeAlterar = podeClassificar() && !pfd.atual.consolidado && pfd.atual.importacao?.id;

  return `
    <h3>Pedido #${escapeHtml(p.numeroPedido)}</h3>
    <p class="dex-diag-vazio">${escapeHtml(p.entregador || "—")}</p>
    ${passos.length ? `
      <ul class="hist-timeline pfd-timeline">
        ${passos.map(({ campo, label }) => `
          <li class="hist-evento">
            <span class="hist-avatar pfd-timeline-dot ${campo === "dataCancelado" ? "pfd-timeline-dot-cancelado" : ""}">${campo === "dataCancelado" ? "🚫" : "•"}</span>
            <div class="hist-corpo">
              <div class="hist-cabecalho"><b>${label}</b></div>
              <div class="hist-data">${fmtDataHora(p[campo])}</div>
            </div>
          </li>`).join("")}
      </ul>
      ${inconsistente ? `<p class="dex-diag-vazio"><span class="pill warn">atenção</span> Há eventos fora da ordem operacional esperada neste relatório.</p>` : ""}
      ${durColetaCancel ? `<p class="dex-diag-vazio">${durColetaCancel} entre coleta e cancelamento.</p>` : ""}
    ` : `<p class="dex-diag-vazio">Este relatório não trouxe os horários de despacho/aceite/coleta deste pedido.</p>`}

    <div class="bm-drawer-bloco">
      <span class="pill ${cl.classe}" style="font-size:14px">${cl.label}${p.taxaEntregador != null ? ` — ${fmtMoeda(p.taxaEntregador)}` : ""}</span>
      <p style="margin-top:8px">${escapeHtml(p.classificacaoMotivo || "Sem análise automática registrada (importação anterior à automação, ou motivo indisponível).")}</p>
      ${p.classificacaoOverrideEm ? `<p class="dex-diag-vazio">Alterado manualmente por <b>${escapeHtml(p.classificacaoOverrideUsuarioNome || "—")}</b> em ${fmtDataHora(p.classificacaoOverrideEm)}. Motivo: "${escapeHtml(p.classificacaoOverrideMotivo || "")}"</p>` : ""}
    </div>

    ${p.razaoCancelamento || p.justificativaCancelamento ? `
      <div class="bm-drawer-bloco">
        <div class="vd-pv-titulo">Razão / justificativa do cancelamento</div>
        <p class="dex-diag-vazio">${escapeHtml(p.razaoCancelamento || "—")}${p.justificativaCancelamento ? " — " + escapeHtml(p.justificativaCancelamento) : ""}</p>
      </div>` : ""}

    ${podeAlterar ? `
      <div class="bm-drawer-bloco" id="pfd-override-bloco">
        <button class="btn btn-ghost btn-sm" id="pfd-abrir-override">✏️ Alterar classificação</button>
        <div id="pfd-override-form" hidden>
          <div class="vd-chips" style="margin-top:8px">
            <button class="vd-chip" data-destino="recebe_taxa">🟢 Recebe taxa</button>
            <button class="vd-chip" data-destino="nao_recebe_taxa">⚪ Não recebe taxa</button>
          </div>
          <textarea id="pfd-override-motivo" placeholder="Motivo da alteração (obrigatório)" class="pfd-override-textarea"></textarea>
          <div class="ed-acoes"><button class="btn btn-primary btn-sm" id="pfd-confirmar-override" disabled>Confirmar alteração</button></div>
        </div>
      </div>` : ""}`;
}

function wireDrawerCancelamento(p) {
  const abrir = el("#pfd-abrir-override");
  const form = el("#pfd-override-form");
  abrir?.addEventListener("click", () => { form.hidden = false; abrir.hidden = true; });
  let destino = null;
  const btnConfirmar = el("#pfd-confirmar-override");
  const motivoEl = el("#pfd-override-motivo");
  const checar = () => { if (btnConfirmar) btnConfirmar.disabled = !destino || motivoEl.value.trim().length < 3; };
  pfdDrawerEl?.querySelectorAll("[data-destino]").forEach((b) => b.addEventListener("click", () => {
    destino = b.dataset.destino;
    pfdDrawerEl.querySelectorAll("[data-destino]").forEach((x) => x.classList.toggle("ativo", x === b));
    checar();
  }));
  motivoEl?.addEventListener("input", checar);
  btnConfirmar?.addEventListener("click", async () => {
    const g = geracaoContexto();
    const importacaoId = pfd.atual.importacao.id;
    btnConfirmar.disabled = true; btnConfirmar.textContent = "Salvando…";
    try {
      const { data } = await pfdAlterarClassificacao(importacaoId, p.id, { classificacaoFinal: destino, motivo: motivoEl.value.trim() });
      if (contextoMudou(g)) return; // trocou de unidade enquanto salvava — não sobrescreve o estado da unidade nova
      pfd.atual = { ...pfd.atual, ...data };
      await carregarHistorico();
      if (contextoMudou(g)) return;
      toast("Classificação alterada ✅");
      fecharPfdDrawer();
      renderAbaAtual();
    } catch (e) {
      if (contextoMudou(g)) return;
      toast("Erro ao alterar classificação: " + e.message);
      btnConfirmar.disabled = false; btnConfirmar.textContent = "Confirmar alteração";
    }
  });
}

// ---------------------------------------------------------------------------
// ENTREGADORES — ranking
// ---------------------------------------------------------------------------
const ORD_ENTREGADORES = [["taxas", "Valor de taxas"], ["entregas", "Quantidade de entregas"], ["nome", "Nome"]];

function entregadoresOrdenados() {
  const lista = [...pfd.atual.entregadores];
  if (pfd.ordEntregadores === "entregas") return lista.sort((a, b) => b.totalPedidos - a.totalPedidos);
  if (pfd.ordEntregadores === "nome") return lista.sort((a, b) => a.entregador.localeCompare(b.entregador, "pt-BR"));
  return lista.sort((a, b) => b.taxasValidas - a.taxasValidas);
}

function renderEntregadores(box) {
  box.innerHTML = `
    <div class="vd-f-bloco"><span class="vd-f-lbl">Ordenar por</span><div class="vd-chips">
      ${ORD_ENTREGADORES.map(([v, l]) => `<button class="vd-chip ${v === pfd.ordEntregadores ? "ativo" : ""}" data-ord="${v}">${l}</button>`).join("")}
    </div></div>
    <div class="vd-cards-sub" id="pfd-entregadores-lista" style="margin-top:14px"></div>`;
  box.querySelectorAll(".vd-chip").forEach((b) => b.addEventListener("click", () => {
    pfd.ordEntregadores = b.dataset.ord;
    box.querySelectorAll(".vd-chip").forEach((x) => x.classList.toggle("ativo", x === b));
    renderListaEntregadores();
  }));
  renderListaEntregadores();
}

function renderListaEntregadores() {
  const alvo = el("#pfd-entregadores-lista");
  if (!alvo) return;
  const lista = entregadoresOrdenados();
  if (!lista.length) { alvo.innerHTML = vazio("🛵", "Nenhum entregador", "Este relatório não trouxe pedidos com entregador identificado."); return; }
  alvo.innerHTML = lista.map((e, i) => `
    <div class="vd-card">
      <div class="vd-card-topo"><span class="vd-card-ico">${i < 3 ? ["🥇", "🥈", "🥉"][i] : "🛵"}</span><span class="vd-card-lbl">${escapeHtml(e.entregador)}</span></div>
      <div class="vd-card-val">${fmtMoeda(e.taxasValidas)}</div>
      <div class="vd-card-sub">${e.totalPedidos} pedidos · ${e.entregues} entregues · ${e.canceladosComTaxa} cancel. com taxa · ${e.canceladosSemTaxa} cancel. sem taxa${e.canceladosRevisao ? ` · ${e.canceladosRevisao} em revisão` : ""}</div>
    </div>`).join("");
}

// ---------------------------------------------------------------------------
// HISTÓRICO
// ---------------------------------------------------------------------------
async function renderHistorico(box) {
  if (pfd.historico == null) await carregarHistorico();
  if (!pfd.historico?.length) { box.innerHTML = vazio("📚", "Nenhuma importação ainda", "Importações confirmadas aparecem aqui."); return; }
  box.innerHTML = `<div class="tabela-wrap"><table class="grid">
    <thead><tr><th>Período</th><th>Arquivo</th><th class="num">Pedidos</th><th class="num">Taxas válidas</th><th class="num">Taxas descartadas</th><th>Usuário</th><th>Importado em</th><th></th></tr></thead>
    <tbody>${pfd.historico.map((h) => `
      <tr class="pfd-hist-linha" data-id="${h.id}" style="cursor:pointer">
        <td>${fmtPeriodo(h.periodoInicio, h.periodoFim)}</td>
        <td>${escapeHtml(h.nomeArquivo || "—")}</td>
        <td class="num">${h.totalPedidos}</td>
        <td class="num">${fmtMoeda(h.taxasValidas)}</td>
        <td class="num">${fmtMoeda(h.taxasDescartadas)}</td>
        <td>${escapeHtml(h.usuarioNome || "—")}</td>
        <td>${fmtDataHora(h.criadoEm)}</td>
        <td><button class="btn btn-ghost btn-sm pfd-hist-arquivo" data-id="${h.id}" title="Ver arquivo original">📎</button>${podeExcluir() ? `<button class="btn btn-ghost btn-sm pfd-hist-excluir" data-id="${h.id}" title="Excluir importação">🗑️</button>` : ""}</td>
      </tr>`).join("")}</tbody>
  </table></div>`;

  box.querySelectorAll(".pfd-hist-linha").forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    pfd.periodo.chave = null;
    box.innerHTML = skeletonVisaoGeral(); // feedback imediato — abrirImportacao troca pra aba Visão Geral quando terminar
    abrirImportacao(tr.dataset.id);
  }));
  box.querySelectorAll(".pfd-hist-arquivo").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    try { const { data } = await pfdArquivoImportacao(b.dataset.id); window.open(data.url, "_blank"); }
    catch (err) { toast("Erro ao abrir arquivo: " + err.message); }
  }));
  box.querySelectorAll(".pfd-hist-excluir").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const motivo = prompt("Motivo da exclusão desta importação:\n\n(isso também libera o arquivo para reimportação)");
    if (!motivo) return;
    if (!confirm("Excluir de vez esta importação? Esta ação não pode ser desfeita.")) return;
    try {
      await pfdExcluirImportacao(b.dataset.id, motivo);
      toast("Importação excluída.");
      if (pfd.atual?.importacao?.id === b.dataset.id) pfd.atual = null;
      await carregarHistorico();
      renderAbaAtual();
    } catch (err) { toast("Erro: " + err.message); }
  }));
}
