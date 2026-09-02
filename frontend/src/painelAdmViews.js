// As telas do PAINEL ADMINISTRATIVO — central de acompanhamento cross-tenant.
//
// FASE G: telas reais consumindo os endpoints da Fase F
// (/api/v1/administrativo/*). Nenhuma view opera sob contexto de empresa —
// não há req.tenant, não há Context Token. A "navegação" para o detalhe de
// uma empresa ou o calendário de uma unidade é interna ao painel (pilha de
// telas em painelAdm.js), NÃO uma troca de contexto.
//
// Padrão de cada tela: um CONSTRUTOR PURO `htmlX(dados)` -> string (testável
// sem DOM) + o orquestrador `renderViewPadm` que busca, injeta e liga eventos,
// tratando loading / erro / vazio. `null` do backend nunca vira número.

import { el, els, escapeHtml, normalizarBusca } from "./utils.js";
import { icon } from "./icons.js";
import { painelAdmApi } from "./painelAdmApi.js";
import {
  card, cards, secao, carregando, erro, vazio, busca,
  chipCriticidade, chipCategoria, chip,
  fmtPct, fmtConformidade, fmtNum, fmtData, fmtDataCurta, fmtMesLongo, fmtDiasPendentes,
  CATEGORIA_D1, CRITICIDADE, ORDEM_ACAO, estadoDiaCalendario,
} from "./painelAdmUi.js";

/** Menu do painel — 5 áreas fixas. */
export const TELAS_PADM = [
  { id: "visao-geral", label: "Visão Geral",          icone: "target" },
  { id: "diario",      label: "Monitoramento Diário", icone: "calendar" },
  { id: "pendencias",  label: "Pendências",           icone: "alert-triangle" },
  { id: "empresas",    label: "Empresas",             icone: "building" },
  { id: "historico",   label: "Histórico",            icone: "archive" },
];

const view = () => el("#padm-view");

// Filtros server-side do Monitoramento Diário — persistem entre re-renders da
// própria tela; zeram ao sair dela (painelAdm.js).
export const filtrosDiario = { data: "", organizacaoId: "", status: "", criticidade: "" };
export function resetFiltrosDiario() {
  filtrosDiario.data = ""; filtrosDiario.organizacaoId = "";
  filtrosDiario.status = ""; filtrosDiario.criticidade = "";
}

// ---------------------------------------------------------------------------
// Orquestrador
// ---------------------------------------------------------------------------

/** Ganchos injetados por painelAdm.js: navegação interna + acesso revogado. */
let nav = { abrirEmpresa() {}, abrirUnidade() {}, irParaTela() {}, aoAcessoRevogado: null };
export function ligarNavegacao(ganchos) { nav = { ...nav, ...ganchos }; }

/**
 * Renderiza uma entrada da pilha de navegação do painel.
 * @param {{tipo: "tela"|"empresa"|"calendario", id?: string, empresaId?: string, empresaNome?: string, unidadeId?: string, unidadeNome?: string, mes?: string}} entrada
 * @param {{api?: typeof painelAdmApi}} [opts]
 */
export async function renderViewPadm(entrada = { tipo: "tela", id: "visao-geral" }, opts = {}) {
  const api = opts.api ?? painelAdmApi;
  const v = view();
  if (!v) return;

  // Histórico não tem endpoint — tela informativa, sem chamada de rede.
  if (entrada.tipo === "tela" && entrada.id === "historico") {
    v.innerHTML = htmlHistorico();
    return;
  }

  v.innerHTML = carregando();
  try {
    if (entrada.tipo === "empresa") {
      const dados = await api.detalheEmpresa(entrada.empresaId);
      v.innerHTML = htmlDetalheEmpresa(dados);
      ligarDetalheEmpresa();
    } else if (entrada.tipo === "calendario") {
      const dados = await api.calendarioUnidade(entrada.unidadeId, entrada.mes || undefined);
      v.innerHTML = htmlCalendario(dados, entrada.unidadeNome);
      ligarCalendario(dados, entrada);
    } else if (entrada.id === "diario") {
      const dados = await api.monitoramentoDiario(filtrosSemVazio());
      v.innerHTML = htmlDiario(dados, filtrosDiario);
      ligarDiario(api);
    } else if (entrada.id === "pendencias") {
      v.innerHTML = htmlPendencias(await api.pendencias());
      ligarLista();
    } else if (entrada.id === "empresas") {
      v.innerHTML = htmlEmpresas(await api.empresas());
      ligarLista();
    } else {
      v.innerHTML = htmlVisaoGeral(await api.visaoGeral());
      ligarLista();
    }
  } catch (e) {
    if (e && e.status === 403) {
      nav.aoAcessoRevogado?.(e.message || "Seu acesso ao Painel Administrativo não está mais disponível.");
      return;
    }
    v.innerHTML = erro(e);
  }
}

