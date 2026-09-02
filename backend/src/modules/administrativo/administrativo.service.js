// PAINEL ADMINISTRATIVO — orquestração cross-tenant (Fase F).
//
// Junta a camada de I/O (administrativo.repo.js) com o MOTOR PURO
// (administrativo.status.js / administrativo.monitores.js). NENHUMA regra de
// negócio nova mora aqui — só o "carrega em lote -> roda o motor por unidade
// -> consolida" e o formato dos endpoints.
//
// Custo: por chamada de frota são ~5 queries FIXAS (2 catálogos de módulo, 1
// organizações, 1..N unidades por lote, 1..N lançamentos por lote) + O(unidades
// × dias) em memória. NUNCA `for unidade: SELECT`.

import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import {
  hojeIsoBrasil, diaAnterior, diasDoMes, mesAnterior,
  avaliarUnidade, projetarMes, avaliarDia, pendenciasAntesDe,
  STATUS_PAINEL, D1_CATEGORIA, ROLLUP,
} from "./administrativo.status.js";
import {
  MONITORES, consolidarOperacao, acaoNecessariaHoje,
  listarPendencias, consolidarEmpresas,
} from "./administrativo.monitores.js";
import {
  listarUnidadesElegiveis, obterOrganizacaoOperacional,
  carregarLancamentosDaFrota, carregarLancamentosDaUnidade,
} from "./administrativo.repo.js";

const MONITOR = MONITORES.dashboard_ifood;
const partesData = (iso) => iso.split("-").map(Number); // [ano, mes, dia]

/**
 * Menor intervalo SEGURO para avaliar um dia-alvo: mês do alvo + mês anterior.
 * É o mesmo alcance que `avaliarUnidade` já usa (`diasCorrente` + `diasAnteriores`)
 * e que `dashboardExecutivo.service.js#calcularPendenciasMesAnterior` usa — a
 * fronteira do próprio motor (statusMes reinicia a sequência no dia 1 de cada
 * mês; a pendência atravessa UMA virada de mês). NÃO varre histórico profundo.
 * @param {string} alvoIso
 */
function janelaDoAlvo(alvoIso) {
  const [ano, mes] = partesData(alvoIso);
  const ant = mesAnterior(ano, mes);
  const diasCorr = diasDoMes(ano, mes);
  const diasAnt = diasDoMes(ant.ano, ant.mes);
  return {
    anoAlvo: ano, mesAlvo: mes, ant,
    desdeIso: diasAnt[0],
    ateIso: diasCorr[diasCorr.length - 1],
    diasCorrIso: diasCorr,
    diasAntIso: diasAnt,
  };
}

/**
 * Avalia a FROTA inteira monitorada por `dashboard_ifood` para um dia-alvo.
 * Padrão: `dataAlvo = D-1` de hoje (a Visão Geral). Qualquer dia PASSADO é
 * aceito (o Monitoramento Diário). Dia futuro/hoje NÃO — nunca é pendência.
 *
 * @param {{ hojeIso?: string, dataAlvo?: string, incluirTeste?: boolean }} [opts]
 * @param {{ supabase?: any }} [deps]
 * @returns {Promise<{ hojeIso: string, referencia: string, monitor: string, unidades: Array<object> }>}
 */
