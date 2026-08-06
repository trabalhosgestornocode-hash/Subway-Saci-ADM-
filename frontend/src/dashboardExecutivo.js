// DASHBOARD EXECUTIVO — lançamento financeiro diário por unidade (fechamento
// do iFood) com cálculo automático de percentuais, deduções, projeção,
// diagnóstico e recomendações. O franqueado preenche só os dados brutos;
// tudo o mais é calculado no backend (dashboardExecutivo.calc.js) e só
// exibido aqui.
import { el, escapeHtml, toast, fmtMoeda, fmtPct, fmtDataHora } from "./utils.js";
import { state } from "./state.js";
import { pode } from "./sessao.js";
import {
  dashExecUnidades, dashExecMes, dashExecHistorico,
  dashExecAtualizarModeloLogistico,
} from "./api.js";
import { INTEGRACOES } from "./config.js";
import {
  destruirGraficosDashboardExecutivo, barraComparativaMeta, roscaDeducoes,
  linhaEvolucao, linhaEvolucaoDeducoes, barraComparativoMensal, visaoAnual,
} from "./charts.js";
import { abrirLancamentoModal } from "./dashboardExecutivoForm.js";

const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const ABAS = [
  { id: "visao", icon: "📊", label: "Visão Geral" },
  { id: "lancamentos", icon: "🗓️", label: "Lançamentos" },
  { id: "indicadores", icon: "🎯", label: "Indicadores" },
  { id: "historico", icon: "📚", label: "Histórico" },
];
const STATUS_LEGENDA = [
  { chave: "PREENCHIDO", label: "Preenchido", classe: "ok" },
  { chave: "RASCUNHO", label: "Rascunho", classe: "warn" },
  { chave: "PENDENTE", label: "Pendente", classe: "bad" },
  { chave: "BLOQUEADO", label: "Bloqueado", classe: "muted" },
  { chave: "SEM_OPERACAO", label: "Sem operação", classe: "info" },
  { chave: "ZERO_VENDAS", label: "Zero vendas", classe: "info" },
  { chave: "FUTURO", label: "Futuro", classe: "muted" },
];
const STATUS_ROTULO = Object.fromEntries(STATUS_LEGENDA.map((s) => [s.chave, s]));

const hoje = new Date();
const dex = {
  aba: "visao",
  unidadeId: null,
  unidades: [],
  agregadoDisponivel: false,
  mes: hoje.getMonth() + 1,
  ano: hoje.getFullYear(),
  dadosMes: null,
  historico: null,
};

const podeLancar = () => pode("dashboard_executivo.lancar");
const vazio = (emoji, titulo, msg, extra = "") =>
  `<div class="estado"><span class="emoji">${emoji}</span><h3>${escapeHtml(titulo)}</h3><p>${escapeHtml(msg)}</p>${extra}</div>`;
const carregando = () => `<div class="estado"><div class="spinner"></div>Carregando…</div>`;

export async function renderDashboardExecutivo() {
  const view = el("#view");
  if (!view) return;
  view.innerHTML = carregando();
  try {
    const { data } = await dashExecUnidades();
    dex.unidades = data.unidades ?? [];
    dex.agregadoDisponivel = data.agregadoDisponivel;
    if (!dex.unidadeId && dex.unidades.length) dex.unidadeId = dex.unidades[0].id;
    montarLayout();
    await carregarConteudo();
  } catch (e) {
    view.innerHTML = vazio("⚠️", "Erro ao carregar", e.message, `<button class="btn btn-ghost btn-sm" id="dex-retry">Tentar novamente</button>`);
    el("#dex-retry")?.addEventListener("click", renderDashboardExecutivo);
  }
}