const filtrosSemVazio = () => {
  const o = {};
  for (const [k, val] of Object.entries(filtrosDiario)) if (val) o[k] = val;
  return o;
};

// ===========================================================================
// 1. VISÃO GERAL
// ===========================================================================

/** @param {object} d saída de GET /administrativo/visao-geral */
export function htmlVisaoGeral(d) {
  const r = d?.resumo ?? {};
  const confD1 = fmtConformidade(r.conformidadeD1);
  const confMes = fmtConformidade(r.conformidadeMes, { semBase: "Sem dias esperados" });

  const topo = cards([
    card({ label: "Unidades monitoradas", valor: fmtNum(r.unidadesMonitoradas), nota: `${fmtNum(r.empresasMonitoradas)} empresa(s)` }),
    card({ label: "Conformidade D-1", valor: confD1.texto, nota: confD1.vazio ? confD1.nota : `${fmtNum(r.concluidasD1)} de ${fmtNum((r.concluidasD1 ?? 0) + (r.emPreenchimentoD1 ?? 0) + (r.naoRealizadasD1 ?? 0) + (r.sequenciaBloqueadaD1 ?? 0))}` }),
    card({ label: "Conformidade do mês", valor: confMes.texto, nota: confMes.vazio ? confMes.nota : `${fmtNum(r.mesCompleto)} de ${fmtNum(r.mesEsperado)} dias` }),
    card({ label: "Críticas", valor: fmtNum(r.criticas), tom: (r.criticas ?? 0) > 0 ? "critico" : "" }),
    card({ label: "Atenção", valor: fmtNum(r.atencao), tom: (r.atencao ?? 0) > 0 ? "atencao" : "" }),
    card({ label: "Em dia", valor: fmtNum(r.emDia), tom: "ok" }),
  ].join(""));

  return `
    <div class="padm-refdata">Fechamento cobrado: <b>${fmtData(d?.d1)}</b> <span class="padm-refdata-sep">·</span> hoje ${fmtData(d?.dataReferencia)}</div>
    ${topo}
    ${secaoAcaoNecessaria(d?.acaoNecessariaHoje ?? [])}
    ${secaoResumoEmpresas(d?.empresas ?? [])}`;
}

function secaoAcaoNecessaria(itens) {
  const pendentes = itens.filter((it) => it.categoria !== "concluido");
  const porGrupo = ORDEM_ACAO.map((cat) => ({
    cat,
    meta: CATEGORIA_D1[cat],
    itens: itens.filter((it) => it.categoria === cat),
  })).filter((g) => g.itens.length);

  const corpo = pendentes.length
    ? porGrupo.map((g) => g.cat === "concluido" ? "" : `
        <div class="padm-acao-grupo padm-acao-grupo--${g.meta.classe}">
          <div class="padm-acao-grupo-head">
            ${chip(g.meta)}
            <span class="padm-acao-grupo-cont">${g.itens.length}</span>
          </div>
          <ul class="padm-acao-lista">
            ${g.itens.map(itemAcao).join("")}
          </ul>
        </div>`).join("")
    : vazio("Nada pendente para hoje", "Todos os fechamentos de ontem elegíveis foram concluídos.");

  const concluidas = itens.filter((it) => it.categoria === "concluido").length;
  return secao({
    titulo: "Ação necessária hoje",
    sub: pendentes.length
      ? `${pendentes.length} unidade(s) precisam de atenção${concluidas ? ` · ${concluidas} já concluíram` : ""}`
      : "",
    corpo: `<div class="padm-acao">${corpo}</div>`,
  });
}

