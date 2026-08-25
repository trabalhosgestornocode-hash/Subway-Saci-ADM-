// Motor central de diagnóstico do Dashboard iFood — "Diagnóstico via Crescer
// c/ Delivery" (o que está acontecendo) + "Plano de Ação" (o que fazer).
//
// REGRA DE OURO: só afirma o que os dados sustentam. Nunca inventa causa
// ("caiu porque as promoções…") — descreve o desvio e calcula o que dá pra
// calcular (quanto falta, até quando, qual o valor em R$). Sem dado
// suficiente, o achado simplesmente não é gerado — nunca um número forçado.
//
// FONTE ÚNICA: cada achado (ponto forte/atenção/alerta) tem um `id` estável.
// Quando ele vira ação no Plano, a ação carrega esse MESMO id em
// `diagnosticoId` — o Plano nunca lista um problema que o Diagnóstico não
// listou, e os dois nunca divergem porque são a mesma passada de dados.
//
// EXTENSÍVEL de propósito: cada tipo de achado é uma função `analisar*()`
// independente que devolve `{achado, acao}` ou `null`. Novos diagnósticos
// (CMV alto, ticket médio baixo, queda de pedidos…) entram como mais uma
// função na lista `ANALISADORES`, sem tocar no motor central nem nos outros
// analisadores.
import { statusIndicador } from "./dashboardExecutivo.calc.js";

// ---------------------------------------------------------------------------
// LIMIARES — únicos, documentados, nunca duplicados/hardcoded no frontend.
// Mudou o número? Muda só aqui.
// ---------------------------------------------------------------------------
export const LIMIARES_DIAGNOSTICO = {
  // Queda de faturamento no período comparável: abaixo disso já vira achado.
  quedaAtencaoPct: -5,
  quedaAlertaPct: -20,
  // Confiabilidade dos dados do mês.
  diasPendentesParaMedia: 1,
  diasPendentesParaBaixa: 5,
  diasEstimadosParaBaixa: 1,
  // Plano de recuperação: se a média necessária for mais que isto vezes a
  // média atual, a meta integral vira "pouco provável" e mostramos cenários.
  recuperacaoMultiplicadorPoucoProvavel: 2,
  cenarioParcialPct: 10, // "recuperação parcial" = média atual + 10%
  cenarioForcaPct: 20,   // "recuperação forte"   = média atual + 20%
  diasParaAmostraPendentes: 5, // quantas datas listar antes de "+N dias"
};

