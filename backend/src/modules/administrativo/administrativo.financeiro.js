// PAINEL ADMINISTRATIVO — motor FINANCEIRO (puro, sem I/O).
//
// ===========================================================================
// REGRA DE OURO: `valor_vendas_ifood` é SNAPSHOT ACUMULADO do mês.
// ===========================================================================
// Cada lançamento carrega o total do dia 1 até a data dele. Somar linhas de
// dias diferentes soma acumulado sobre acumulado e infla o faturamento em
// ordens de grandeza. A leitura correta é sempre UM snapshot por unidade —
// `snapshotFinanceiroMaisRecente`, a mesma função que o Dashboard Executivo
// usa. Este arquivo NUNCA reimplementa essa regra: importa e chama.
//
// O que é aditivo: snapshots de UNIDADES DIFERENTES (operações independentes,
// mesmo instante). É assim que empresa e rede são consolidadas.
//
// FONTE DE VERDADE: `valor_vendas_ifood` (etapa Financeiro). `valor_vendas_bruto`,
// `qtd_vendas` e ticket médio são da etapa Desempenho e NUNCA entram aqui.
//
// CONFIRMADO vs PROVISÓRIO: o snapshot mais recente pode estar em `rascunho`.
// O valor não é escondido (o gestor perderia faturamento real da visão), mas
// também não é apresentado como confirmado. A parte provisória é a DIFERENÇA
// entre o snapshot mais recente e o último snapshot FINALIZADO — não o
// snapshot inteiro, que incluiria dias já fechados.

import {
  snapshotFinanceiroMaisRecente, totalDeducoes, receitaAposDeducoes,
} from "../dashboard-executivo/dashboardExecutivo.calc.js";

/** Zero seguro: `null` (não sei) nunca vira 0 numa comparação, mas soma como 0. */
const n = (v) => (v == null ? 0 : Number(v));

/**
 * Faturamento de UMA unidade num conjunto de linhas (já filtrado ao período).
 *
 * @param {Array<object>} linhas linhas CRUAS do banco (mês da unidade)
 * @param {{ateDataIso?: string|null}} [opts] corta o snapshot num dia — é o que
 *   torna a comparação com o mês anterior justa (período equivalente).
 * @returns {{
 *   total: number|null, confirmado: number, provisorio: number,
 *   incluiProvisorio: boolean, statusSnapshot: string|null, dataSnapshot: string|null,
 *   deducoes: number|null, receitaLiquida: number|null
 * }}
 */
export function faturamentoDaUnidade(linhas, { ateDataIso = null } = {}) {
  const snap = snapshotFinanceiroMaisRecente(linhas, ateDataIso);
  if (!snap || snap.valor_vendas_ifood == null) {
    return {
      total: null, confirmado: 0, provisorio: 0, incluiProvisorio: false,
      statusSnapshot: null, dataSnapshot: null, deducoes: null, receitaLiquida: null,
    };
  }

  const total = Number(snap.valor_vendas_ifood);

  // O último snapshot FINALIZADO é o piso confirmado. A diferença até o
  // snapshot mais recente é o que ainda está em edição — não o snapshot
  // inteiro, que carregaria dias já fechados junto.
  const snapConfirmado = snapshotFinanceiroMaisRecente(
    (linhas ?? []).filter((r) => r.status === "finalizado"),
    ateDataIso,
  );
  const confirmado = snapConfirmado?.valor_vendas_ifood != null ? Number(snapConfirmado.valor_vendas_ifood) : 0;

  // `status` ausente (agregado sintético da distribuição mensal) conta como
  // confirmado — não há edição pendente nele.
  //
  // O ajuste PODE SER NEGATIVO: um rascunho que corrige o acumulado para BAIXO
  // (estorno, cancelamento, correção de lançamento) deixa `total < confirmado`.
  // Clampar em zero esconderia justamente a correção que o gestor precisa ver —
  // por isso é a diferença crua, com sinal.
  const provisorio = snap.status === "rascunho" ? total - confirmado : 0;

  const ded = totalDeducoes({
    taxasComissoes: snap.taxas_comissoes ?? null,
    servicosPromocoes: snap.servicos_promocoes ?? null,
    taxasEntregadores: snap.taxas_entregadores ?? null,
    outrasDeducoes: snap.outras_deducoes ?? null,
  });

  return {
    total,
    confirmado: provisorio !== 0 ? confirmado : total,
    provisorio,
    incluiProvisorio: provisorio !== 0,
    statusSnapshot: snap.status ?? null,
    dataSnapshot: snap.data_lancamento ?? null,
    deducoes: ded,
    receitaLiquida: receitaAposDeducoes(total, ded),
  };
}