function itemAcao(it) {
  const dias = fmtDiasPendentes(it.pendencia?.total);
  const desde = it.pendencia?.desde ? `desde ${fmtDataCurta(it.pendencia.desde)}` : "";
  const pend = dias || desde
    ? `<span class="padm-acao-pend">${escapeHtml([dias, desde].filter(Boolean).join(" · "))}</span>`
    : "";
  return `
    <li class="padm-acao-item" data-padm-nav="empresa" data-id="${escapeHtml(it.organizacaoId ?? "")}" data-nome="${escapeHtml(it.empresaNome ?? "")}" tabindex="0" role="button">
      <span class="padm-acao-item-txt">
        <b>${escapeHtml(it.unidadeNome ?? "—")}</b>
        <small>${escapeHtml(it.empresaNome ?? "—")}</small>
      </span>
      ${pend}
      ${chipCategoria(it.categoria)}
    </li>`;
}

function secaoResumoEmpresas(empresas) {
  if (!empresas.length) return "";
  const linhas = empresas.map((e) => {
    const cD1 = fmtConformidade(e.conformidadeD1);
    const cMes = fmtConformidade(e.conformidadeMes, { semBase: "—" });
    return `
      <li class="padm-emp-row" data-padm-nav="empresa" data-id="${escapeHtml(e.organizacaoId ?? "")}" data-nome="${escapeHtml(e.empresaNome ?? "")}" tabindex="0" role="button" data-busca="${escapeHtml(normalizarBusca(e.empresaNome))}">
        <span class="padm-emp-nome">${escapeHtml(e.empresaNome ?? "—")}</span>
        <span class="padm-emp-metricas">
          <span class="padm-emp-m"><i>${fmtNum(e.unidadesMonitoradas)}</i> unid.</span>
          <span class="padm-emp-m padm-emp-m--critico"><i>${fmtNum(e.criticas)}</i> crít.</span>
          <span class="padm-emp-m padm-emp-m--atencao"><i>${fmtNum(e.atencao)}</i> atenç.</span>
          <span class="padm-emp-m padm-emp-m--ok"><i>${fmtNum(e.emDia)}</i> em dia</span>
          <span class="padm-emp-m">D-1 <i>${cD1.texto}</i></span>
          <span class="padm-emp-m">mês <i>${cMes.texto}</i></span>
        </span>
        <span class="padm-emp-ir" aria-hidden="true">›</span>
      </li>`;
  }).join("");
  return secao({
    titulo: "Empresas",
    sub: "Toque para abrir o detalhe",
    corpo: `<ul class="padm-emp-lista">${linhas}</ul>`,
  });
}

// ===========================================================================
// 2. MONITORAMENTO DIÁRIO
// ===========================================================================

export function htmlDiario(d, filtros = filtrosDiario) {
  const unidades = d?.unidades ?? [];
  const opcoesEmpresa = [...new Map(unidades.map((u) => [u.organizacaoId, u.empresaNome])).entries()]
    .filter(([id]) => id)
    .sort((a, b) => String(a[1] ?? "").localeCompare(String(b[1] ?? ""), "pt-BR"));

  const selStatus = seletor("padm-f-status", "Status", filtros.status, Object.entries(CATEGORIA_D1)
    .filter(([k]) => k !== "nao_aplicavel").map(([k, v]) => [k, v.rotulo]));
  const selCrit = seletor("padm-f-criticidade", "Criticidade", filtros.criticidade,
    Object.entries(CRITICIDADE).map(([k, v]) => [k, v.rotulo]));
  const selEmp = seletor("padm-f-empresa", "Empresa", filtros.organizacaoId,
    opcoesEmpresa.map(([id, nome]) => [id, nome ?? id]));

  const filtroBar = `
    <div class="padm-filtros">
      <label class="padm-f-campo">
        <span>Data</span>
        <input type="date" id="padm-f-data" value="${escapeHtml(filtros.data || (d?.referencia ?? ""))}" max="${escapeHtml(d?.referencia ?? "")}" />
      </label>
      ${selEmp}${selStatus}${selCrit}
      <button class="btn btn-ghost btn-sm" data-padm-acao="limpar-filtros">Limpar</button>
    </div>
    ${busca("padm-busca-diario")}`;

  const corpo = unidades.length
    ? `<ul class="padm-lista">${unidades.map(linhaDiario).join("")}</ul>`
    : vazio("Nenhuma unidade neste recorte", "Ajuste os filtros ou a data.");

  return `
    <div class="padm-refdata">Referência: <b>${fmtData(d?.referencia)}</b></div>
    ${filtroBar}
    ${secao({ titulo: "Unidades", sub: `${unidades.length} no recorte`, corpo })}`;
}

