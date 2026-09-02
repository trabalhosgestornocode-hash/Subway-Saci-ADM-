// MOTOR do Painel Administrativo — monitor "Dashboard iFood" (fechamento
// diário D-1 sequencial).
//
// FASE E: só a LÓGICA PURA. Sem I/O, sem endpoints, sem banco. Os endpoints
// cross-tenant e o carregamento em lote dos lançamentos entram na Fase F.
//
// ===========================================================================
// REGRA DE OURO: nenhum mapeamento pode MASCARAR uma pendência sequencial.
// ===========================================================================
// A sequência (PENDENTE / BLOQUEADO / "dia N+1 fica bloqueado se o N não
// resolveu") é do domínio do Dashboard iFood — `statusMes` em
// dashboardExecutivo.calc.js. Este arquivo NUNCA recalcula sequência: ele
// IMPORTA e CHAMA `statusMes`, e apenas PROJETA cada `STATUS_DIA` para um
// rótulo do painel + calcula D-1, conformidade e pendências acumuladas em
// cima dessa projeção.
//
// Consequências garantidas (ver administrativo-status.test.js):
//   * FINANCEIRO_PENDENTE nunca é "COMPLETO" — é INCOMPLETO / "em preenchimento";
//   * BLOQUEADO nunca "sobe" para COMPLETO/INCOMPLETO — é sempre NÃO LANÇADO
//     e marca a unidade como Crítico (sequência bloqueada);
//   * qualquer PENDENTE/BLOQUEADO ANTES de D-1 mantém a unidade em Crítico;
//   * D+0 (hoje) fica FORA da cobrança — nunca "crítico" por não estar
//     preenchido (o prazo do fechamento é sempre "ontem", igual ao
//     `dataLimiteVencido` do domínio);
//   * NENHUM limiar arbitrário — o rollup é puramente sequencial.

import {
  STATUS_DIA, statusMes, diaAnterior, hojeIsoBrasil, diasDoMes, mesAnterior,
} from "../dashboard-executivo/dashboardExecutivo.calc.js";

export { hojeIsoBrasil, diaAnterior, diasDoMes, mesAnterior };

/** Rótulos do painel — projeção dos STATUS_DIA do domínio. */
export const STATUS_PAINEL = {
  COMPLETO: "COMPLETO",
  INCOMPLETO: "INCOMPLETO",
  NAO_LANCADO: "NAO_LANCADO",
  NAO_APLICAVEL: "NAO_APLICAVEL",
};

/** Categorias do D-1 (o monitor diário principal). */
export const D1_CATEGORIA = {
  CONCLUIDO: "concluido",
  EM_PREENCHIMENTO: "em_preenchimento",
  NAO_REALIZADO: "nao_realizado",
  SEQUENCIA_BLOQUEADA: "sequencia_bloqueada",
  NAO_APLICAVEL: "nao_aplicavel",
};

/** Status consolidado de uma unidade. */
export const ROLLUP = { EM_DIA: "em_dia", ATENCAO: "atencao", CRITICO: "critico" };

// STATUS_DIA -> STATUS_PAINEL. Explícito, um a um. Nunca deriva sequência.
//   PREENCHIDO / SEM_OPERACAO / ZERO_VENDAS -> COMPLETO (dia fechado corretamente)
//   FINANCEIRO_PENDENTE / RASCUNHO          -> INCOMPLETO (começou, falta finalizar)
//   PENDENTE / BLOQUEADO                    -> NÃO LANÇADO
//   FUTURO                                  -> NÃO APLICÁVEL
const PROJECAO = {
  [STATUS_DIA.PREENCHIDO]: STATUS_PAINEL.COMPLETO,
  [STATUS_DIA.SEM_OPERACAO]: STATUS_PAINEL.COMPLETO,
  [STATUS_DIA.ZERO_VENDAS]: STATUS_PAINEL.COMPLETO,
  [STATUS_DIA.FINANCEIRO_PENDENTE]: STATUS_PAINEL.INCOMPLETO,
  [STATUS_DIA.RASCUNHO]: STATUS_PAINEL.INCOMPLETO,
  [STATUS_DIA.PENDENTE]: STATUS_PAINEL.NAO_LANCADO,
  [STATUS_DIA.BLOQUEADO]: STATUS_PAINEL.NAO_LANCADO,
  [STATUS_DIA.FUTURO]: STATUS_PAINEL.NAO_APLICAVEL,
};