export async function avaliarFrota({ hojeIso, dataAlvo, incluirTeste = false } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const alvo = dataAlvo ?? diaAnterior(hoje);
  if (alvo >= hoje) {
    throw ApiError.badRequest("O dia informado ainda não venceu — não é possível cobrar um lançamento de hoje ou do futuro.", { codigo: "DATA_NAO_VENCIDA" });
  }

  const jan = janelaDoAlvo(alvo);
  const unidades = await listarUnidadesElegiveis({ moduloId: MONITOR.modulo, incluirTeste }, deps);
  if (!unidades.length) {
    return { hojeIso: hoje, referencia: alvo, monitor: MONITOR.chave, unidades: [] };
  }

  const porUnidade = await carregarLancamentosDaFrota({
    unidadeIds: unidades.map((u) => u.unidadeId),
    desdeIso: jan.desdeIso, ateIso: jan.ateIso,
  }, deps);

  const avaliadas = unidades.map((u) => {
    const linhas = porUnidade.get(u.unidadeId) ?? [];
    const porData = new Map(linhas.map((r) => [r.data_lancamento, r]));
    const mkDias = (isos) => isos.map((data) => ({ data, lancamento: porData.get(data) ?? null }));

    const res = avaliarUnidade({
      diasCorrente: mkDias(jan.diasCorrIso),
      diasAnteriores: mkDias(jan.diasAntIso),
      hojeIso: hoje,
      unidadeCriadaEm: u.unidadeCriadaEm,
      dataAlvo: alvo,
    });
    return { ...u, ...res, monitor: MONITOR.chave };
  });

  return { hojeIso: hoje, referencia: alvo, monitor: MONITOR.chave, unidades: avaliadas };
}

// ---------------------------------------------------------------------------
// 1. VISÃO GERAL  —  GET /administrativo/visao-geral
// ---------------------------------------------------------------------------
export async function visaoGeral({ hojeIso } = {}, deps = {}) {
  const frota = await avaliarFrota({ hojeIso }, deps);
  const cons = consolidarOperacao(frota.unidades);
  const acao = acaoNecessariaHoje(frota.unidades);

  return {
    monitor: frota.monitor,
    dataReferencia: frota.hojeIso,
    d1: frota.referencia,
    resumo: {
      unidadesMonitoradas: cons.unidadesMonitoradas,
      empresasMonitoradas: cons.empresasMonitoradas,
      concluidasD1: cons.d1.concluidas,
      emPreenchimentoD1: cons.d1.emPreenchimento,
      naoRealizadasD1: cons.d1.naoRealizadas,
      sequenciaBloqueadaD1: cons.d1.bloqueadas,
      criticas: cons.criticas,
      atencao: cons.atencao,
      emDia: cons.emDia,
      conformidadeD1: cons.d1.taxa,
      conformidadeMes: cons.conformidadeMes.taxa,
      mesCompleto: cons.conformidadeMes.completos,
      mesEsperado: cons.conformidadeMes.esperados,
    },
    acaoNecessariaHoje: acao.pendentes.map(itemAcao),
    resumoAcao: acao.contadores,
    empresas: consolidarEmpresas(frota.unidades),
  };
}

const itemAcao = (it) => ({
  unidadeId: it.unidadeId,
  unidadeNome: it.unidadeNome,
  organizacaoId: it.organizacaoId,
  empresaNome: it.empresaNome,
  categoria: it.categoria,
  pendencia: it.pendencia,
});

// ---------------------------------------------------------------------------
// 2. MONITORAMENTO DIÁRIO  —  GET /administrativo/monitoramento-diario
// ---------------------------------------------------------------------------
const CATS_D1 = Object.values(D1_CATEGORIA);
const CRITICIDADES = Object.values(ROLLUP);

export async function monitoramentoDiario({ data, organizacaoId, status, criticidade, hojeIso } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const alvo = v.dataOpcional(data, "Data") ?? diaAnterior(hoje);
  const orgFiltro = organizacaoId ? v.uuid(organizacaoId, "Empresa") : null;
  const statusFiltro = status ? v.umDe(status, "Status", CATS_D1) : null;
  const critFiltro = criticidade ? v.umDe(criticidade, "Criticidade", CRITICIDADES) : null;

  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: alvo }, deps);

  let unidades = frota.unidades;
  if (orgFiltro) unidades = unidades.filter((u) => u.organizacaoId === orgFiltro);
  if (statusFiltro) unidades = unidades.filter((u) => u.d1.categoria === statusFiltro);
  if (critFiltro) unidades = unidades.filter((u) => u.rollup.status === critFiltro);

  return {
    monitor: frota.monitor,
    dataReferencia: frota.hojeIso,
    referencia: frota.referencia,
    filtros: { organizacaoId: orgFiltro, status: statusFiltro, criticidade: critFiltro },
    total: unidades.length,
    unidades: unidades.map((u) => ({
      unidadeId: u.unidadeId,
      unidadeNome: u.unidadeNome,
      organizacaoId: u.organizacaoId,
      empresaNome: u.empresaNome,
      elegivel: u.d1.elegivel,
      statusDia: u.d1.statusDia ?? null,     // STATUS_DIA original do domínio
      categoria: u.d1.categoria,             // classificação administrativa projetada
      bloqueada: u.d1.bloqueada ?? false,
      criticidade: u.rollup.status,
      motivo: u.rollup.motivo,
      sequenciaBloqueada: u.pendenciasAcum.sequenciaBloqueada,
      pendenciaMaisAntiga: u.pendenciasAcum.desde,
      diasPendentes: u.pendenciasAcum.total,
      conformidadeMes: u.conformidade.taxa,
      mesCompleto: u.conformidade.completos,
      mesEsperado: u.conformidade.esperados,
      ultimoConcluido: u.ultimos.ultimoCompleto,
      ultimoRegistro: u.ultimos.ultimoRegistro,
      criadaEm: u.unidadeCriadaEm,
    })),
  };
}