function linhaDiario(u) {
  const dias = fmtDiasPendentes(u.diasPendentes);
  const antiga = u.pendenciaMaisAntiga ? `desde ${fmtDataCurta(u.pendenciaMaisAntiga)}` : "";
  const buscaTxt = normalizarBusca(`${u.empresaNome} ${u.unidadeNome}`);
  return `
    <li class="padm-lista-item" data-padm-nav="unidade" data-id="${escapeHtml(u.unidadeId ?? "")}" data-nome="${escapeHtml(u.unidadeNome ?? "")}" tabindex="0" role="button" data-busca="${escapeHtml(buscaTxt)}">
      <span class="padm-lista-princ">
        <b>${escapeHtml(u.unidadeNome ?? "—")}</b>
        <small>${escapeHtml(u.empresaNome ?? "—")}</small>
      </span>
      <span class="padm-lista-meta">
        ${chipCategoria(u.categoria)}
        ${chipCriticidade(u.criticidade)}
        ${dias || antiga ? `<span class="padm-lista-pend">${escapeHtml([dias, antiga].filter(Boolean).join(" · "))}</span>` : ""}
        <span class="padm-lista-conf">mês ${fmtConformidade(u.conformidadeMes, { semBase: "—" }).texto}</span>
        <span class="padm-lista-conf">últ. concl. ${fmtDataCurta(u.ultimoConcluido)}</span>
      </span>
    </li>`;
}

function seletor(id, label, valor, pares) {
  return `
    <label class="padm-f-campo">
      <span>${escapeHtml(label)}</span>
      <select id="${id}">
        <option value="">Todos</option>
        ${pares.map(([v, r]) => `<option value="${escapeHtml(v)}" ${v === valor ? "selected" : ""}>${escapeHtml(r)}</option>`).join("")}
      </select>
    </label>`;
}

// ===========================================================================
// 3. PENDÊNCIAS
// ===========================================================================

export function htmlPendencias(d) {
  const unidades = d?.unidades ?? [];
  if (!unidades.length) {
    return `
      <div class="padm-refdata">Referência: <b>${fmtData(d?.d1)}</b></div>
      ${vazio("Nenhuma pendência", "Todas as unidades monitoradas estão em dia no fechamento de ontem.")}`;
  }
  // A ordem vem PRONTA do backend (CRÍTICO → mais antigo → ATENÇÃO). Só
  // separamos visualmente por criticidade, sem reordenar dentro de cada grupo.
  const criticas = unidades.filter((u) => u.criticidade === "critico");
  const atencao = unidades.filter((u) => u.criticidade === "atencao");
  const outras = unidades.filter((u) => u.criticidade !== "critico" && u.criticidade !== "atencao");

  const grupo = (titulo, classe, lista) => lista.length ? `
    <div class="padm-pend-grupo">
      <h3 class="padm-pend-grupo-tit padm-pend-grupo-tit--${classe}">${escapeHtml(titulo)} <span>${lista.length}</span></h3>
      <ul class="padm-lista">${lista.map(linhaPendencia).join("")}</ul>
    </div>` : "";

  return `
    <div class="padm-refdata">Referência: <b>${fmtData(d?.d1)}</b> <span class="padm-refdata-sep">·</span> ${unidades.length} pendência(s)</div>
    ${grupo("Críticas", "critico", criticas)}
    ${grupo("Atenção", "atencao", atencao)}
    ${grupo("Outras", "muted", outras)}`;
}

