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
import {
  faturamentoDaUnidade, somarFaturamento, coberturaDe,
  rankingFaturamento, rankingConformidade, evolucaoDiaria,
  variacao, variacaoPP, diaEquivalenteNoMesAnterior,
} from "./administrativo.financeiro.js";

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

// ---------------------------------------------------------------------------
// PERÍODO ATIVO (`mes=AAAA-MM`)
// ---------------------------------------------------------------------------
// O painel tem um período ativo. `mes` ausente = mês corrente (comportamento
// histórico, inalterado). O DIA-ALVO derivado do período é:
//   * mês corrente  -> D-1 de hoje (a obrigação viva);
//   * mês passado   -> último dia daquele mês (o mês já fechou por inteiro).
// Mês futuro é recusado — nunca houve obrigação.

/** Valida `AAAA-MM`. `null`/vazio -> null (mês corrente). */
export function validarMes(mes) {
  if (mes === undefined || mes === null || String(mes).trim() === "") return null;
  const m = /^(\d{4})-(\d{2})$/.exec(String(mes).trim());
  if (!m) throw ApiError.badRequest("Período inválido — use AAAA-MM.", { codigo: "PERIODO_INVALIDO" });
  const num = Number(m[2]);
  if (num < 1 || num > 12) throw ApiError.badRequest("Período inválido — mês fora de 01..12.", { codigo: "PERIODO_INVALIDO" });
  return `${m[1]}-${m[2]}`;
}

/**
 * Dia-alvo do período + o próprio período normalizado.
 * @param {string|null|undefined} mes  AAAA-MM (opcional)
 * @param {string} hojeIso
 * @returns {{ periodo: string, dataAlvo: string, mesCorrente: boolean }}
 */
export function alvoDoPeriodo(mes, hojeIso) {
  const pedido = validarMes(mes);
  const mesDeHoje = hojeIso.slice(0, 7);
  const periodo = pedido ?? mesDeHoje;

  if (periodo > mesDeHoje) {
    throw ApiError.badRequest("O período informado ainda não começou — não é possível cobrar um mês futuro.", { codigo: "PERIODO_NAO_VENCIDO" });
  }
  if (periodo === mesDeHoje) {
    return { periodo, dataAlvo: diaAnterior(hojeIso), mesCorrente: true };
  }
  const [ano, num] = periodo.split("-").map(Number);
  const dias = diasDoMes(ano, num);
  return { periodo, dataAlvo: dias[dias.length - 1], mesCorrente: false };
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

    // FINANCEIRO — só as linhas do MÊS do alvo (o mês anterior está carregado
    // para a sequência de pendência, não para o faturamento do período), e
    // cortado no dia-alvo: o faturamento exibido acompanha o que já venceu.
    const linhasDoPeriodo = linhas.filter((r) => jan.diasCorrIso.includes(r.data_lancamento));
    const faturamento = faturamentoDaUnidade(linhasDoPeriodo, { ateDataIso: alvo });

    return { ...u, ...res, faturamento, linhasDoPeriodo, monitor: MONITOR.chave };
  });

  return { hojeIso: hoje, referencia: alvo, monitor: MONITOR.chave, unidades: avaliadas };
}

// ---------------------------------------------------------------------------
// 1. VISÃO GERAL  —  GET /administrativo/visao-geral
// ---------------------------------------------------------------------------
export async function visaoGeral({ hojeIso, mes } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const cons = consolidarOperacao(frota.unidades);
  const acao = acaoNecessariaHoje(frota.unidades);
  const porEmpresa = consolidarEmpresas(frota.unidades);
  // "quem tem problema" em dois números, no topo — o gestor não deve precisar
  // somar cartões para descobrir quantas EMPRESAS estão afetadas.
  const empresasComPendencia = porEmpresa.filter((e) => e.unidadesPendentes > 0);
  const fin = resumoFinanceiroDaRede(frota.unidades, porEmpresa);

  return {
    monitor: frota.monitor,
    dataReferencia: frota.hojeIso,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
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
      // foco em PENDÊNCIA (o que o painel existe para responder)
      empresasComPendencia: empresasComPendencia.length,
      empresasCriticas: porEmpresa.filter((e) => e.criticas > 0).length,
      unidadesComPendencia: empresasComPendencia.reduce((n, e) => n + e.unidadesPendentes, 0),
      empresasSaudaveis: porEmpresa.length - empresasComPendencia.length,
    },
    faturamento: fin,
    acaoNecessariaHoje: acao.pendentes.map(itemAcao),
    resumoAcao: acao.contadores,
    empresas: porEmpresa,
  };
}