/**
 * Soma faturamentos de unidades DIFERENTES (aditivo). `total` fica `null` só
 * quando NENHUMA unidade tem snapshot — zero e "ninguém lançou" são coisas
 * diferentes num painel de decisão.
 * @param {Array<{faturamento: ReturnType<typeof faturamentoDaUnidade>}>} unidades
 */
export function somarFaturamento(unidades) {
  const comDado = (unidades ?? []).filter((u) => u.faturamento?.total != null);
  if (!comDado.length) {
    return { total: null, confirmado: 0, provisorio: 0, incluiProvisorio: false, unidadesComDado: 0 };
  }
  const soma = (campo) => comDado.reduce((s, u) => s + n(u.faturamento[campo]), 0);
  const provisorio = soma("provisorio");
  return {
    total: soma("total"),
    confirmado: soma("confirmado"),
    provisorio,
    incluiProvisorio: provisorio !== 0,
    unidadesComDado: comDado.length,
  };
}

/**
 * Cobertura do período: quantos dias esperados já foram lançados. Vem da
 * conformidade que o motor de status já calcula — faturamento e disciplina
 * operacional são medidas SEPARADAS, exibidas lado a lado (nunca um score
 * misto).
 * @param {Array<{conformidade?: {completos: number, esperados: number}}>} unidades
 */
export function coberturaDe(unidades) {
  let completos = 0, esperados = 0;
  for (const u of unidades ?? []) {
    completos += n(u.conformidade?.completos);
    esperados += n(u.conformidade?.esperados);
  }
  return { completos, esperados, taxa: esperados ? completos / esperados : null };
}

// ---------------------------------------------------------------------------
// RANKINGS
// ---------------------------------------------------------------------------

/** Empate sempre pelo nome — determinístico, sem peso inventado. */
const porNome = (a, b) => String(a.nome ?? "").localeCompare(String(b.nome ?? ""), "pt-BR");

/**
 * Ranking por FATURAMENTO ABSOLUTO disponível (inclui a parte provisória, que
 * vai sinalizada). Nunca ordena por média nem por cobertura — quem lançou
 * menos dias aparece com a cobertura menor, não com a posição punida.
 * @param {Array<{id: string, nome: string, faturamento: object, cobertura: object, conformidadeMes: number|null, extras?: object}>} itens
 * @param {{limite?: number|null}} [opts]
 */
export function rankingFaturamento(itens, { limite = null } = {}) {
  const ordenado = (itens ?? [])
    .filter((i) => i.faturamento?.total != null)
    .sort((a, b) => {
      const d = (b.faturamento.total ?? 0) - (a.faturamento.total ?? 0);
      return d !== 0 ? d : porNome(a, b);
    })
    .map((i, idx) => ({
      posicao: idx + 1,
      id: i.id,
      nome: i.nome,
      ...i.extras,
      faturamento: i.faturamento,
      cobertura: i.cobertura,
      conformidadeMes: i.conformidadeMes ?? null,   // disciplina ao lado do valor
    }));
  return limite ? ordenado.slice(0, limite) : ordenado;
}

/**
 * Ranking por CONFORMIDADE (percentual real). `ordem: "desc"` = melhores;
 * `"asc"` = quem precisa de mais atenção. Sem denominador não entra — 0% e
 * "não havia dia esperado" são coisas diferentes.
 * @param {Array<object>} itens
 * @param {{ordem?: "desc"|"asc", limite?: number|null}} [opts]
 */