// ---------------------------------------------------------------------------
// 3. PENDÊNCIAS  —  GET /administrativo/pendencias
// ---------------------------------------------------------------------------
export async function pendencias({ hojeIso } = {}, deps = {}) {
  const frota = await avaliarFrota({ hojeIso }, deps);
  const lista = listarPendencias(frota.unidades);
  return {
    monitor: frota.monitor,
    dataReferencia: frota.hojeIso,
    d1: frota.referencia,
    total: lista.length,
    criticas: lista.filter((u) => u.criticidade === ROLLUP.CRITICO).length,
    atencao: lista.filter((u) => u.criticidade === ROLLUP.ATENCAO).length,
    unidades: lista,
  };
}

// ---------------------------------------------------------------------------
// 4. EMPRESAS  —  GET /administrativo/empresas
// ---------------------------------------------------------------------------
export async function empresas({ hojeIso } = {}, deps = {}) {
  const frota = await avaliarFrota({ hojeIso }, deps);
  return {
    monitor: frota.monitor,
    dataReferencia: frota.hojeIso,
    d1: frota.referencia,
    total: new Set(frota.unidades.map((u) => u.organizacaoId)).size,
    empresas: consolidarEmpresas(frota.unidades),
  };
}

// ---------------------------------------------------------------------------
// 5. DETALHE DA EMPRESA  —  GET /administrativo/empresas/:organizacaoId
// ---------------------------------------------------------------------------
export async function detalheEmpresa({ organizacaoId, hojeIso } = {}, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const org = await obterOrganizacaoOperacional(orgId, deps);
  if (!org) throw ApiError.notFound("Empresa não encontrada ou fora do monitoramento.");

  const frota = await avaliarFrota({ hojeIso }, deps);
  const daEmpresa = frota.unidades.filter((u) => u.organizacaoId === orgId);
  const cons = consolidarOperacao(daEmpresa);
  const resumoEmpresa = consolidarEmpresas(daEmpresa)[0] ?? null;

  return {
    monitor: frota.monitor,
    dataReferencia: frota.hojeIso,
    d1: frota.referencia,
    organizacao: { organizacaoId: org.organizacaoId, nome: org.nome, status: org.status, criadaEm: org.criadaEm },
    resumo: resumoEmpresa,
    consolidado: {
      criticas: cons.criticas, atencao: cons.atencao, emDia: cons.emDia,
      conformidadeD1: cons.d1.taxa, conformidadeMes: cons.conformidadeMes.taxa,
      mesCompleto: cons.conformidadeMes.completos, mesEsperado: cons.conformidadeMes.esperados,
    },
    unidades: daEmpresa.map((u) => ({
      unidadeId: u.unidadeId,
      unidadeNome: u.unidadeNome,
      criticidade: u.rollup.status,
      motivo: u.rollup.motivo,
      d1Status: u.d1.categoria,
      d1StatusDia: u.d1.statusDia ?? null,
      sequenciaBloqueada: u.pendenciasAcum.sequenciaBloqueada,
      pendenciaMaisAntiga: u.pendenciasAcum.desde,
      diasPendentes: u.pendenciasAcum.total,
      conformidadeMes: u.conformidade.taxa,
      mesCompleto: u.conformidade.completos,
      mesEsperado: u.conformidade.esperados,
      ultimoConcluido: u.ultimos.ultimoCompleto,
      ultimoRegistro: u.ultimos.ultimoRegistro,
      criadaEm: u.unidadeCriadaEm,
    })),
    pendencias: listarPendencias(daEmpresa),
  };
}