const fmtPct1 = (v) => `${Number(v).toFixed(1)}%`;
const fmtPp1 = (v) => `${Number(v).toFixed(1)} p.p.`;
const fmtR = (v) => `R$ ${Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDataBrCurta = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

const ROTULO_INDICADOR = {
  taxas_comissoes: "Taxas e Comissões",
  servicos_promocoes: "Serviços e Promoções",
  taxas_entregadores: "Taxas de Entregadores",
};

// ---------------------------------------------------------------------------
// CONFIABILIDADE DOS DADOS — quão bem sustentado está o diagnóstico do mês.
// Regras objetivas e centralizadas (ver LIMIARES_DIAGNOSTICO acima); nada de
// score obscuro.
// ---------------------------------------------------------------------------
export function confiabilidadeDados({ diasComDados, diasPendentes, diasEstimados }) {
  if (!diasComDados) return { nivel: "indisponivel", motivo: "Ainda não há lançamentos neste mês." };
  const L = LIMIARES_DIAGNOSTICO;
  const motivos = [];
  let nivel = "alta";
  if (diasEstimados >= L.diasEstimadosParaBaixa) {
    nivel = "baixa";
    motivos.push(`${diasEstimados} dia(s) com valor estimado por distribuição mensal (não é dado diário real)`);
  }
  if (diasPendentes >= L.diasPendentesParaBaixa) {
    nivel = "baixa";
    motivos.push(`${diasPendentes} dias pendentes`);
  } else if (diasPendentes >= L.diasPendentesParaMedia && nivel === "alta") {
    nivel = "media";
    motivos.push(`${diasPendentes} dia(s) pendente(s)`);
  }
  return { nivel, motivo: motivos.length ? motivos.join(" · ") : "Mês com todos os dias regularizados." };
}

// ---------------------------------------------------------------------------
// ANALISADORES — cada um cuida de UM tipo de achado.
// ---------------------------------------------------------------------------

/** Taxas e Comissões / Serviços e Promoções — meta ideal x limite, em % e R$. */
function analisarIndicadorPercentual(chave, dado, faturamentoBase) {
  if (!dado || dado.naoAplicavel || dado.atual == null || !dado.meta) return null;
  const rotulo = ROTULO_INDICADOR[chave];
  const st = statusIndicador(dado.atual, dado.meta);

  if (st.chave === "dentro_da_meta") {
    return {
      achado: {
        id: `${chave}_dentro_da_meta`, categoria: chave, severidade: "forte",
        titulo: `${rotulo} dentro da meta ideal`,
        descricao: `${rotulo} está em ${fmtPct1(dado.atual)}, dentro da meta ideal de ${fmtPct1(dado.meta.metaIdeal)}.`,
        metricas: { percentualAtual: dado.atual, percentualIdeal: dado.meta.metaIdeal, percentualLimite: dado.meta.limite, valorAtual: dado.valor },
      },
      acao: null,
    };
  }

  const valorIdeal = faturamentoBase != null ? (faturamentoBase * dado.meta.metaIdeal) / 100 : null;
  const excesso = valorIdeal != null && dado.valor != null ? dado.valor - valorIdeal : null;
  const limiteReais = dado.saldo?.limiteReais ?? null;
  const margemReais = dado.saldo?.disponivelReais ?? null;
  const margemPp = dado.saldo?.disponivelPp ?? null;
  const severidade = st.chave === "atencao" ? "atencao" : "alerta";
  const titulo = severidade === "atencao" ? `${rotulo} acima da meta ideal` : `${rotulo} acima do limite máximo`;

  let descricaoAcao;
  if (severidade === "atencao") {
    descricaoAcao = excesso != null
      ? `Para retornar à meta ideal de ${fmtPct1(dado.meta.metaIdeal)} considerando o faturamento registrado até agora, seria necessário reduzir aproximadamente ${fmtR(excesso)} em ${rotulo}.`
      : `${rotulo} está acima da meta ideal (${fmtPct1(dado.atual)} > ${fmtPct1(dado.meta.metaIdeal)}), ainda dentro do limite de ${fmtPct1(dado.meta.limite)}.`;
    if (margemReais != null && margemReais > 0) {
      descricaoAcao += ` Ainda existe margem até o limite máximo (${fmtPp1(margemPp)} · ${fmtR(margemReais)}), mas como a unidade já está acima da meta ideal, não é recomendável ampliar os gastos sem avaliar o retorno das campanhas existentes.`;
    }
  } else {
    const excessoSobreLimite = limiteReais != null && dado.valor != null ? dado.valor - limiteReais : null;
    descricaoAcao = `${rotulo} ultrapassou o limite máximo de ${fmtPct1(dado.meta.limite)}.`;
    if (excessoSobreLimite != null) descricaoAcao += ` Para voltar ao limite, reduza aproximadamente ${fmtR(excessoSobreLimite)}`;
    if (excesso != null) descricaoAcao += `${excessoSobreLimite != null ? "; para voltar à meta ideal" : "Para voltar à meta ideal"}, aproximadamente ${fmtR(excesso)}.`;
  }

  return {
    achado: {
      id: `${chave}_${st.chave}`, categoria: chave, severidade, titulo,
      descricao: `${rotulo} está em ${fmtPct1(dado.atual)} — meta ideal ${fmtPct1(dado.meta.metaIdeal)}, limite ${fmtPct1(dado.meta.limite)}.`,
      metricas: {
        percentualAtual: dado.atual, percentualIdeal: dado.meta.metaIdeal, percentualLimite: dado.meta.limite,
        valorAtual: dado.valor, valorIdeal, excesso, limiteReais, margemAteLimiteReais: margemReais, margemAteLimitePp: margemPp,
      },
    },
    acao: {
      diagnosticoId: `${chave}_${st.chave}`, titulo,
      descricao: descricaoAcao,
      cta: { label: `Analisar ${rotulo}`, aba: "indicadores" },
    },
  };
}

/** Total de Deduções — meta ideal x limite + qual componente mais contribui (sem inferir causa). */
function analisarTotalDeducoes(dado, componentes, faturamentoBase) {
  if (!dado || dado.atual == null || !dado.meta) return null;
  const st = statusIndicador(dado.atual, dado.meta);

  if (st.chave === "dentro_da_meta") {
    return {
      achado: {
        id: "total_deducoes_dentro_da_meta", categoria: "total_deducoes", severidade: "forte",
        titulo: "Total de Deduções dentro da meta ideal",
        descricao: `Total de deduções em ${fmtPct1(dado.atual)}, dentro da meta ideal de ${fmtPct1(dado.meta.metaIdeal)}.`,
        metricas: { percentualAtual: dado.atual, percentualIdeal: dado.meta.metaIdeal, percentualLimite: dado.meta.limite },
      },
      acao: null,
    };
  }

  const conhecidos = componentes.filter((c) => c.percentual != null).sort((a, b) => b.percentual - a.percentual);
  const maior = conhecidos[0] ?? null;
  const composicaoTexto = maior ? ` O componente com maior participação é ${maior.rotulo} (${fmtPct1(maior.percentual)} do faturamento) — não significa necessariamente a causa da variação, só onde está a maior parcela.` : "";
  const severidade = st.chave === "atencao" ? "atencao" : "alerta";
  const excesso = faturamentoBase != null && dado.valor != null ? dado.valor - (faturamentoBase * dado.meta.metaIdeal) / 100 : null;
  const titulo = severidade === "atencao" ? "Total de Deduções acima da meta ideal" : "Total de Deduções acima do limite máximo";

  return {
    achado: {
      id: `total_deducoes_${st.chave}`, categoria: "total_deducoes", severidade, titulo,
      descricao: `Total de deduções em ${fmtPct1(dado.atual)} — meta ideal ${fmtPct1(dado.meta.metaIdeal)}, limite ${fmtPct1(dado.meta.limite)}.${composicaoTexto}`,
      metricas: { percentualAtual: dado.atual, percentualIdeal: dado.meta.metaIdeal, percentualLimite: dado.meta.limite, excesso, composicao: conhecidos },
    },
    acao: {
      diagnosticoId: `total_deducoes_${st.chave}`,
      titulo: "Revisar a composição das deduções",
      descricao: (excesso != null ? `Para retornar à meta ideal, é necessário reduzir aproximadamente ${fmtR(excesso)} no total de deduções.` : "Total de deduções acima do esperado.") + composicaoTexto,
      cta: { label: "Ver Indicadores", aba: "indicadores" },
    },
  };
}

/**
 * Faturamento — comparação com o período de referência + plano de
 * recuperação. `comparativo` já vem pronto do service (mesmo período quando
 * o mês está em andamento, mês fechado x mês fechado quando não está — ver
 * dashboardExecutivo.service.js#calcularComparativoFaturamento).
 */
function analisarFaturamento(comparativo, recuperacao) {
  if (!comparativo || comparativo.tipo === "indisponivel" || comparativo.pct == null) return null;
  const L = LIMIARES_DIAGNOSTICO;
  const rotuloRecorte = comparativo.tipo === "mesmo_periodo" ? `nos primeiros ${comparativo.diaComparado} dias` : "no mês fechado";
  const notaEstimativa = comparativo.temEstimativa ? " Atenção: um dos períodos comparados inclui dias com valor estimado por distribuição mensal, não lançamento diário real." : "";

  if (comparativo.pct > 0) {
    return {
      achado: {
        id: "faturamento_cresceu", categoria: "faturamento", severidade: "forte",
        titulo: "Faturamento em crescimento",
        descricao: `Faturamento cresceu ${fmtPct1(comparativo.pct)} ${rotuloRecorte}, comparado ao mesmo recorte do mês anterior (${fmtR(comparativo.anterior)} → ${fmtR(comparativo.atual)}).${notaEstimativa}`,
        metricas: { ...comparativo },
      },
      acao: null,
    };
  }
  if (comparativo.pct > L.quedaAtencaoPct) return null; // queda pequena — não vira achado

  const severidade = comparativo.pct <= L.quedaAlertaPct ? "alerta" : "atencao";
  const achado = {
    id: "faturamento_caiu", categoria: "faturamento", severidade,
    titulo: "Faturamento em queda",
    descricao: `Faturamento caiu ${fmtPct1(Math.abs(comparativo.pct))} ${rotuloRecorte}, comparado ao mesmo recorte do mês anterior (${fmtR(comparativo.anterior)} → ${fmtR(comparativo.atual)}, diferença de ${fmtR(comparativo.diferenca)}).${notaEstimativa} Dados insuficientes para determinar a causa com segurança — este diagnóstico aponta o desvio, não o motivo.`,
    metricas: { ...comparativo },
  };

  let acao = null;
  if (recuperacao) {
    const descricao = recuperacao.diasRestantes <= 0
      ? `O mês está praticamente encerrado — recuperação integral não é mais possível dentro deste período. Faturamento de referência (mês anterior): ${fmtR(recuperacao.referencia)}; registrado até agora: ${fmtR(recuperacao.atual)}.`
      : recuperacao.poucoProvavel
        ? `Recuperação integral pouco provável com base no ritmo atual — seria necessário elevar a média diária de ${fmtR(recuperacao.mediaAtual ?? 0)} para ${fmtR(recuperacao.mediaNecessaria)} nos ${recuperacao.diasRestantes} dia(s) restantes. Cenários possíveis: conservador (mantém o ritmo atual) ${fmtR(recuperacao.cenarios.conservador)}/dia · recuperação parcial (+${L.cenarioParcialPct}%) ${fmtR(recuperacao.cenarios.parcial)}/dia · recuperação forte (+${L.cenarioForcaPct}%) ${fmtR(recuperacao.cenarios.forte)}/dia. São cenários matemáticos, não uma previsão estatística.`
        : `Para atingir o faturamento de referência de ${fmtR(recuperacao.referencia)} até o final do mês, a unidade precisa elevar sua média diária de aproximadamente ${fmtR(recuperacao.mediaAtual ?? 0)} para ${fmtR(recuperacao.mediaNecessaria)} nos próximos ${recuperacao.diasRestantes} dia(s) — faltam ${fmtR(recuperacao.faltante)}.`;
    acao = {
      diagnosticoId: "faturamento_caiu",
      titulo: recuperacao.diasRestantes <= 0 ? "Mês encerrado — ver fechamento" : (recuperacao.poucoProvavel ? "Cenários para o restante do mês" : "Plano de recuperação do faturamento"),
      descricao,
      cta: { label: "Ver plano de recuperação", expandir: "recuperacao" },
      detalhe: recuperacao,
    };
  }
  return { achado, acao };
}

/** Dias sem lançamento — sempre acionável, aponta exatamente quais dias. */
function analisarDiasPendentes(diasPendentes, datas) {
  if (!diasPendentes) return null;
  const L = LIMIARES_DIAGNOSTICO;
  const severidade = diasPendentes >= L.diasPendentesParaBaixa ? "alerta" : "atencao";
  const amostra = datas.slice(0, L.diasParaAmostraPendentes).map(fmtDataBrCurta).join(", ");
  const resto = datas.length > L.diasParaAmostraPendentes ? ` e +${datas.length - L.diasParaAmostraPendentes} dia(s)` : "";
  const plural = diasPendentes > 1 ? "s" : "";
  return {
    achado: {
      id: "dias_pendentes", categoria: "dados", severidade,
      titulo: `${diasPendentes} lançamento${plural} pendente${plural}`,
      descricao: `Existem ${diasPendentes} dia${plural} sem lançamento neste mês (${amostra}${resto}). Enquanto existirem lançamentos pendentes, faturamento, médias, projeções e comparações deste mês podem estar subestimados.`,
      metricas: { diasPendentes, datas },
    },
    acao: {
      diagnosticoId: "dias_pendentes",
      titulo: `Regularizar ${diasPendentes} dia${plural}`,
      descricao: `Os seguintes dias ainda não possuem lançamento: ${amostra}${resto}.`,
      cta: { label: `Regularizar ${diasPendentes} dia${plural}`, aba: "lancamentos" },
    },
  };
}

/** Detalhamento financeiro (taxas/serviços/deduções) totalmente ausente no mês — ex.: mês só com lançamento mensal. */
function analisarDetalhamentoAusente(indicadores) {
  const chaves = ["taxas_comissoes", "servicos_promocoes", "total_deducoes"];
  const relevantes = chaves.filter((c) => !indicadores[c]?.naoAplicavel);
  if (!relevantes.length || !relevantes.every((c) => indicadores[c]?.atual == null)) return null;
  return {
    achado: {
      id: "detalhamento_financeiro_ausente", categoria: "dados", severidade: "atencao",
      titulo: "Detalhamento financeiro ainda não disponível",
      descricao: "Taxas e Comissões, Serviços e Promoções e Total de Deduções — dados insuficientes para avaliação neste mês.",
      metricas: {},
    },
    acao: {
      diagnosticoId: "detalhamento_financeiro_ausente",
      titulo: "Completar dados financeiros",
      descricao: "Complete os dados financeiros dos lançamentos para habilitar esta análise.",
      cta: { label: "Ir para Lançamentos", aba: "lancamentos" },
    },
  };
}

// ---------------------------------------------------------------------------
// PRIORIDADE DO PLANO DE AÇÃO — única regra de ordenação, nunca duplicada.
//   1. Alertas críticos (financeiro acima do limite / queda forte)
//   2. Pontos de atenção financeiros
//   3. Problemas de qualidade dos dados (pendências, detalhamento ausente)
//   4. Demais (reservado para oportunidades de melhoria futuras)
// ---------------------------------------------------------------------------
function prioridadeDe(achado) {
  if (achado.categoria === "dados") return 3;
  if (achado.severidade === "alerta") return 1;
  if (achado.severidade === "atencao") return 2;
  return 4;
}

// ---------------------------------------------------------------------------
// MOTOR CENTRAL
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   indicadores: Record<string, {atual: number|null, valor: number|null, meta: {metaIdeal:number,limite:number}|null, saldo: object|null, naoAplicavel: boolean}>,
 *   faturamentoBase: number|null,
 *   diasComDados: number,
 *   diasPendentes: number,
 *   diasPendentesDatas: string[],
 *   diasEstimados: number,
 *   comparativo: object|null,
 *   recuperacao: object|null,
 * }} input
 */
export function gerarDiagnostico(input) {
  const { indicadores, faturamentoBase, diasComDados, diasPendentes, diasPendentesDatas, diasEstimados, comparativo, recuperacao } = input;

  if (!diasComDados) {
    return {
      pontosFortes: [], pontosAtencao: [], alertas: [], acoes: [],
      semDadosSuficientes: true,
      confiabilidade: confiabilidadeDados({ diasComDados: 0, diasPendentes, diasEstimados }),
    };
  }

  const componentesDeducao = [
    { chave: "taxas_comissoes", rotulo: "Taxas e Comissões", percentual: indicadores.taxas_comissoes?.atual ?? null },
    { chave: "servicos_promocoes", rotulo: "Serviços e Promoções", percentual: indicadores.servicos_promocoes?.atual ?? null },
    { chave: "taxas_entregadores", rotulo: "Taxas de Entregadores", percentual: indicadores.taxas_entregadores?.atual ?? null },
  ];

  // Lista de analisadores — adicionar um novo diagnóstico é adicionar uma
  // entrada aqui, sem tocar no resto do motor (ver cabeçalho do arquivo).
  const ANALISADORES = [
    () => analisarIndicadorPercentual("taxas_comissoes", indicadores.taxas_comissoes, faturamentoBase),
    () => analisarIndicadorPercentual("servicos_promocoes", indicadores.servicos_promocoes, faturamentoBase),
    // Etapa H — dado já existia (meta/saldo calculados desde a introdução do
    // indicador), só faltava virar achado próprio; até aqui só entrava como
    // "componente que mais pesa" dentro de analisarTotalDeducoes.
    () => analisarIndicadorPercentual("taxas_entregadores", indicadores.taxas_entregadores, faturamentoBase),
    () => analisarTotalDeducoes(indicadores.total_deducoes, componentesDeducao, faturamentoBase),
    () => analisarFaturamento(comparativo, recuperacao),
    () => analisarDiasPendentes(diasPendentes, diasPendentesDatas),
    () => analisarDetalhamentoAusente(indicadores),
  ];

  const pontosFortes = [], pontosAtencao = [], alertas = [], acoes = [];
  for (const analisar of ANALISADORES) {
    const resultado = analisar();
    if (!resultado) continue;
    const { achado, acao } = resultado;
    if (achado.severidade === "forte") pontosFortes.push(achado);
    else if (achado.severidade === "atencao") pontosAtencao.push(achado);
    else alertas.push(achado);
    if (acao) acoes.push({ ...acao, prioridade: prioridadeDe(achado) });
  }
  acoes.sort((a, b) => a.prioridade - b.prioridade);

  return {
    pontosFortes, pontosAtencao, alertas, acoes,
    semDadosSuficientes: false,
    confiabilidade: confiabilidadeDados({ diasComDados, diasPendentes, diasEstimados }),
  };
}