function montarLayout() {
  const view = el("#view");
  const anos = anosDisponiveis();
  view.innerHTML = `
    <div class="dex-head">
      <div class="dex-head-txt">
        <h2>${INTEGRACOES.ifood?.logo ? `<img src="${INTEGRACOES.ifood.logo}" alt="iFood" class="dex-logo">` : ""}Dashboard iFood</h2>
        <p>Lançamento financeiro diário do iFood — preencha os dados brutos; percentuais, deduções e projeções são calculados automaticamente.</p>
      </div>
      <div id="dex-modelo-box" class="dex-modelo-box"></div>
    </div>
    <div class="dex-filtros">
      ${dex.unidades.length > 1 || dex.agregadoDisponivel ? `
      <label class="cfg-campo"><span>Unidade</span>
        <select id="dex-unidade">
          ${dex.unidades.map((u) => `<option value="${u.id}" ${u.id === dex.unidadeId ? "selected" : ""}>${escapeHtml(u.nome)}</option>`).join("")}
          ${dex.agregadoDisponivel ? `<option value="" ${!dex.unidadeId ? "selected" : ""}>🏢 Todas as unidades</option>` : ""}
        </select></label>` : ""}
      <label class="cfg-campo"><span>Mês</span>
        <select id="dex-mes">${MESES.map((m, i) => `<option value="${i + 1}" ${i + 1 === dex.mes ? "selected" : ""}>${m}</option>`).join("")}</select></label>
      <label class="cfg-campo"><span>Ano</span>
        <select id="dex-ano">${anos.map((a) => `<option value="${a}" ${a === dex.ano ? "selected" : ""}>${a}</option>`).join("")}</select></label>
    </div>
    <nav class="dex-nav" aria-label="Seções do Dashboard iFood">
      ${ABAS.map((a) => `<button class="dex-tab ${a.id === dex.aba ? "ativo" : ""}" data-aba="${a.id}"><span>${a.icon}</span> ${a.label}</button>`).join("")}
    </nav>
    <div id="dex-conteudo" class="dex-conteudo"></div>`;

  el("#dex-unidade")?.addEventListener("change", (e) => { dex.unidadeId = e.target.value || null; carregarConteudo(); });
  el("#dex-mes").addEventListener("change", (e) => { dex.mes = Number(e.target.value); carregarConteudo(); });
  el("#dex-ano").addEventListener("change", (e) => { dex.ano = Number(e.target.value); carregarConteudo(); });
  view.querySelectorAll(".dex-tab").forEach((b) => b.addEventListener("click", () => {
    dex.aba = b.dataset.aba;
    view.querySelectorAll(".dex-tab").forEach((t) => t.classList.toggle("ativo", t === b));
    renderAbaAtual();
  }));
}

function anosDisponiveis() {
  const atual = hoje.getFullYear();
  const lista = [];
  for (let a = atual + 1; a >= atual - 3; a--) lista.push(a);
  return lista;
}

async function carregarConteudo() {
  const box = el("#dex-conteudo");
  if (!box) return;
  box.innerHTML = carregando();
  destruirGraficosDashboardExecutivo();
  try {
    const { data } = await dashExecMes({ unidadeId: dex.unidadeId || undefined, mes: dex.mes, ano: dex.ano });
    dex.dadosMes = data;
    renderModeloBox();
    renderAbaAtual();
  } catch (e) {
    box.innerHTML = vazio("⚠️", "Erro ao carregar", e.message, `<button class="btn btn-ghost btn-sm" id="dex-retry-mes">Tentar novamente</button>`);
    el("#dex-retry-mes")?.addEventListener("click", carregarConteudo);
  }
}

// ---------------------------------------------------------------------------
// MODELO LOGÍSTICO DO IFOOD (Marketplace x Full Service) — cabeçalho
// ---------------------------------------------------------------------------
const ROTULO_MODELO = { marketplace: "Marketplace", full_service: "Full Service" };

function renderModeloBox() {
  const caixa = el("#dex-modelo-box");
  const d = dex.dadosMes;
  if (!caixa || !d) return;

  if (d.agregado) {
    caixa.innerHTML = `<span class="dex-modelo-nota">🏷️ Modelo logístico: varia por unidade nesta visão consolidada</span>`;
    return;
  }

  if (pode("dashboard_executivo.configurar")) {
    caixa.innerHTML = `<label class="dex-modelo-campo"><span>Modelo logístico</span>
      <select id="dex-modelo-select">
        <option value="marketplace" ${d.modeloLogistico === "marketplace" ? "selected" : ""}>Marketplace</option>
        <option value="full_service" ${d.modeloLogistico === "full_service" ? "selected" : ""}>Full Service</option>
      </select></label>`;
    el("#dex-modelo-select").addEventListener("change", (e) => trocarModeloLogistico(e.target.value));
  } else {
    caixa.innerHTML = `<span class="dex-modelo-nota">🏷️ Modelo logístico: <b>${escapeHtml(d.modeloLogisticoRotulo ?? ROTULO_MODELO[d.modeloLogistico] ?? "—")}</b></span>`;
  }
}