export function rankingConformidade(itens, { ordem = "desc", limite = null } = {}) {
  const sinal = ordem === "asc" ? 1 : -1;
  const ordenado = (itens ?? [])
    .filter((i) => i.conformidadeMes != null)
    .sort((a, b) => {
      const d = sinal * ((a.conformidadeMes ?? 0) - (b.conformidadeMes ?? 0));
      return d !== 0 ? d : porNome(a, b);
    })
    .map((i, idx) => ({
      posicao: idx + 1,
      id: i.id,
      nome: i.nome,
      ...i.extras,
      conformidadeMes: i.conformidadeMes,
      cobertura: i.cobertura,
      faturamento: i.faturamento,
    }));
  return limite ? ordenado.slice(0, limite) : ordenado;
}

// ---------------------------------------------------------------------------
// EVOLUÇÃO DIÁRIA
// ---------------------------------------------------------------------------

/**
 * Série diária da REDE a partir dos snapshots acumulados.
 *
 * O acumulado de cada dia é a soma, entre unidades, do snapshot daquela
 * unidade ATÉ aquele dia (somar acumulados de unidades diferentes no mesmo
 * instante é válido). O valor do DIA é o delta contra o dia anterior — e só
 * existe quando os dois lados existem: um buraco na série nunca vira uma
 * barra estimada.
 *
 * @param {Array<{linhas: Array<object>}>} unidades
 * @param {string[]} diasIso dias do período, em ordem
 */
export function evolucaoDiaria(unidades, diasIso) {
  const lista = unidades ?? [];
  const serie = [];
  let acumuladoAnterior = null;

  for (const dia of diasIso ?? []) {
    // acumulado da rede NAQUELE dia = Σ snapshot de cada unidade até o dia
    let acumulado = null;
    for (const u of lista) {
      const snap = snapshotFinanceiroMaisRecente(u.linhas, dia);
      if (snap?.valor_vendas_ifood == null) continue;
      acumulado = n(acumulado) + Number(snap.valor_vendas_ifood);
    }

    const valor = acumulado == null || acumuladoAnterior == null
      ? (acumulado != null && acumuladoAnterior == null && serie.length === 0 ? acumulado : null)
      : acumulado - acumuladoAnterior;

    serie.push({ data: dia, acumulado, valor });
    if (acumulado != null) acumuladoAnterior = acumulado;
  }
  return serie;
}

// ---------------------------------------------------------------------------
// COMPARAÇÃO COM O PERÍODO EQUIVALENTE
// ---------------------------------------------------------------------------

/**
 * Variação entre dois valores. `null` quando qualquer lado falta — nunca
 * fabrica crescimento sobre um período sem dado.
 */
export function variacao(atual, anterior) {
  if (atual == null || anterior == null || Number(anterior) === 0) return null;
  return (Number(atual) - Number(anterior)) / Number(anterior);
}

/** Variação em pontos percentuais (para taxas). */
export function variacaoPP(atual, anterior) {
  if (atual == null || anterior == null) return null;
  return Number(atual) - Number(anterior);
}

/**
 * O DIA equivalente no mês anterior. Comparar 1..14/set com 1..31/ago seria
 * mentira; o corte é sempre o mesmo número de dias corridos.
 * Dia inexistente (31 de um mês de 30) cai no último dia do mês anterior.
 * @param {string} alvoIso  último dia contabilizado no período atual
 * @param {{ano: number, mes: number}} mesAnt
 * @param {string[]} diasDoMesAnterior
 */
export function diaEquivalenteNoMesAnterior(alvoIso, diasDoMesAnterior) {
  const dia = Number(String(alvoIso).slice(8, 10));
  const lista = diasDoMesAnterior ?? [];
  if (!lista.length) return null;
  return lista[Math.min(dia, lista.length) - 1] ?? lista[lista.length - 1];
}