function linhaPendencia(u) {
  const dias = fmtDiasPendentes(u.diasPendentes);
  return `
    <li class="padm-lista-item" data-padm-nav="unidade" data-id="${escapeHtml(u.unidadeId ?? "")}" data-nome="${escapeHtml(u.unidadeNome ?? "")}" tabindex="0" role="button">
      <span class="padm-lista-princ">
        <b>${escapeHtml(u.unidadeNome ?? "—")}</b>
        <small>${escapeHtml(u.empresaNome ?? "—")}</small>
      </span>
      <span class="padm-lista-meta">
        ${chipCriticidade(u.criticidade)}
        ${chipCategoria(u.d1Status)}
        ${u.sequenciaBloqueada ? `<span class="padm-tag-bloq">sequência bloqueada</span>` : ""}
        <span class="padm-lista-pend">${escapeHtml([
          u.pendenciaMaisAntiga ? `mais antiga ${fmtDataCurta(u.pendenciaMaisAntiga)}` : "",
          dias,
        ].filter(Boolean).join(" · ") || "D-1")}</span>
      </span>
    </li>`;
}

// ===========================================================================
// 4. EMPRESAS
// ===========================================================================

export function htmlEmpresas(d) {
  const empresas = d?.empresas ?? [];
  if (!empresas.length) {
    return `${vazio("Nenhuma empresa monitorada", "Nenhuma organização ativa tem o módulo Dashboard iFood habilitado.")}`;
  }
  const linhas = empresas.map((e) => {
    const cD1 = fmtConformidade(e.conformidadeD1);
    const cMes = fmtConformidade(e.conformidadeMes, { semBase: "—" });
    const tom = (e.criticas ?? 0) > 0 ? "critico" : (e.atencao ?? 0) > 0 ? "atencao" : "ok";
    return `
      <li class="padm-emp-card padm-emp-card--${tom}" data-padm-nav="empresa" data-id="${escapeHtml(e.organizacaoId ?? "")}" data-nome="${escapeHtml(e.empresaNome ?? "")}" tabindex="0" role="button" data-busca="${escapeHtml(normalizarBusca(e.empresaNome))}">
        <div class="padm-emp-card-top">
          <b>${escapeHtml(e.empresaNome ?? "—")}</b>
          <span class="padm-emp-ir" aria-hidden="true">›</span>
        </div>
        <div class="padm-emp-card-grid">
          <span><i>${fmtNum(e.unidadesMonitoradas)}</i> unidades</span>
          <span class="padm-emp-m--critico"><i>${fmtNum(e.criticas)}</i> críticas</span>
          <span class="padm-emp-m--atencao"><i>${fmtNum(e.atencao)}</i> atenção</span>
          <span class="padm-emp-m--ok"><i>${fmtNum(e.emDia)}</i> em dia</span>
          <span>D-1 <i>${cD1.texto}</i></span>
          <span>mês <i>${cMes.texto}</i></span>
        </div>
      </li>`;
  }).join("");

  return `
    ${busca("padm-busca-empresas")}
    ${secao({ titulo: "Empresas monitoradas", sub: `${empresas.length} no total`, corpo: `<ul class="padm-emp-cards">${linhas}</ul>` })}`;
}

// ===========================================================================
// 5. DETALHE DA EMPRESA
// ===========================================================================

export function htmlDetalheEmpresa(d) {
  const org = d?.organizacao ?? {};
  const c = d?.consolidado ?? {};
  const unidades = d?.unidades ?? [];
  const confD1 = fmtConformidade(c.conformidadeD1);
  const confMes = fmtConformidade(c.conformidadeMes, { semBase: "Sem dias esperados" });

  const topo = cards([
    card({ label: "Unidades", valor: fmtNum(unidades.length) }),
    card({ label: "Críticas", valor: fmtNum(c.criticas), tom: (c.criticas ?? 0) > 0 ? "critico" : "" }),
    card({ label: "Atenção", valor: fmtNum(c.atencao), tom: (c.atencao ?? 0) > 0 ? "atencao" : "" }),
    card({ label: "Em dia", valor: fmtNum(c.emDia), tom: "ok" }),
    card({ label: "Conformidade D-1", valor: confD1.texto, nota: confD1.vazio ? confD1.nota : "" }),
    card({ label: "Conformidade do mês", valor: confMes.texto, nota: confMes.vazio ? confMes.nota : "" }),
  ].join(""));

  const listaUnidades = unidades.length
    ? `<ul class="padm-lista">${unidades.map(linhaUnidadeDetalhe).join("")}</ul>`
    : vazio("Sem unidades monitoradas", "");

  return `
    <div class="padm-detalhe-head">
      <button class="btn btn-ghost btn-sm" data-padm-acao="voltar">‹ Voltar</button>
      <div class="padm-detalhe-titulo">
        <h2>${escapeHtml(org.nome ?? "—")}</h2>
        ${chip({ classe: org.status === "ativa" ? "ok" : "muted", rotulo: rotuloStatusOrg(org.status) })}
      </div>
      <span class="padm-detalhe-sub">Fechamento cobrado: ${fmtData(d?.d1)}</span>
    </div>
    ${topo}
    ${secao({ titulo: "Unidades", sub: "Toque para o calendário mensal", corpo: listaUnidades })}`;
}