/**
 * Projeta UM dia (item da saída de `statusMes`) para o painel.
 * @param {{data: string, status: string}} dia  saída de statusMes
 * @param {{hojeIso: string, unidadeCriadaEm?: string|null}} ctx
 * @returns {{data, statusDia, painel, bloqueada, emPreenchimento, motivoNaoAplicavel: string|null}}
 */
export function projetarDia(dia, { hojeIso, unidadeCriadaEm = null }) {
  const base = {
    data: dia.data,
    statusDia: dia.status,
    bloqueada: dia.status === STATUS_DIA.BLOQUEADO,
    emPreenchimento: dia.status === STATUS_DIA.FINANCEIRO_PENDENTE || dia.status === STATUS_DIA.RASCUNHO,
  };

  // D+0 e futuro: fora da cobrança. A fronteira do fechamento é SEMPRE "ontem"
  // (mesma regra do domínio: `dataLimiteVencido = diaAnterior(hojeIso)`).
  // NUNCA marcar hoje como crítico por não estar preenchido.
  if (dia.data >= hojeIso) {
    return { ...base, painel: STATUS_PAINEL.NAO_APLICAVEL, motivoNaoAplicavel: dia.data === hojeIso ? "hoje" : "futuro" };
  }

  // Antes de a unidade existir — nunca houve obrigação.
  const criadaEmDia = unidadeCriadaEm ? String(unidadeCriadaEm).slice(0, 10) : null;
  if (criadaEmDia && dia.data < criadaEmDia) {
    return { ...base, painel: STATUS_PAINEL.NAO_APLICAVEL, motivoNaoAplicavel: "antes_da_criacao" };
  }

  return { ...base, painel: PROJECAO[dia.status] ?? STATUS_PAINEL.NAO_APLICAVEL, motivoNaoAplicavel: null };
}

/**
 * Roda `statusMes` (FONTE ÚNICA da sequência) para um mês e projeta cada dia.
 * @param {{dias: Array<{data: string, lancamento: object|null}>, hojeIso: string, unidadeCriadaEm?: string|null}} p
 * @returns {Array<ReturnType<typeof projetarDia>>}
 */
export function projetarMes({ dias, hojeIso, unidadeCriadaEm = null }) {
  const comStatus = statusMes({ dias, hojeIso });
  return comStatus.map((d) => projetarDia(d, { hojeIso, unidadeCriadaEm }));
}

/**
 * Categoriza UM dia da lista já projetada (`dataAlvo` tem de estar contido).
 * É a lógica que `avaliarD1` sempre usou — extraída para servir a qualquer
 * data (o Monitoramento Diário consulta um dia passado). Mesma projeção,
 * mesma fonte (`statusMes`); só o dia de referência muda.
 * @param {Array<ReturnType<typeof projetarDia>>} diasProjetados
 * @param {string} dataAlvo  ISO AAAA-MM-DD
 * @returns {{data: string, elegivel: boolean, categoria: string, statusDia?: string, bloqueada?: boolean}}
 */
export function avaliarDia(diasProjetados, dataAlvo) {
  const dia = (diasProjetados ?? []).find((d) => d.data === dataAlvo);

  if (!dia || dia.painel === STATUS_PAINEL.NAO_APLICAVEL) {
    // Unidade criada depois, dia futuro/hoje, ou fora do período carregado ->
    // sem obrigação (nunca conta contra a unidade).
    return { data: dataAlvo, elegivel: false, categoria: D1_CATEGORIA.NAO_APLICAVEL };
  }

  let categoria;
  if (dia.bloqueada) categoria = D1_CATEGORIA.SEQUENCIA_BLOQUEADA;
  else if (dia.painel === STATUS_PAINEL.COMPLETO) categoria = D1_CATEGORIA.CONCLUIDO;
  else if (dia.painel === STATUS_PAINEL.INCOMPLETO) categoria = D1_CATEGORIA.EM_PREENCHIMENTO;
  else categoria = D1_CATEGORIA.NAO_REALIZADO; // PENDENTE isolado

  return { data: dataAlvo, elegivel: true, categoria, statusDia: dia.statusDia, bloqueada: dia.bloqueada };
}