const itemAcao = (it) => ({
  unidadeId: it.unidadeId,
  unidadeNome: it.unidadeNome,
  organizacaoId: it.organizacaoId,
  empresaNome: it.empresaNome,
  categoria: it.categoria,
  pendencia: it.pendencia,   // DO PERÍODO — "X dias", "desde DD/MM"
  herdada: it.herdada,       // o que veio de antes do período (nota, não soma)
});

// ---------------------------------------------------------------------------
// 2. MONITORAMENTO DIÁRIO  —  GET /administrativo/monitoramento-diario
// ---------------------------------------------------------------------------
const CATS_D1 = Object.values(D1_CATEGORIA);
const CRITICIDADES = Object.values(ROLLUP);

export async function monitoramentoDiario({ data, mes, organizacaoId, status, criticidade, hojeIso } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  // `data` explícita manda (o usuário escolheu um dia); senão, o dia-alvo do
  // período ativo. Uma data fora do período pedido continua sendo respeitada —
  // quem passa `data` sabe o que quer.
  const alvo = v.dataOpcional(data, "Data") ?? per.dataAlvo;
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
    periodo: alvo.slice(0, 7),
    mesCorrente: alvo.slice(0, 7) === hoje.slice(0, 7),
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
      // tudo aqui é DO PERÍODO; o histórico anterior vai separado abaixo
      sequenciaBloqueada: u.pendenciasPeriodo.sequenciaBloqueada,
      pendenciaMaisAntiga: u.pendenciasPeriodo.desde,
      diasPendentes: u.pendenciasPeriodo.total,
      pendenciaHerdada: u.pendenciaHerdada.herdada,
      pendenciaHerdadaDesde: u.pendenciaHerdada.desde,
      diasPendentesHistorico: u.pendenciasAcum.total,
      historicoAnterior: u.historicoAnterior,
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
export async function pendencias({ hojeIso, mes } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const lista = listarPendencias(frota.unidades);
  return {
    monitor: frota.monitor,
    dataReferencia: frota.hojeIso,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
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
export async function empresas({ hojeIso, mes } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  return {
    monitor: frota.monitor,
    dataReferencia: frota.hojeIso,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    d1: frota.referencia,
    total: new Set(frota.unidades.map((u) => u.organizacaoId)).size,
    empresas: consolidarEmpresas(frota.unidades),
  };
}

// ---------------------------------------------------------------------------
// 5. DETALHE DA EMPRESA  —  GET /administrativo/empresas/:organizacaoId
// ---------------------------------------------------------------------------
export async function detalheEmpresa({ organizacaoId, hojeIso, mes } = {}, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const org = await obterOrganizacaoOperacional(orgId, deps);
  if (!org) throw ApiError.notFound("Empresa não encontrada ou fora do monitoramento.");

  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const daEmpresa = frota.unidades.filter((u) => u.organizacaoId === orgId);
  const cons = consolidarOperacao(daEmpresa);
  const resumoEmpresa = consolidarEmpresas(daEmpresa)[0] ?? null;

  return {
    monitor: frota.monitor,
    dataReferencia: frota.hojeIso,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
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
      // tudo aqui é DO PERÍODO; o histórico anterior vai separado abaixo
      sequenciaBloqueada: u.pendenciasPeriodo.sequenciaBloqueada,
      pendenciaMaisAntiga: u.pendenciasPeriodo.desde,
      diasPendentes: u.pendenciasPeriodo.total,
      pendenciaHerdada: u.pendenciaHerdada.herdada,
      pendenciaHerdadaDesde: u.pendenciaHerdada.desde,
      diasPendentesHistorico: u.pendenciasAcum.total,
      historicoAnterior: u.historicoAnterior,
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
  // Mesma validação de período do resto do painel (recusa formato inválido e
  // mês futuro); o mês corrente É permitido — os dias por vir aparecem como
  // NÃO APLICÁVEL, nunca como pendência.
  const per = alvoDoPeriodo(mes, hoje);
  const [ano, numMes] = per.periodo.split("-").map(Number);

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

  // Dia de referência DO PERÍODO: D-1 no mês corrente, último dia num mês
  // fechado — o mesmo alvo que a Visão Geral usa, para o calendário não
  // contar uma história diferente da tela que levou até ele.
  const dataAlvo = per.dataAlvo;
  const d1 = avaliarDia(projTodos, dataAlvo);
  const pend = pendenciasAntesDe(projTodos, dataAlvo);

  return {
    monitor: MONITOR.chave,
    dataReferencia: hoje,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
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

// ===========================================================================
// FINANCEIRO — consolidado, rankings, evolução e comparação
// ===========================================================================

/** Itens de ranking a partir da frota avaliada, no nível UNIDADE. */
const itensUnidade = (unidades) => (unidades ?? []).map((u) => ({
  id: u.unidadeId,
  nome: u.unidadeNome,
  extras: { organizacaoId: u.organizacaoId, empresaNome: u.empresaNome, criticidade: u.rollup?.status ?? null },
  faturamento: u.faturamento,
  cobertura: coberturaDe([u]),
  conformidadeMes: u.conformidade?.taxa ?? null,
}));

/** Itens de ranking no nível EMPRESA (agrega as unidades da organização). */
function itensEmpresa(unidades, porEmpresa) {
  const porOrg = new Map();
  for (const u of unidades ?? []) {
    const k = u.organizacaoId ?? "sem_empresa";
    if (!porOrg.has(k)) porOrg.set(k, []);
    porOrg.get(k).push(u);
  }
  return [...porOrg.entries()].map(([orgId, lista]) => {
    const rollup = (porEmpresa ?? []).find((e) => e.organizacaoId === orgId);
    return {
      id: orgId,
      nome: lista[0]?.empresaNome ?? null,
      extras: {
        unidadesMonitoradas: lista.length,
        unidadesPendentes: rollup?.unidadesPendentes ?? null,
        criticas: rollup?.criticas ?? null,
        atencao: rollup?.atencao ?? null,
      },
      faturamento: somarFaturamento(lista),
      cobertura: coberturaDe(lista),
      conformidadeMes: rollup?.conformidadeMes ?? coberturaDe(lista).taxa,
    };
  });
}

/** Consolidado da rede + líderes — o que a home executiva mostra. */
function resumoFinanceiroDaRede(unidades, porEmpresa) {
  const rede = somarFaturamento(unidades);
  const cobertura = coberturaDe(unidades);
  const topEmp = rankingFaturamento(itensEmpresa(unidades, porEmpresa), { limite: 1 })[0] ?? null;
  const topUni = rankingFaturamento(itensUnidade(unidades), { limite: 1 })[0] ?? null;
  return {
    ...rede,
    cobertura,
    liderEmpresa: topEmp && { organizacaoId: topEmp.id, nome: topEmp.nome, total: topEmp.faturamento.total },
    liderUnidade: topUni && { unidadeId: topUni.id, nome: topUni.nome, empresaNome: topUni.empresaNome, total: topUni.faturamento.total },
  };
}

/**
 * GET /administrativo/rankings/faturamento
 * @param {{mes?: string, escopo?: "empresas"|"unidades", limite?: number, hojeIso?: string}} p
 */
export async function rankingDeFaturamento({ hojeIso, mes, escopo = "empresas", limite } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const esc = v.umDe(escopo, "Escopo", ["empresas", "unidades"]);
  const lim = limite ? Number(limite) : null;

  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const porEmpresa = consolidarEmpresas(frota.unidades);
  const itens = esc === "unidades" ? itensUnidade(frota.unidades) : itensEmpresa(frota.unidades, porEmpresa);

  return {
    monitor: frota.monitor,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    d1: frota.referencia,
    escopo: esc,
    total: itens.length,
    rede: somarFaturamento(frota.unidades),
    itens: rankingFaturamento(itens, { limite: lim }),
  };
}

/**
 * GET /administrativo/rankings/conformidade
 * `ordem=asc` devolve quem precisa de mais atenção — mesma lista, outra ponta.
 */
export async function rankingDeConformidade({ hojeIso, mes, escopo = "empresas", ordem = "desc", limite } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const esc = v.umDe(escopo, "Escopo", ["empresas", "unidades"]);
  const ord = v.umDe(ordem, "Ordem", ["desc", "asc"]);
  const lim = limite ? Number(limite) : null;

  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const porEmpresa = consolidarEmpresas(frota.unidades);
  const itens = esc === "unidades" ? itensUnidade(frota.unidades) : itensEmpresa(frota.unidades, porEmpresa);

  return {
    monitor: frota.monitor,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    d1: frota.referencia,
    escopo: esc,
    ordem: ord,
    total: itens.length,
    itens: rankingConformidade(itens, { ordem: ord, limite: lim }),
  };
}

/**
 * GET /administrativo/relatorios/evolucao
 * Série diária da rede (ou de UMA empresa) no período.
 */
export async function evolucaoFaturamento({ hojeIso, mes, organizacaoId } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const orgFiltro = organizacaoId ? v.uuid(organizacaoId, "Empresa") : null;

  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const alvoUnidades = orgFiltro
    ? frota.unidades.filter((u) => u.organizacaoId === orgFiltro)
    : frota.unidades;

  const [ano, num] = per.periodo.split("-").map(Number);
  // A série vai só até o dia-alvo: dia futuro não tem faturamento, tem ausência.
  const dias = diasDoMes(ano, num).filter((d) => d <= per.dataAlvo);
  const serie = evolucaoDiaria(
    alvoUnidades.map((u) => ({ linhas: u.linhasDoPeriodo ?? [] })),
    dias,
  );

  return {
    monitor: frota.monitor,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    d1: frota.referencia,
    organizacaoId: orgFiltro,
    unidades: alvoUnidades.length,
    serie,
  };
}

/**
 * GET /administrativo/relatorios/resumo — o Relatório Executivo do período.
 *
 * Inclui a comparação com o mês anterior no PERÍODO EQUIVALENTE: 1..14/set
 * contra 1..14/ago, nunca contra o agosto inteiro. Custo: uma segunda
 * avaliação de frota (o mês anterior é outro recorte), ainda em lote.
 */
export async function relatorioExecutivo({ hojeIso, mes, topN = 5 } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const n = Math.max(1, Math.min(20, Number(topN) || 5));

  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const porEmpresa = consolidarEmpresas(frota.unidades);
  const cons = consolidarOperacao(frota.unidades);
  const empresas = itensEmpresa(frota.unidades, porEmpresa);
  const unidades = itensUnidade(frota.unidades);
  const fin = resumoFinanceiroDaRede(frota.unidades, porEmpresa);

  const comparacao = await compararComMesAnterior({ per, hoje, atual: { fin, cons } }, deps);

  return {
    monitor: frota.monitor,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    d1: frota.referencia,
    dataReferencia: frota.hojeIso,

    operacao: {
      empresasMonitoradas: cons.empresasMonitoradas,
      unidadesMonitoradas: cons.unidadesMonitoradas,
      empresasComPendencia: porEmpresa.filter((e) => e.unidadesPendentes > 0).length,
      unidadesComPendencia: porEmpresa.reduce((s, e) => s + (e.unidadesPendentes ?? 0), 0),
      criticas: cons.criticas, atencao: cons.atencao, emDia: cons.emDia,
    },
    conformidade: {
      d1: cons.d1.taxa,
      mes: cons.conformidadeMes.taxa,
      mesCompleto: cons.conformidadeMes.completos,
      mesEsperado: cons.conformidadeMes.esperados,
    },
    faturamento: fin,
    comparacao,

    prioridades: {
      empresas: porEmpresa.filter((e) => e.unidadesPendentes > 0).slice(0, n).map((e) => ({
        organizacaoId: e.organizacaoId, empresaNome: e.empresaNome,
        unidadesPendentes: e.unidadesPendentes, criticas: e.criticas, atencao: e.atencao,
        pendenciaMaisAntiga: e.pendenciaMaisAntiga, piorUnidade: e.piorUnidade,
      })),
      unidades: listarPendencias(frota.unidades).slice(0, n),
    },

    rankings: {
      faturamentoEmpresas: rankingFaturamento(empresas, { limite: n }),
      faturamentoUnidades: rankingFaturamento(unidades, { limite: n }),
      conformidadeEmpresas: rankingConformidade(empresas, { limite: n }),
      atencaoEmpresas: rankingConformidade(empresas, { ordem: "asc", limite: n }),
    },
  };
}

/**
 * Comparação com o mês anterior no MESMO número de dias corridos.
 * `null` quando o mês anterior não tem base — nunca fabrica crescimento.
 */
async function compararComMesAnterior({ per, hoje, atual }, deps) {
  const [ano, num] = per.periodo.split("-").map(Number);
  const ant = mesAnterior(ano, num);
  const diasAnt = diasDoMes(ant.ano, ant.mes);
  const alvoAnt = diaEquivalenteNoMesAnterior(per.dataAlvo, diasAnt);
  if (!alvoAnt) return null;

  const frotaAnt = await avaliarFrota({ hojeIso: hoje, dataAlvo: alvoAnt }, deps);
  if (!frotaAnt.unidades.length) return null;

  const finAnt = somarFaturamento(frotaAnt.unidades);
  const consAnt = consolidarOperacao(frotaAnt.unidades);
  const pendAnt = listarPendencias(frotaAnt.unidades).length;
  const pendAtual = atual.cons.criticas + atual.cons.atencao;

  return {
    periodo: `${ant.ano}-${String(ant.mes).padStart(2, "0")}`,
    ate: alvoAnt,
    diasEquivalentes: Number(per.dataAlvo.slice(8, 10)),
    faturamento: {
      anterior: finAnt.total,
      variacao: variacao(atual.fin.total, finAnt.total),
      // a comparação carrega o aviso quando QUALQUER um dos lados tem rascunho
      incluiProvisorio: !!(atual.fin.incluiProvisorio || finAnt.incluiProvisorio),
    },
    conformidadeMes: {
      anterior: consAnt.conformidadeMes.taxa,
      variacaoPP: variacaoPP(atual.cons.conformidadeMes.taxa, consAnt.conformidadeMes.taxa),
    },
    pendencias: { anterior: pendAnt, variacao: pendAtual - pendAnt },
  };
}

/**
 * GET /administrativo/relatorios/executivo — o PACOTE COMPLETO do período.
 *
 * Contrato único do relatório em PDF (item 23): uma chamada, tudo dentro. O
 * PDF é camada de APRESENTAÇÃO — não recalcula nada, não conhece `statusMes`,
 * não sabe o que é snapshot acumulado. Tudo aqui sai das mesmas funções que
 * alimentam a tela; se a regra mudar, o PDF acompanha sozinho.
 *
 * Custo: as mesmas 2 avaliações de frota do relatório executivo (período +
 * período equivalente anterior). Nenhuma query por empresa.
 *
 * PRIVACIDADE: só informação gerencial. Nenhum e-mail, PIN, token, credencial
 * ou id de usuário — `organizacaoId`/`unidadeId` viajam apenas porque a tela
 * usa para navegar, e o template do PDF não os imprime.
 */
export async function relatorioExecutivoCompleto({ hojeIso, mes, topN = 10 } = {}, deps = {}) {
  const hoje = hojeIso ?? hojeIsoBrasil();
  const per = alvoDoPeriodo(mes, hoje);
  const n = Math.max(1, Math.min(50, Number(topN) || 10));

  const frota = await avaliarFrota({ hojeIso: hoje, dataAlvo: per.dataAlvo }, deps);
  const porEmpresa = consolidarEmpresas(frota.unidades);
  const cons = consolidarOperacao(frota.unidades);
  const itensEmp = itensEmpresa(frota.unidades, porEmpresa);
  const itensUni = itensUnidade(frota.unidades);
  const fin = resumoFinanceiroDaRede(frota.unidades, porEmpresa);
  const comparacao = await compararComMesAnterior({ per, hoje, atual: { fin, cons } }, deps);

  // Faturamento por empresa/unidade, indexado — as tabelas completas casam o
  // financeiro com o operacional sem recalcular.
  const finPorEmpresa = new Map(itensEmp.map((i) => [i.id, i]));
  const finPorUnidade = new Map(itensUni.map((i) => [i.id, i]));

  const linhaEmpresa = (e) => {
    const f = finPorEmpresa.get(e.organizacaoId);
    return {
      organizacaoId: e.organizacaoId,
      empresaNome: e.empresaNome,
      unidadesMonitoradas: e.unidadesMonitoradas,
      unidadesPendentes: e.unidadesPendentes,
      criticas: e.criticas, atencao: e.atencao, emDia: e.emDia,
      conformidadeD1: e.conformidadeD1, conformidadeMes: e.conformidadeMes,
      d1Ok: e.d1Ok, severidade: e.severidade,
      pendenciaMaisAntiga: e.pendenciaMaisAntiga,
      piorUnidade: e.piorUnidade,
      historicoAnterior: e.historicoAnterior,
      pendentes: e.pendentes,
      faturamento: f?.faturamento ?? null,
      cobertura: f?.cobertura ?? null,
    };
  };

  const emDia = porEmpresa.filter((e) => e.unidadesPendentes === 0).map(linhaEmpresa);
  const comPendencia = porEmpresa.filter((e) => e.unidadesPendentes > 0).map(linhaEmpresa);

  const todasUnidades = frota.unidades.map((u) => {
    const f = finPorUnidade.get(u.unidadeId);
    return {
      organizacaoId: u.organizacaoId,
      empresaNome: u.empresaNome,
      unidadeId: u.unidadeId,
      unidadeNome: u.unidadeNome,
      d1Status: u.d1?.categoria ?? null,
      criticidade: u.rollup?.status ?? null,
      diasPendentes: u.pendenciasPeriodo?.total ?? 0,
      pendenciaMaisAntiga: u.pendenciasPeriodo?.desde ?? null,
      sequenciaBloqueada: u.pendenciasPeriodo?.sequenciaBloqueada ?? false,
      historicoAnterior: u.historicoAnterior,
      conformidadeMes: u.conformidade?.taxa ?? null,
      faturamento: f?.faturamento ?? null,
      cobertura: f?.cobertura ?? null,
    };
  }).sort((a, b) =>
    String(a.empresaNome ?? "").localeCompare(String(b.empresaNome ?? ""), "pt-BR")
    || String(a.unidadeNome ?? "").localeCompare(String(b.unidadeNome ?? ""), "pt-BR"));

  const [ano, num] = per.periodo.split("-").map(Number);
  const diasSerie = diasDoMes(ano, num).filter((d) => d <= per.dataAlvo);
  const evolucao = evolucaoDiaria(
    frota.unidades.map((u) => ({ linhas: u.linhasDoPeriodo ?? [] })),
    diasSerie,
  );

  return {
    monitor: frota.monitor,
    monitorNome: MONITOR.nome,
    periodo: per.periodo,
    mesCorrente: per.mesCorrente,
    d1: frota.referencia,
    dataReferencia: frota.hojeIso,
    geradoEm: new Date().toISOString(),

    operacao: {
      empresasMonitoradas: cons.empresasMonitoradas,
      unidadesMonitoradas: cons.unidadesMonitoradas,
      empresasComPendencia: comPendencia.length,
      empresasEmDia: emDia.length,
      unidadesComPendencia: porEmpresa.reduce((s, e) => s + (e.unidadesPendentes ?? 0), 0),
      criticas: cons.criticas, atencao: cons.atencao, emDia: cons.emDia,
    },
    conformidade: {
      d1: cons.d1.taxa,
      mes: cons.conformidadeMes.taxa,
      mesCompleto: cons.conformidadeMes.completos,
      mesEsperado: cons.conformidadeMes.esperados,
      d1Concluidas: cons.d1.concluidas,
      d1Elegiveis: cons.d1.elegiveis,
    },
    faturamento: fin,
    comparacao,
    evolucao,

    empresas: { emDia, comPendencia, todas: [...comPendencia, ...emDia] },
    unidades: todasUnidades,
    prioridades: listarPendencias(frota.unidades),

    rankings: {
      faturamentoEmpresas: rankingFaturamento(itensEmp, { limite: n }),
      faturamentoUnidades: rankingFaturamento(itensUni, { limite: n }),
      conformidadeEmpresas: rankingConformidade(itensEmp, { limite: 5 }),
      atencaoEmpresas: rankingConformidade(itensEmp, { ordem: "asc", limite: 5 }),
    },
  };
}