async function trocarModeloLogistico(modeloNovo) {
  const rotulo = ROTULO_MODELO[modeloNovo] ?? modeloNovo;
  if (!confirm(`Trocar o modelo logístico desta unidade para ${rotulo}? Isso atualiza imediatamente as metas, os indicadores e o diagnóstico do mês.`)) {
    renderModeloBox(); // desfaz a seleção visual do <select>
    return;
  }
  const motivo = prompt("Motivo da troca (opcional):") || undefined;
  try {
    await dashExecAtualizarModeloLogistico(dex.unidadeId, { modeloLogistico: modeloNovo, motivo });
    toast(`Modelo logístico atualizado para ${rotulo}.`);
    await carregarConteudo();
  } catch (e) {
    toast("Erro: " + e.message);
    renderModeloBox();
  }
}

function renderAbaAtual() {
  const box = el("#dex-conteudo");
  if (!box || !dex.dadosMes) return;
  destruirGraficosDashboardExecutivo();
  if (dex.aba === "visao") return renderVisaoGeral(box);
  if (dex.aba === "lancamentos") return renderLancamentos(box);
  if (dex.aba === "indicadores") return renderIndicadores(box);
  if (dex.aba === "historico") return renderHistorico(box);
}

// ---------------------------------------------------------------------------
// ABA 1 — VISÃO GERAL
// ---------------------------------------------------------------------------
function renderVisaoGeral(box) {
  const d = dex.dadosMes;

  if (d.agregado) {
    box.innerHTML = `
      <div class="dex-aviso">🏢 ${escapeHtml(d.aviso)}</div>
      <div class="dex-cards">${cardsPrincipais(d.cards)}</div>
      <div class="dex-graficos">
        ${graficoBox("comparativo", "📈 Comparativo de percentuais", "dex-chart-comp")}
        ${graficoBox("composicao", "🍩 Composição das deduções (R$)", "dex-chart-comp2")}
      </div>`;
    barraComparativaMeta("dex-chart-comp", d.graficos.comparativoPercentuais);
    roscaDeducoes("dex-chart-comp2", d.graficos.composicaoDeducoes);
    return;
  }

  const r = d.resumoPreenchimento;
  const proj = d.projecao;
  box.innerHTML = `
    ${alertaPendencias(d)}
    <section class="dex-resumo">
      <h3>${MESES[d.periodo.mes - 1]} de ${d.periodo.ano}</h3>
      <p><b>${r.diasPreenchidos}</b> de <b>${r.totalDias}</b> dias resolvidos · ${r.diasPendentes} pendente(s) · ${fmtPct(r.percentualConclusao)} do mês concluído</p>
      <div class="dex-progress"><div style="width:${Math.min(100, r.percentualConclusao)}%"></div></div>
      <p class="dex-resumo-sub">Última atualização: ${r.ultimoLancamento ? fmtDataBr(r.ultimoLancamento) : "—"}</p>
      ${r.primeiroDiaPendente && podeLancar() ? `<button class="btn btn-primary btn-sm" id="dex-preencher-primeiro">Preencher primeiro dia pendente (${fmtDataBr(r.primeiroDiaPendente)})</button>` : ""}
    </section>
    <div class="dex-cards">${cardsPrincipais(d.cards)}</div>
    <div class="dex-graficos">
      ${graficoBox("comparativo", "📈 Comparativo de percentuais", "dex-chart-comp")}
      ${graficoBox("composicao", "🍩 Composição das deduções (R$)", "dex-chart-comp2")}
    </div>
    <section class="dex-projecao">
      <h3>📈 Projeção do faturamento — ${MESES[d.periodo.mes - 1]}/${d.periodo.ano}</h3>
      <div class="dex-projecao-grid">
        <div><span>Média diária atual</span><b>${fmtMoeda(proj.mediaDiaria)}</b></div>
        <div><span>Dias considerados</span><b>${proj.diasConsiderados}</b></div>
        <div><span>Dias resolvidos</span><b>${proj.diasResolvidos}</b></div>
        <div><span>Dias pendentes</span><b>${proj.diasPendentes}</b></div>
        <div><span>Dias previstos no mês</span><b>${proj.diasPrevistos}</b></div>
        <div class="dex-projecao-destaque"><span>Projeção mensal</span><b>${fmtMoeda(proj.projecaoMensal)}</b></div>
      </div>
      <p class="dex-confiabilidade dex-conf-${proj.confiabilidade}"><b>Confiabilidade: ${rotuloConfiabilidade(proj.confiabilidade)}</b> — ${escapeHtml(proj.justificativa)}</p>
      ${proj.parcial ? `<p class="dex-projecao-parcial">⚠️ PROJEÇÃO PARCIAL — existem dias pendentes neste período. Regularize os lançamentos para uma projeção mais confiável.</p>` : ""}
    </section>
    <div class="dex-diag-grid">
      <section class="dex-diag">
        <h3>📋 Diagnóstico Executivo</h3>
        ${diagnosticoHtml(d.diagnostico)}
      </section>
      <section class="dex-recom">
        <h3>🚀 Ações Recomendadas</h3>
        <ul class="dex-recom-lista">${d.recomendacoes.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
      </section>
    </div>`;

  barraComparativaMeta("dex-chart-comp", d.graficos.comparativoPercentuais);
  roscaDeducoes("dex-chart-comp2", d.graficos.composicaoDeducoes);
  el("#dex-preencher-primeiro")?.addEventListener("click", () => abrirLancamentoModal({
    data: r.primeiroDiaPendente, unidadeId: dex.unidadeId, onSalvo: carregarConteudo,
  }));
}