/**
 * O fechamento de ONTEM foi feito? Olha SÓ o dia `diaAnterior(hojeIso)`.
 * @param {Array<ReturnType<typeof projetarDia>>} diasProjetados  precisa CONTER o dia D-1
 * @param {string} hojeIso
 * @returns {{data: string, elegivel: boolean, categoria: string, statusDia?: string, bloqueada?: boolean}}
 */
export function avaliarD1(diasProjetados, hojeIso) {
  return avaliarDia(diasProjetados, diaAnterior(hojeIso));
}

/**
 * Conformidade de um conjunto de dias (tipicamente o MÊS corrente).
 * dias esperados = os que NÃO são NÃO APLICÁVEL (exclui futuro, hoje, pré-criação).
 * @param {Array<ReturnType<typeof projetarDia>>} diasProjetados
 * @returns {{esperados: number, completos: number, incompletos: number, naoLancados: number, taxa: number|null}}
 */
export function conformidadeMes(diasProjetados) {
  const esperados = (diasProjetados ?? []).filter((d) => d.painel !== STATUS_PAINEL.NAO_APLICAVEL);
  const completos = esperados.filter((d) => d.painel === STATUS_PAINEL.COMPLETO).length;
  const incompletos = esperados.filter((d) => d.painel === STATUS_PAINEL.INCOMPLETO).length;
  const naoLancados = esperados.filter((d) => d.painel === STATUS_PAINEL.NAO_LANCADO).length;
  return {
    esperados: esperados.length,
    completos, incompletos, naoLancados,
    taxa: esperados.length ? completos / esperados.length : null,
  };
}

/**
 * Pendências ACUMULADAS: dias NÃO LANÇADO ANTES de D-1. Aceita dias de vários
 * meses concatenados (o mais antigo primeiro) — é assim que a pendência
 * atravessa a virada de mês, já que `statusMes` só calcula sequência DENTRO
 * de um mês.
 * @param {Array<ReturnType<typeof projetarDia>>} diasProjetados
 * @param {string} hojeIso
 * @returns {{dias: string[], total: number, desde: string|null, sequenciaBloqueada: boolean}}
 */
export function pendenciasAntesDe(diasProjetados, dataLimite) {
  const anteriores = (diasProjetados ?? [])
    .filter((d) => d.data < dataLimite && d.painel === STATUS_PAINEL.NAO_LANCADO)
    .map((d) => d.data)
    .sort();
  return {
    dias: anteriores,
    total: anteriores.length,
    desde: anteriores[0] ?? null,
    // "Sequência bloqueada" = há pendência acumulada, OU o próprio statusMes
    // marcou algum dia como BLOQUEADO (dia posterior a um não resolvido).
    sequenciaBloqueada: anteriores.length > 0 || (diasProjetados ?? []).some((d) => d.bloqueada),
  };
}

export function pendenciasAcumuladas(diasProjetados, hojeIso) {
  return pendenciasAntesDe(diasProjetados, diaAnterior(hojeIso));
}

/**
 * Data do último dia CONCLUÍDO (painel COMPLETO) e do último dia COM QUALQUER
 * registro (COMPLETO ou INCOMPLETO) na lista projetada. Puro — para os cards
 * de "última atualização" do painel. NÃO é regra de sequência.
 * @param {Array<ReturnType<typeof projetarDia>>} diasProjetados
 * @returns {{ultimoCompleto: string|null, ultimoRegistro: string|null}}
 */
export function ultimosLancamentos(diasProjetados) {
  const lista = diasProjetados ?? [];
  const ult = (pred) => {
    const datas = lista.filter(pred).map((d) => d.data).sort();
    return datas.length ? datas[datas.length - 1] : null;
  };
  return {
    ultimoCompleto: ult((d) => d.painel === STATUS_PAINEL.COMPLETO),
    ultimoRegistro: ult((d) => d.painel === STATUS_PAINEL.COMPLETO || d.painel === STATUS_PAINEL.INCOMPLETO),
  };
}