function linhaUnidadeDetalhe(u) {
  const dias = fmtDiasPendentes(u.diasPendentes);
  return `
    <li class="padm-lista-item" data-padm-nav="unidade" data-id="${escapeHtml(u.unidadeId ?? "")}" data-nome="${escapeHtml(u.unidadeNome ?? "")}" tabindex="0" role="button">
      <span class="padm-lista-princ"><b>${escapeHtml(u.unidadeNome ?? "—")}</b></span>
      <span class="padm-lista-meta">
        ${chipCategoria(u.d1Status)}
        ${chipCriticidade(u.criticidade)}
        ${dias ? `<span class="padm-lista-pend">${escapeHtml(dias)}</span>` : ""}
        <span class="padm-lista-conf">mês ${fmtConformidade(u.conformidadeMes, { semBase: "—" }).texto}</span>
      </span>
    </li>`;
}

const rotuloStatusOrg = (s) => ({ ativa: "Ativa", teste: "Em teste", bloqueada: "Bloqueada", suspensa: "Suspensa", cancelada: "Cancelada" }[s] ?? (s ?? "—"));

// ===========================================================================
// 6. CALENDÁRIO DA UNIDADE
// ===========================================================================

export function htmlCalendario(d, unidadeNome) {
  const dias = d?.dias ?? [];
  const nome = unidadeNome || d?.unidade?.unidadeNome || "Unidade";
  const mesLabel = fmtMesLongo(d?.mes);
  const podeAvancar = mesPodeAvancar(d?.mes, d?.dataReferencia);

  const primeiro = dias[0]?.data ? new Date(dias[0].data + "T12:00:00") : null;
  const offset = primeiro ? (primeiro.getDay() + 6) % 7 : 0; // semana começa segunda

  const celulas = [
    ...Array.from({ length: offset }, () => `<span class="padm-cal-dia padm-cal-dia--fora" aria-hidden="true"></span>`),
    ...dias.map((dia) => {
      const est = estadoDiaCalendario(dia);
      const n = Number(dia.data.slice(8, 10));
      return `<span class="padm-cal-dia padm-cal-dia--${est.classe}" title="${escapeHtml(fmtData(dia.data))} · ${escapeHtml(est.rotulo)}">
        <i>${n}</i>
      </span>`;
    }),
  ].join("");

  const legenda = [
    ["concluido", "Concluído"], ["em-preenchimento", "Em preenchimento"],
    ["nao-realizado", "Não realizado"], ["bloqueado", "Bloqueado"],
    ["na", "Não aplicável"], ["futuro", "Futuro / hoje"],
  ].map(([c, r]) => `<span class="padm-cal-leg"><i class="padm-cal-dia--${c}"></i>${escapeHtml(r)}</span>`).join("");

  return `
    <div class="padm-detalhe-head">
      <button class="btn btn-ghost btn-sm" data-padm-acao="voltar">‹ Voltar</button>
      <div class="padm-detalhe-titulo"><h2>${escapeHtml(nome)}</h2></div>
      <span class="padm-detalhe-sub">${escapeHtml(d?.unidade?.empresaNome ?? "")}</span>
    </div>
    <div class="padm-cal-nav">
      <button class="btn btn-ghost btn-sm" data-padm-acao="mes-anterior" aria-label="Mês anterior">‹</button>
      <b class="padm-cal-mes">${escapeHtml(mesLabel)}</b>
      <button class="btn btn-ghost btn-sm" data-padm-acao="mes-proximo" aria-label="Próximo mês" ${podeAvancar ? "" : "disabled"}>›</button>
    </div>
    ${d?.sequenciaBloqueada ? `<div class="padm-cal-aviso">Sequência bloqueada — há dia(s) sem lançamento travando os seguintes.</div>` : ""}
    <div class="padm-cal">
      <div class="padm-cal-semana">${["S", "T", "Q", "Q", "S", "S", "D"].map((x) => `<span>${x}</span>`).join("")}</div>
      <div class="padm-cal-grade">${celulas}</div>
    </div>
    <div class="padm-cal-legenda">${legenda}</div>`;
}