function alertaPendencias(d) {
  const grupos = d.pendenciasMesesAnteriores ?? [];
  if (!grupos.length) return "";
  const totalDias = grupos.reduce((s, g) => s + g.dias.length, 0);
  const listaMeses = grupos.map((g) => `${MESES[g.mes - 1]}/${g.ano} (${g.dias.length})`).join(", ");
  return `<div class="dex-alerta">
    <b>⚠️ DADOS PENDENTES</b>
    <p>Existem ${totalDias} dia(s) financeiro(s) não regularizado(s) em meses anteriores: ${escapeHtml(listaMeses)}.</p>
    <p>Isso não bloqueia o lançamento deste mês, mas prejudica a confiabilidade do histórico e das comparações.</p>
  </div>`;
}

function diagnosticoHtml(diag) {
  if (diag.semDadosSuficientes) {
    return `<p class="dex-diag-vazio">Ainda não há lançamentos suficientes neste mês para gerar um diagnóstico confiável.</p>`;
  }
  const bloco = (titulo, itens, classe) => !itens.length ? "" : `
    <div class="dex-diag-bloco ${classe}"><h4>${titulo}</h4><ul>${itens.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>`;
  const conteudo = [
    bloco("✅ Pontos fortes", diag.pontosFortes, "forte"),
    bloco("⚠️ Pontos de atenção", diag.pontosAtencao, "atencao"),
    bloco("🚨 Alertas", diag.alertas, "alerta"),
  ].join("");
  return conteudo || `<p class="dex-diag-vazio">Nenhum ponto relevante identificado.</p>`;
}

function rotuloConfiabilidade(nivel) {
  return { alta: "Alta", media: "Média", baixa: "Baixa", indisponivel: "Indisponível" }[nivel] ?? nivel;
}

function graficoBox(chave, titulo, canvasId) {
  return `<section class="dex-painel"><h3>${titulo}</h3><div class="dex-chart-wrap"><canvas id="${canvasId}"></canvas></div></section>`;
}

const cardDef = (icone, label, valor, sub, tip, cls = "") => `
  <div class="card ${cls}">
    <div class="dex-card-topo"><span>${icone}</span> ${label}${tip ? `<span class="vd-tip" data-tip="${escapeHtml(tip)}" tabindex="0">i</span>` : ""}</div>
    <b class="dex-card-val">${valor}</b>
    ${sub ? `<span class="dex-card-sub">${sub}</span>` : ""}
  </div>`;

function statusMeta(atual, meta) {
  if (atual == null || meta == null || meta.metaIdeal == null || meta.limite == null) {
    return { label: "Dados insuficientes", classe: "muted" };
  }
  if (atual <= meta.metaIdeal) return { label: "Dentro da meta", classe: "ok" };
  if (atual <= meta.limite) return { label: "Atenção", classe: "warn" };
  return { label: "Fora da meta", classe: "bad" };
}