/**
 * Status consolidado de UMA unidade. PURAMENTE sequencial — sem percentual,
 * sem limiar arbitrário.
 *
 *   Crítico  -> pendência acumulada antes de D-1, OU D-1 com sequência bloqueada.
 *   Atenção  -> D-1 não realizado (isolado) OU D-1 em preenchimento.
 *   Em dia   -> D-1 concluído e nada pendente antes dele.
 *   (unidade sem obrigação de D-1 -> "em_dia" se não há pendência; senão o que a pendência disser)
 *
 * @param {{d1: ReturnType<typeof avaliarD1>, pendenciasAcum: ReturnType<typeof pendenciasAcumuladas>}} p
 * @returns {{status: string, motivo: string}}
 */
export function rollupUnidade({ d1, pendenciasAcum }) {
  if (pendenciasAcum.total > 0 || d1.categoria === D1_CATEGORIA.SEQUENCIA_BLOQUEADA) {
    const desde = pendenciasAcum.desde;
    return {
      status: ROLLUP.CRITICO,
      motivo: pendenciasAcum.total > 0
        ? `${pendenciasAcum.total} dia(s) sem lançamento acumulado(s)${desde ? ` desde ${desde}` : ""} — sequência bloqueada.`
        : "O lançamento de ontem está bloqueado por um dia anterior pendente.",
    };
  }
  if (d1.categoria === D1_CATEGORIA.NAO_REALIZADO) {
    return { status: ROLLUP.ATENCAO, motivo: "O lançamento de ontem ainda não foi feito." };
  }
  if (d1.categoria === D1_CATEGORIA.EM_PREENCHIMENTO) {
    return { status: ROLLUP.ATENCAO, motivo: "O lançamento de ontem foi iniciado, mas não finalizado — concluir hoje." };
  }
  if (d1.categoria === D1_CATEGORIA.CONCLUIDO) {
    return { status: ROLLUP.EM_DIA, motivo: "Fechamento de ontem concluído e sem pendências anteriores." };
  }
  // D-1 não aplicável (unidade nova) e sem pendência -> em dia.
  return { status: ROLLUP.EM_DIA, motivo: "Sem obrigação de fechamento no período." };
}

/**
 * Avalia UMA unidade de ponta a ponta a partir dos dias já carregados
 * (concatenados, mês corrente + anteriores relevantes, mais antigo primeiro).
 * @param {{
 *   diasCorrente: Array<{data: string, lancamento: object|null}>,
 *   diasAnteriores?: Array<{data: string, lancamento: object|null}>,
 *   hojeIso: string,
 *   unidadeCriadaEm?: string|null,
 * }} p
 */
export function avaliarUnidade({ diasCorrente, diasAnteriores = [], hojeIso, unidadeCriadaEm = null, dataAlvo = null }) {
  // `dataAlvo` ausente = D-1 de hoje (a Visão Geral). Presente = um dia passado
  // (o Monitoramento Diário) — a conformidade continua sendo a do MÊS de
  // `diasCorrente`, só o dia de referência e o corte de pendência mudam.
  const alvo = dataAlvo ?? diaAnterior(hojeIso);
  const projCorrente = projetarMes({ dias: diasCorrente, hojeIso, unidadeCriadaEm });
  const projAnteriores = diasAnteriores.length
    ? projetarMes({ dias: diasAnteriores, hojeIso, unidadeCriadaEm })
    : [];
  const todos = [...projAnteriores, ...projCorrente];

  const d1 = avaliarDia(todos, alvo);
  const conformidade = conformidadeMes(projCorrente);       // conformidade do MÊS de diasCorrente
  const pendenciasAcum = pendenciasAntesDe(todos, alvo);    // dias NÃO LANÇADO antes de `alvo`
  const rollup = rollupUnidade({ d1, pendenciasAcum });
  const ultimos = ultimosLancamentos(todos);

  return { d1, conformidade, pendenciasAcum, rollup, ultimos, diasProjetados: projCorrente };
}
