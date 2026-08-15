// PARSER FOOD DELIVERY — importação e conciliação dos relatórios .xls/.xlsx
// de pedidos do food delivery (iFood/anota.ai). Mesmo esqueleto de
// bonificacaoMensal.js: abas + estado de módulo próprio, reset ao trocar de
// unidade (item 9 do pedido — nunca mistura dados entre unidades).
import { el, escapeHtml, toast, fmtMoeda, fmtDataHora } from "./utils.js";
import { state } from "./state.js";
import { pode } from "./sessao.js";
import {
  pfdImportacoes, pfdImportacaoDetalhe, pfdArquivoImportacao, pfdEditarCodigos, pfdExcluirImportacao,
} from "./api.js";
import { abrirImportarFoodDeliveryModal } from "./parserFoodDeliveryImportModal.js";
import { registrarResetDeContexto } from "./contextoEscopo.js";
import { icon } from "./icons.js";

const ABAS = [
  { id: "visao", icon: "📊", label: "Visão Geral" },
  { id: "pedidos", icon: "🧾", label: "Pedidos" },
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

const pfd = {
  aba: "visao",
  atual: null,        // { importacao, resumo, entregadores, pedidos, pedidosIgnorados } — importação aberta no momento
  historico: null,
  carregandoHistorico: false,
  filtros: { busca: "", status: "todos", entregador: "todos" },
  ordEntregadores: "taxas", // taxas | entregas | nome
  verIgnorados: false, // alterna a tabela da aba Pedidos entre Subway e "ignorados" (item 10 do complemento)
};

registrarResetDeContexto(() => {
  pfd.aba = "visao";
  pfd.atual = null;
  pfd.historico = null;
  pfd.filtros = { busca: "", status: "todos", entregador: "todos" };
  pfd.ordEntregadores = "taxas";
  pfd.verIgnorados = false;
});

const podeImportar = () => pode("parser_food_delivery.importar");
const podeExcluir = () => pode("parser_food_delivery.excluir");
const vazio = (emoji, titulo, msg, extra = "") =>
  `<div class="estado"><span class="emoji">${emoji}</span><h3>${escapeHtml(titulo)}</h3><p>${escapeHtml(msg)}</p>${extra}</div>`;
const carregando = () => `<div class="estado"><div class="spinner"></div>Carregando…</div>`;
// Skeleton (mesmo componente .vd-skel já usado em vendas.js — sem duplicar
// CSS) pro CONTEÚDO da tela, não a tela inteira: cabeçalho e abas continuam
// visíveis e clicáveis, só a área de dados pisca em "carregando". Corrige o
// buraco real do delay sentido ao abrir o Parser — hoje #pfd-conteudo fica
// um <div> vazio (sem nenhuma animação) durante toda a espera de rede, só o
// spinner cheio da tela aparece por uma fração de segundo antes de sumir.
const skeletonVisaoGeral = () => `
  <div class="vd-skel vd-skel-linha" style="max-width:420px"></div>
  <div class="vd-cards">${Array.from({ length: 3 }).map(() => '<div class="vd-skel vd-skel-card"></div>').join("")}</div>
  <div class="vd-skels">${Array.from({ length: 5 }).map(() => '<div class="vd-skel vd-skel-linha"></div>').join("")}</div>`;
const skeletonTabela = () => `<div class="vd-skels">${Array.from({ length: 8 }).map(() => '<div class="vd-skel vd-skel-linha"></div>').join("")}</div>`;
const fmtDataBr = (iso) => (iso ? iso.split("-").reverse().join("/") : "—");
const fmtPeriodo = (ini, fim) => (!ini ? "—" : ini === fim ? fmtDataBr(ini) : `${fmtDataBr(ini)} até ${fmtDataBr(fim)}`);

export async function renderParserFoodDelivery() {
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
  if (!pfd.atual && pfd.historico?.length) await abrirImportacao(pfd.historico[0].id, { silencioso: true });
  renderAbaAtual();
}

function montarLayout(unidadeNome) {
  const view = el("#view");
  view.innerHTML = `
    <div class="bm-topo">
      <div class="dex-head-txt">
        <h2><img src="/assets/menu-parser-food-delivery.png" alt="" class="pfd-logo" /> Parser Food Delivery</h2>
        <p>Importe o relatório de pedidos, marque os cancelados que não geram taxa e veja o valor final devido a cada entregador.</p>
      </div>
      <div class="bm-filtros">
        <span class="bm-unidade-chip">🏪 ${escapeHtml(unidadeNome || "—")}</span>
        ${podeImportar() ? `<button class="btn btn-primary btn-sm" id="pfd-importar">⬆️ Importar relatório Food Delivery</button>` : ""}
      </div>
    </div>
    <nav class="dex-nav" aria-label="Seções do Parser Food Delivery">
      ${ABAS.map((a) => `<button class="dex-tab ${a.id === pfd.aba ? "ativo" : ""}" data-aba="${a.id}"><span>${a.icon}</span> ${a.label}</button>`).join("")}
    </nav>
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
  pfd.atual = resultado; // { importacao, resumo, entregadores, pedidos }
  await carregarHistorico();
  pfd.aba = "visao";
  el("#view")?.querySelectorAll(".dex-tab").forEach((b) => b.classList.toggle("ativo", b.dataset.aba === "visao"));
  renderAbaAtual();
}

async function carregarHistorico() {
  pfd.carregandoHistorico = true;
  try {
    const { data } = await pfdImportacoes();
    pfd.historico = data;
  } catch (e) {
    toast("Erro ao carregar histórico: " + e.message);
    pfd.historico = pfd.historico || [];
  } finally {
    pfd.carregandoHistorico = false;
  }
}

async function abrirImportacao(id, { silencioso = false } = {}) {
  try {
    const { data } = await pfdImportacaoDetalhe(id);
    pfd.atual = data;
    if (!silencioso) { pfd.aba = "visao"; renderAbaAtual(); }
  } catch (e) {
    toast("Erro ao abrir importação: " + e.message);
  }
}

function renderAbaAtual() {
  const box = el("#pfd-conteudo");
  if (!box) return;
  if (pfd.aba === "historico") { box.innerHTML = skeletonTabela(); renderHistorico(box); return; }
  if (!pfd.atual) {
    box.innerHTML = vazio("🛵", "Nenhuma importação aberta",
      podeImportar() ? "Importe um relatório Food Delivery ou abra uma importação no Histórico." : "Nenhuma importação disponível para esta unidade ainda.",
      pfd.historico?.length ? `<button class="btn btn-ghost btn-sm" id="pfd-ir-historico">📚 Ver Histórico</button>` : "");
    el("#pfd-ir-historico")?.addEventListener("click", () => irParaAba("historico"));
    return;
  }
  if (pfd.aba === "visao") renderVisaoGeral(box);
  else if (pfd.aba === "pedidos") renderPedidos(box);
  else if (pfd.aba === "entregadores") renderEntregadores(box);
}

// ---------------------------------------------------------------------------
// VISÃO GERAL
// ---------------------------------------------------------------------------
function renderVisaoGeral(box) {
  const { importacao, resumo, entregadores } = pfd.atual;
  const top = [...entregadores].sort((a, b) => b.taxasValidas - a.taxasValidas).slice(0, 5);
  const card = (icon, lbl, val, sub = "", destaque = false) => `
    <div class="vd-card${destaque ? " destaque" : ""}">
      <div class="vd-card-topo"><span class="vd-card-ico">${icon}</span><span class="vd-card-lbl">${lbl}</span></div>
      <div class="vd-card-val">${val}</div>${sub ? `<div class="vd-card-sub">${sub}</div>` : ""}
    </div>`;
  const semColunaDetalhes = importacao.colunaDetalhesEncontrada === false;
  box.innerHTML = `
    <div class="vd-resumo">
      <span class="vd-resumo-ico">🗓️</span>
      <p>Período analisado: <b>${fmtPeriodo(importacao.periodoInicio, importacao.periodoFim)}</b> · Arquivo: <b>${escapeHtml(importacao.nomeArquivo || "—")}</b> · Importado por <b>${escapeHtml(importacao.usuarioNome || "—")}</b> em ${fmtDataHora(importacao.criadoEm)}</p>
    </div>
    <div class="bm-pv-bloco">
      <b>🔎 Filtragem por operação</b>
      <div class="vd-pv-grid" style="margin-top:8px">
        <div class="vd-pv-item"><span>Arquivo original</span><b>${importacao.totalPedidos} pedidos</b></div>
        <div class="vd-pv-item"><span>Subway Saci (entram na conta)</span><b>${importacao.pedidosSubway ?? resumo.totalPedidos}</b></div>
        <div class="vd-pv-item"><span>Sem entregador (ignorados)</span><b>${importacao.pedidosSemEntregador ?? 0}</b></div>
        <div class="vd-pv-item"><span>Açaí no Grau (ignorados)</span><b>${importacao.pedidosAcai ?? 0}</b></div>
        <div class="vd-pv-item"><span>Operação indefinida</span><b>${importacao.pedidosRevisao ?? 0}</b></div>
      </div>
      ${semColunaDetalhes ? `<p class="dex-diag-vazio" style="margin-top:8px">⚠️ Este relatório não trouxe a coluna "Detalhes do pedido" — não foi possível separar pedidos por operação; todos os pedidos foram considerados Subway Saci.</p>` : ""}
      ${(importacao.pedidosAcai || importacao.pedidosRevisao || importacao.pedidosSemEntregador) ? `<button class="btn btn-ghost btn-sm" id="pfd-ver-ignorados-visao" style="margin-top:8px">👁️ Ver pedidos ignorados</button>` : ""}
    </div>
    <div class="vd-cards" style="margin-top:14px">
      ${card("🧾", "Total de pedidos Subway", resumo.totalPedidos)}
      ${card("✅", "Entregues/finalizados", resumo.entregues)}
      ${card("🚫", "Cancelados", resumo.cancelados)}
      ${card("⚠️", "Cancelados com taxa", resumo.canceladosComTaxa)}
      ${card("🗑️", "Cancelados sem taxa", resumo.canceladosSemTaxa)}
      ${card("💰", "Taxas brutas", fmtMoeda(resumo.taxasBrutas))}
      ${card("➖", "Taxas descartadas", fmtMoeda(resumo.taxasDescartadas))}
      ${card("✅", "Taxas válidas dos entregadores", fmtMoeda(resumo.taxasValidas), "", true)}
    </div>
    <div class="bm-pv-bloco" style="margin-top:18px">
      <b>${icon("award", { size: 15 })} Ranking resumido de entregadores</b>
      <div class="tabela-wrap"><table class="grid">
        <thead><tr><th>Entregador</th><th class="num">Entregas</th><th class="num">Cancel. com taxa</th><th class="num">Cancel. sem taxa</th><th class="num">Taxas válidas</th></tr></thead>
        <tbody>${top.map((e) => `<tr><td>${escapeHtml(e.entregador)}</td><td class="num">${e.entregues}</td><td class="num">${e.canceladosComTaxa}</td><td class="num">${e.canceladosSemTaxa}</td><td class="num">${fmtMoeda(e.taxasValidas)}</td></tr>`).join("")}</tbody>
      </table></div>
      <button class="btn btn-ghost btn-sm" id="pfd-ver-todos-entregadores" style="margin-top:10px">Ver todos os entregadores →</button>
    </div>
    ${podeImportar() ? `<div class="ed-acoes"><button class="btn btn-ghost btn-sm" id="pfd-editar-codigos">✏️ Editar códigos "cancelado sem taxa"</button></div>` : ""}`;

  el("#pfd-ver-todos-entregadores")?.addEventListener("click", () => irParaAba("entregadores"));
  el("#pfd-editar-codigos")?.addEventListener("click", editarCodigosPrompt);
  el("#pfd-ver-ignorados-visao")?.addEventListener("click", () => { pfd.verIgnorados = true; irParaAba("pedidos"); });
}

// ---------------------------------------------------------------------------
// PEDIDOS — tabela pesquisável e filtrável (item 5 do pedido)
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
    <thead><tr><th>Código</th><th>Data</th><th>Entregador</th><th>Situação</th><th class="num">Taxa do entregador</th><th>Status da conciliação</th></tr></thead>
    <tbody>${lista.map((p) => {
      const st = STATUS_ROTULO[p.statusConciliacao] || { label: p.statusConciliacao, classe: "muted" };
      return `<tr>
        <td>${escapeHtml(p.numeroPedido)}</td>
        <td>${fmtDataHora(p.dataHora)}</td>
        <td>${escapeHtml(p.entregador || "—")}</td>
        <td>${escapeHtml(p.situacao || "—")}</td>
        <td class="num">${fmtMoeda(p.taxaEntregador)}</td>
        <td><span class="pill ${st.classe}">${st.label}</span></td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>
  <p class="dex-diag-vazio">${lista.length} de ${pfd.atual.pedidos.length} pedidos.</p>`;
}

// ---------------------------------------------------------------------------
// "VER PEDIDOS IGNORADOS" — item 10 do complemento: conferir se o parser não
// descartou algo incorretamente. Mostra código, descrição, motivo e a
// operação identificada (Açaí no Grau ou Revisão necessária).
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
// ENTREGADORES — ranking (item 6 do pedido)
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
      <div class="vd-card-sub">${e.totalPedidos} pedidos · ${e.entregues} entregues · ${e.canceladosComTaxa} cancel. com taxa · ${e.canceladosSemTaxa} cancel. sem taxa</div>
    </div>`).join("");
}

// ---------------------------------------------------------------------------
// HISTÓRICO (item 8 do pedido)
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

// ---------------------------------------------------------------------------
// EDITAR CÓDIGOS "SEM TAXA" de uma importação já salva (item 13 do pedido)
// ---------------------------------------------------------------------------
async function editarCodigosPrompt() {
  if (!pfd.atual) return;
  const atuais = pfd.atual.importacao.codigosSemTaxa.join(", ");
  const resposta = prompt(
    "Códigos dos pedidos cancelados SEM taxa (separe por vírgula, espaço ou quebra de linha):",
    atuais,
  );
  if (resposta == null) return;
  const codigos = [...new Set(resposta.split(/[,\s]+/).map((c) => c.trim()).filter(Boolean))];
  try {
    const { data } = await pfdEditarCodigos(pfd.atual.importacao.id, codigos);
    pfd.atual = data;
    await carregarHistorico();
    toast("Códigos atualizados. Resumo recalculado ✅");
    renderAbaAtual();
  } catch (e) {
    toast("Erro ao atualizar códigos: " + e.message);
  }
}