function cardsPrincipais(cards) {
  const s1 = statusMeta(cards.taxasComissoes.percentual, cards.taxasComissoes.meta);
  const s2 = statusMeta(cards.servicosPromocoes.percentual, cards.servicosPromocoes.meta);
  const s3 = statusMeta(cards.totalDeducoes.percentual, cards.totalDeducoes.meta);
  return [
    cardDef("💰", "Vendas Brutas", fmtMoeda(cards.vendasBrutas.valor), `${fmtPct(cards.vendasBrutas.percentualSobreVendas)} do faturamento`, "Soma do valor bruto das vendas no período."),
    cardDef("📊", "Taxas e Comissões", fmtMoeda(cards.taxasComissoes.valor), `${fmtPct(cards.taxasComissoes.percentual)} das vendas · <span class="pill ${s1.classe}">${s1.label}</span>`, "Comissão iFood + taxa de transação de pagamento online."),
    cardDef("🏷️", "Serviços e Promoções", fmtMoeda(cards.servicosPromocoes.valor), `${fmtPct(cards.servicosPromocoes.percentual)} das vendas · <span class="pill ${s2.classe}">${s2.label}</span>`, "Custo de campanhas e promoções ativas no iFood."),
    cardDef("⛔", "Total de Deduções", fmtMoeda(cards.totalDeducoes.valor), `${fmtPct(cards.totalDeducoes.percentual)} das vendas · <span class="pill ${s3.classe}">${s3.label}</span>`, "Taxas e comissões + serviços e promoções + taxas de entregadores + outras deduções."),
    cardDef("👛", "Receita Após Deduções", fmtMoeda(cards.receitaAposDeducoes.valor), `${fmtPct(cards.receitaAposDeducoes.percentual)} das vendas`, "Valor das vendas menos o total de deduções.", "destaque"),
  ].join("");
}

// ---------------------------------------------------------------------------
// ABA 2 — LANÇAMENTOS (calendário)
// ---------------------------------------------------------------------------
function renderLancamentos(box) {
  const d = dex.dadosMes;
  if (d.agregado) {
    box.innerHTML = vazio("🏢", "Visão consolidada", "O calendário de lançamentos só está disponível para uma unidade específica. Selecione uma unidade no filtro acima.");
    return;
  }

  box.innerHTML = `
    ${alertaPendencias(d)}
    <section class="dex-cal-wrap">
      <div class="dex-cal">${d.calendario.map((dia) => diaHtml(dia)).join("")}</div>
      <div class="dex-legenda">${STATUS_LEGENDA.map((s) => `<span class="dex-leg-item"><span class="pill ${s.classe}">${s.label}</span></span>`).join("")}</div>
    </section>
    <div class="dex-graficos">
      ${graficoBox("evolucao", "📈 Evolução diária do faturamento", "dex-chart-evo")}
      ${graficoBox("evolucao-ded", "📉 Evolução do percentual de deduções", "dex-chart-evoded")}
    </div>`;

  linhaEvolucao("dex-chart-evo", d.graficos.evolucaoDiaria, "diario");
  linhaEvolucaoDeducoes("dex-chart-evoded", d.graficos.evolucaoDeducoes);

  box.querySelectorAll(".dex-cal-dia[data-clicavel]").forEach((el) => el.addEventListener("click", () => {
    abrirLancamentoModal({ data: el.dataset.data, unidadeId: dex.unidadeId, onSalvo: carregarConteudo });
  }));
}

function diaHtml(dia) {
  const s = STATUS_ROTULO[dia.status] ?? { label: dia.status, classe: "muted" };
  const numero = Number(dia.data.slice(8, 10));
  const clicavel = dia.status === "PENDENTE" || dia.status === "RASCUNHO"
    || ((dia.status === "PREENCHIDO" || dia.status === "SEM_OPERACAO" || dia.status === "ZERO_VENDAS") && pode("dashboard_executivo.corrigir"));
  return `<div class="dex-cal-dia pill ${s.classe}" ${clicavel ? `data-clicavel data-data="${dia.data}" role="button" tabindex="0"` : ""} title="${fmtDataBr(dia.data)} · ${s.label}">
    <span class="dex-cal-num">${numero}</span><span class="dex-cal-status">${s.label}</span>
  </div>`;
}