/** "próximo mês" só até o mês corrente (dataReferencia). Sem futuro infinito. */
export function mesPodeAvancar(mesIso, hojeIso) {
  if (!mesIso || !hojeIso) return false;
  return mesIso < hojeIso.slice(0, 7);
}

/** Soma `delta` meses a "AAAA-MM". */
export function deslocarMes(mesIso, delta) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(mesIso ?? ""));
  if (!m) return mesIso;
  let ano = Number(m[1]);
  let mes = Number(m[2]) + delta;
  while (mes < 1) { mes += 12; ano -= 1; }
  while (mes > 12) { mes -= 12; ano += 1; }
  return `${ano}-${String(mes).padStart(2, "0")}`;
}

// ===========================================================================
// 7. HISTÓRICO — sem endpoint próprio nesta fase
// ===========================================================================

export function htmlHistorico() {
  return `
    <section class="padm-estado padm-estado--info">
      <span class="padm-estado-ic" aria-hidden="true">${icon("archive", { size: 22 })}</span>
      <h3>Histórico</h3>
      <p>Histórico consolidado será disponibilizado em uma próxima etapa.</p>
    </section>`;
}

// ---------------------------------------------------------------------------
// Ligação de eventos (após cada render)
// ---------------------------------------------------------------------------

function ligarLista() {
  ligarNav();
  ligarBuscaLocal();
}

function ligarNav() {
  els("[data-padm-nav]").forEach((n) => {
    const ir = () => {
      const tipo = n.dataset.padmNav;
      if (tipo === "empresa") nav.abrirEmpresa(n.dataset.id, n.dataset.nome);
      else if (tipo === "unidade") nav.abrirUnidade(n.dataset.id, n.dataset.nome);
    };
    n.addEventListener("click", ir);
    n.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ir(); } });
  });
}

function ligarBuscaLocal() {
  els('input[type="search"][id^="padm-busca"]').forEach((inp) => {
    inp.addEventListener("input", () => {
      const termo = normalizarBusca(inp.value);
      els("[data-busca]").forEach((row) => {
        row.hidden = termo ? !row.dataset.busca.includes(termo) : false;
      });
    });
  });
}

function ligarDiario(api) {
  ligarLista();
  const aplicar = () => renderViewPadm({ tipo: "tela", id: "diario" }, { api });
  const bind = (sel, chave) => {
    const n = el(sel);
    if (n) n.addEventListener("change", () => { filtrosDiario[chave] = n.value; aplicar(); });
  };
  bind("#padm-f-data", "data");
  bind("#padm-f-empresa", "organizacaoId");
  bind("#padm-f-status", "status");
  bind("#padm-f-criticidade", "criticidade");
  el('[data-padm-acao="limpar-filtros"]')?.addEventListener("click", () => { resetFiltrosDiario(); aplicar(); });
}

function ligarDetalheEmpresa() {
  ligarNav();
  el('[data-padm-acao="voltar"]')?.addEventListener("click", () => nav.voltar?.());
}

function ligarCalendario(dados, entrada) {
  el('[data-padm-acao="voltar"]')?.addEventListener("click", () => nav.voltar?.());
  const mesAtual = dados?.mes || entrada.mes;
  el('[data-padm-acao="mes-anterior"]')?.addEventListener("click", () =>
    nav.abrirUnidade(entrada.unidadeId, entrada.unidadeNome, deslocarMes(mesAtual, -1)));
  const prox = el('[data-padm-acao="mes-proximo"]');
  if (prox && !prox.disabled) {
    prox.addEventListener("click", () =>
      nav.abrirUnidade(entrada.unidadeId, entrada.unidadeNome, deslocarMes(mesAtual, +1)));
  }
}