// ---------------------------------------------------------------------------
// 6. CALENDÁRIO DA UNIDADE  —  GET /administrativo/unidades/:unidadeId/calendario?mes=YYYY-MM
// ---------------------------------------------------------------------------
export async function calendarioUnidade({ unidadeId, mes, hojeIso } = {}, deps = {}) {
  const uniId = v.uuid(unidadeId, "Unidade");
  const hoje = hojeIso ?? hojeIsoBrasil();

  const m = /^(\d{4})-(\d{2})$/.exec(String(mes ?? "").trim());
  const ano = m ? Number(m[1]) : Number(hoje.slice(0, 4));
  const numMes = m ? Number(m[2]) : Number(hoje.slice(5, 7));
  if (numMes < 1 || numMes > 12) throw ApiError.badRequest("Mês inválido (use AAAA-MM).");

  // A unidade tem de estar no universo monitorado PADRÃO (org ativa, unidade
  // não-teste) — o calendário é rota HTTP normal, não chamada diagnóstica.
  const elegiveis = await listarUnidadesElegiveis({ moduloId: MONITOR.modulo }, deps);
  const alvo = elegiveis.find((u) => u.unidadeId === uniId);
  if (!alvo) throw ApiError.notFound("Unidade não encontrada ou fora do monitoramento.");

  const ant = mesAnterior(ano, numMes);
  const diasCorrIso = diasDoMes(ano, numMes);
  const diasAntIso = diasDoMes(ant.ano, ant.mes);

  const linhas = await carregarLancamentosDaUnidade({
    unidadeId: uniId, desdeIso: diasAntIso[0], ateIso: diasCorrIso[diasCorrIso.length - 1],
  }, deps);
  const porData = new Map(linhas.map((r) => [r.data_lancamento, r]));
  const mkDias = (isos) => isos.map((data) => ({ data, lancamento: porData.get(data) ?? null }));

  const proj = projetarMes({
    dias: mkDias(diasCorrIso), hojeIso: hoje, unidadeCriadaEm: alvo.unidadeCriadaEm,
  });
  const projTodos = [...projetarMes({ dias: mkDias(diasAntIso), hojeIso: hoje, unidadeCriadaEm: alvo.unidadeCriadaEm }), ...proj];

  const dataAlvo = diaAnterior(hoje);
  const d1 = avaliarDia(projTodos, dataAlvo);
  const pend = pendenciasAntesDe(projTodos, dataAlvo);

  return {
    monitor: MONITOR.chave,
    dataReferencia: hoje,
    unidade: { unidadeId: alvo.unidadeId, unidadeNome: alvo.unidadeNome, organizacaoId: alvo.organizacaoId, empresaNome: alvo.empresaNome, criadaEm: alvo.unidadeCriadaEm },
    mes: `${ano}-${String(numMes).padStart(2, "0")}`,
    d1Deste: d1.data === dataAlvo && diasCorrIso.includes(dataAlvo) ? d1.categoria : null,
    sequenciaBloqueada: pend.sequenciaBloqueada,
    dias: proj.map((d) => ({
      data: d.data,
      statusDia: d.statusDia,
      painel: d.painel,
      completo: d.painel === STATUS_PAINEL.COMPLETO,
      esperado: d.painel !== STATUS_PAINEL.NAO_APLICAVEL,
      bloqueada: d.bloqueada,
      emPreenchimento: d.emPreenchimento,
      motivoNaoAplicavel: d.motivoNaoAplicavel ?? null,
    })),
  };
}