// ---------------------------------------------------------------------------
// ABA 3 — INDICADORES
// ---------------------------------------------------------------------------
function renderIndicadores(box) {
  const d = dex.dadosMes;
  if (d.agregado) {
    box.innerHTML = vazio("🏢", "Visão consolidada", "Os indicadores de rentabilidade dependem do modelo logístico (Marketplace/Full Service) de cada unidade e não são exibidos nesta visão. Selecione uma unidade específica no filtro acima.");
    return;
  }
  const linhas = Object.entries(d.indicadoresRentabilidade).map(([chave, v]) => {
    if (v.naoAplicavel) {
      return `<tr class="dex-linha-na">
        <td>${rotuloIndicador(chave)}</td>
        <td class="num">—</td><td class="num">—</td><td class="num">—</td>
        <td><span class="pill muted">Não se aplica a este modelo</span></td>
      </tr>`;
    }
    const s = statusMeta(v.atual, { metaIdeal: v.metaIdeal, limite: v.limite });
    return `<tr>
      <td>${rotuloIndicador(chave)}</td>
      <td class="num">${fmtPct(v.atual)}</td>
      <td class="num">${fmtPct(v.metaIdeal)}</td>
      <td class="num">${fmtPct(v.limite)}</td>
      <td><span class="pill ${s.classe}">${s.label}</span></td>
    </tr>`;
  }).join("");

  box.innerHTML = `
    <section class="dex-painel">
      <h3>🎯 Indicadores de Rentabilidade</h3>
      <div class="tabela-wrap"><table class="grid">
        <thead><tr><th>Indicador</th><th class="num">Atual</th><th class="num">Meta ideal</th><th class="num">Limite</th><th>Status</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table></div>
    </section>
    <div class="dex-graficos">${graficoBox("comparativo", "📈 Comparativo de percentuais", "dex-chart-ind")}</div>`;
  barraComparativaMeta("dex-chart-ind", d.graficos.comparativoPercentuais);
}

function rotuloIndicador(chave) {
  return {
    taxas_comissoes: "Taxas e comissões", servicos_promocoes: "Serviços e promoções",
    taxas_entregadores: "Taxas de entregadores", total_deducoes: "Total de deduções",
  }[chave] ?? chave;
}

// ---------------------------------------------------------------------------
// ABA 4 — HISTÓRICO
// ---------------------------------------------------------------------------
async function renderHistorico(box) {
  box.innerHTML = carregando();
  try {
    const { data } = await dashExecHistorico({ unidadeId: dex.unidadeId || undefined, ano: dex.ano });
    dex.historico = data;
  } catch (e) {
    box.innerHTML = vazio("⚠️", "Erro ao carregar histórico", e.message);
    return;
  }
  const meses = dex.historico.meses;
  const linha = (m) => `<tr class="dex-hist-${m.status}">
    <td>${MESES[m.mes - 1]}</td>
    <td><span class="pill ${{ completo: "ok", incompleto: "warn", sem_dados: "muted", futuro: "muted" }[m.status]}">${{ completo: "Completo", incompleto: "Incompleto", sem_dados: "Sem dados", futuro: "Futuro" }[m.status]}</span></td>
    <td class="num">${m.diasPreenchidos}</td>
    <td class="num">${m.diasPendentes}</td>
    <td class="num">${fmtMoeda(m.faturamentoBruto)}</td>
    <td class="num">${m.qtdVendas}</td>
    <td class="num">${fmtMoeda(m.ticketMedio)}</td>
    <td class="num">${fmtMoeda(m.totalDeducoes)}</td>
    <td class="num">${fmtPct(m.percentualDeducoes)}</td>
    <td class="num">${fmtMoeda(m.receitaAposDeducoes)}</td>
    <td class="num">${m.comparativoMesAnteriorPct != null ? (m.comparativoMesAnteriorPct >= 0 ? "▲ " : "▼ ") + fmtPct(Math.abs(m.comparativoMesAnteriorPct)) : "—"}</td>
  </tr>`;

  box.innerHTML = `
    <section class="dex-painel">
      <h3>📚 Histórico de ${dex.ano}</h3>
      <div class="tabela-wrap"><table class="grid">
        <thead><tr><th>Mês</th><th>Status</th><th class="num">Preenchidos</th><th class="num">Pendentes</th><th class="num">Faturamento</th><th class="num">Vendas</th><th class="num">Ticket médio</th><th class="num">Deduções</th><th class="num">% Deduções</th><th class="num">Receita líquida</th><th class="num">vs mês ant.</th></tr></thead>
        <tbody>${meses.map(linha).join("")}</tbody>
      </table></div>
    </section>
    <div class="dex-graficos">
      ${graficoBox("comparativo-mensal", "📊 Comparativo mensal", "dex-chart-mensal")}
      ${graficoBox("visao-anual", "📆 Visão anual", "dex-chart-anual")}
    </div>`;

  barraComparativoMensal("dex-chart-mensal", meses.filter((m) => m.status !== "futuro"));
  visaoAnual("dex-chart-anual", meses);
}

// ---------------------------------------------------------------------------
function fmtDataBr(iso) {
  if (!iso) return "—";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}
