// Camada de cálculo do Dashboard Executivo — FONTE ÚNICA das fórmulas de
// negócio (ticket médio, percentuais, deduções, projeção, status do dia,
// diagnóstico). Puro, sem I/O, testável isoladamente — mesmo espírito de
// insumos.calc.js: o backend valida e persiste por cima disto; o frontend só
// mostra prévias, sempre recomputadas no servidor.

/** Data de hoje no fuso do negócio (America/Sao_Paulo), em ISO AAAA-MM-DD. */
export function hojeIsoBrasil(agora = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(agora);
}

/**
 * Lista de datas ISO (AAAA-MM-DD) de um mês inteiro.
 * @param {number} ano @param {number} mes 1-indexado (1 = janeiro)
 * @returns {string[]}
 */
export function diasDoMes(ano, mes) {
  const totalDias = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, "0");
  return Array.from({ length: totalDias }, (_, i) => `${ano}-${pad(mes)}-${pad(i + 1)}`);
}

/** Mês anterior a {ano, mes} (1-indexado), com o rollover de janeiro -> dezembro do ano anterior. */
export function mesAnterior(ano, mes) {
  return mes === 1 ? { ano: ano - 1, mes: 12 } : { ano, mes: mes - 1 };
}

/** Status possíveis de um dia no calendário do mês. */
export const STATUS_DIA = {
  PREENCHIDO: "PREENCHIDO",
  PENDENTE: "PENDENTE",
  BLOQUEADO: "BLOQUEADO",
  RASCUNHO: "RASCUNHO",
  SEM_OPERACAO: "SEM_OPERACAO",
  ZERO_VENDAS: "ZERO_VENDAS",
  FUTURO: "FUTURO",
};

/** Status que "resolvem" o dia (contam para a sequência e para o % de conclusão). */
const RESOLVIDOS = new Set([STATUS_DIA.PREENCHIDO, STATUS_DIA.SEM_OPERACAO, STATUS_DIA.ZERO_VENDAS]);

// ---------------------------------------------------------------------------
// FÓRMULAS FINANCEIRAS
// ---------------------------------------------------------------------------

/**
 * Ticket médio = valor bruto ÷ quantidade de vendas. Nunca divide por zero.
 * @param {number} valorBruto @param {number} qtdVendas @returns {number|null}
 */
export function ticketMedio(valorBruto, qtdVendas) {
  const q = Number(qtdVendas) || 0;
  if (q <= 0) return null;
  return (Number(valorBruto) || 0) / q;
}

/**
 * Percentual de `valor` sobre `base` (0-100). Null quando a base é inválida.
 * @param {number} valor @param {number} base @returns {number|null}
 */
export function percentual(valor, base) {
  const b = Number(base);
  if (!Number.isFinite(b) || b <= 0) return null;
  return (Number(valor || 0) / b) * 100;
}

/**
 * @param {{taxasComissoes: number, servicosPromocoes: number, taxasEntregadores: number, outrasDeducoes: number}} p
 * @returns {number}
 */
export function totalDeducoes({ taxasComissoes, servicosPromocoes, taxasEntregadores, outrasDeducoes }) {
  return Number(taxasComissoes || 0) + Number(servicosPromocoes || 0) + Number(taxasEntregadores || 0) + Number(outrasDeducoes || 0);
}

/** @param {number} valorVendas @param {number} totalDed @returns {number} */
export function receitaAposDeducoes(valorVendas, totalDed) {
  return (Number(valorVendas) || 0) - (Number(totalDed) || 0);
}

/** @param {number|null} percentualTotalDeducoes @returns {number|null} */
export function saldoPercentual(percentualTotalDeducoes) {
  if (percentualTotalDeducoes == null) return null;
  return 100 - percentualTotalDeducoes;
}

/**
 * Média diária a partir de uma lista de valores diários VÁLIDOS (dias
 * pendentes/futuros nunca entram aqui — filtrar antes de chamar).
 * @param {Array<number|null|undefined>} valores @returns {number|null}
 */
export function mediaDiaria(valores) {
  const validos = (valores ?? []).filter((v) => v != null && Number.isFinite(Number(v)));
  if (!validos.length) return null;
  return validos.reduce((s, v) => s + Number(v), 0) / validos.length;
}

/** @param {number|null} media @param {number} diasPrevistos @returns {number|null} */
export function projecaoMensal(media, diasPrevistos) {
  if (media == null) return null;
  return media * (Number(diasPrevistos) || 0);
}

/**
 * Nível de confiabilidade da projeção — regras determinísticas (sem IA).
 * @param {{diasVencidos: number, diasResolvidos: number, diasComDados: number}} p
 * @returns {{nivel: 'alta'|'media'|'baixa'|'indisponivel', justificativa: string}}
 */
export function confiabilidadeProjecao({ diasVencidos, diasResolvidos, diasComDados }) {
  const vencidos = Number(diasVencidos) || 0;
  const resolvidos = Number(diasResolvidos) || 0;
  const comDados = Number(diasComDados) || 0;
  const pendentes = Math.max(vencidos - resolvidos, 0);
  const LIMIAR_RAZOAVEL = 5;

  if (comDados === 0) {
    return { nivel: "indisponivel", justificativa: "Ainda não há lançamentos neste mês para calcular uma projeção." };
  }
  if (pendentes > 0) {
    return { nivel: "baixa", justificativa: `Existem ${pendentes} dia(s) pendente(s) neste mês — regularize os lançamentos para uma projeção mais confiável.` };
  }
  if (comDados >= LIMIAR_RAZOAVEL) {
    return { nivel: "alta", justificativa: `Todos os ${vencidos} dia(s) já vencido(s) neste mês estão resolvidos, com ${comDados} dia(s) de dados.` };
  }
  return { nivel: "media", justificativa: `Sem pendências, mas ainda há poucos dias preenchidos (${comDados}) para uma projeção de alta confiança.` };
}

// ---------------------------------------------------------------------------
// CALENDÁRIO / SEQUÊNCIA
// ---------------------------------------------------------------------------

/**
 * Status "de dados" de um dia, a partir do lançamento (se existir).
 * Devolve null quando NÃO há lançamento — o chamador (statusMes) decide entre
 * PENDENTE/BLOQUEADO/FUTURO a partir do contexto.
 * @param {{lancamento: {status: string, situacao: string}|null}} p
 * @returns {string|null}
 */
export function statusDiaBase({ lancamento }) {
  if (!lancamento) return null;
  if (lancamento.status === "rascunho") return STATUS_DIA.RASCUNHO;
  if (lancamento.situacao === "sem_operacao") return STATUS_DIA.SEM_OPERACAO;
  if (lancamento.situacao === "zero_vendas") return STATUS_DIA.ZERO_VENDAS;
  return STATUS_DIA.PREENCHIDO;
}

/**
 * Deriva o status de cada dia de um mês. A sequência é calculada SEMPRE
 * dentro do mês recebido: o dia 1 nunca é bloqueado por pendência de um mês
 * anterior (isso vira um alerta à parte — ver `agruparPendenciasPorMes`).
 * @param {{dias: Array<{data: string, lancamento: object|null}>, hojeIso: string}} p
 * @returns {Array<{data: string, status: string, lancamento: object|null}>}
 */
export function statusMes({ dias, hojeIso }) {
  const resultado = [];
  let anteriorResolvido = true; // dia 1 do mês nunca começa bloqueado
  for (const dia of dias ?? []) {
    let status;
    if (dia.data > hojeIso) {
      status = STATUS_DIA.FUTURO;
    } else {
      const base = statusDiaBase({ lancamento: dia.lancamento });
      if (base) status = base;
      else if (!anteriorResolvido) status = STATUS_DIA.BLOQUEADO;
      else status = STATUS_DIA.PENDENTE;
    }
    resultado.push({ data: dia.data, status, lancamento: dia.lancamento ?? null });
    anteriorResolvido = RESOLVIDOS.has(status);
  }
  return resultado;
}

/**
 * Resumo do preenchimento do mês (para o card "resumo" + barra de progresso).
 * @param {Array<{data: string, status: string, lancamento: object|null}>} diasComStatus
 */
export function resumoPreenchimento(diasComStatus) {
  const lista = diasComStatus ?? [];
  const total = lista.length;
  const diasPreenchidos = lista.filter((d) => RESOLVIDOS.has(d.status)).length;
  const diasRascunho = lista.filter((d) => d.status === STATUS_DIA.RASCUNHO).length;
  const diasPendentes = lista.filter((d) => d.status === STATUS_DIA.PENDENTE || d.status === STATUS_DIA.BLOQUEADO).length;
  const diasSemOperacao = lista.filter((d) => d.status === STATUS_DIA.SEM_OPERACAO).length;
  const diasZeroVendas = lista.filter((d) => d.status === STATUS_DIA.ZERO_VENDAS).length;
  const primeiroDiaPendente = lista.find((d) => d.status === STATUS_DIA.PENDENTE)?.data ?? null;
  const ultimoLancamento = [...lista].reverse().find((d) => d.lancamento)?.data ?? null;

  return {
    totalDias: total,
    diasPreenchidos,
    diasPendentes,
    diasRascunho,
    diasSemOperacao,
    diasZeroVendas,
    percentualConclusao: total > 0 ? (diasPreenchidos / total) * 100 : 0,
    primeiroDiaPendente,
    ultimoLancamento,
  };
}

/**
 * Verifica se uma data específica está disponível para lançar (POST) — a
 * trava sequencial. Não distingue rascunho/finalizado: quem chama decide o
 * que fazer com PREENCHIDO/RASCUNHO (editar) vs PENDENTE (criar).
 * @param {Array<{data: string, status: string}>} diasComStatus
 * @param {string} dataAlvo
 * @returns {{disponivel: boolean, motivo: string|null, status: string|null}}
 */
export function verificarDisponibilidade(diasComStatus, dataAlvo) {
  const alvo = (diasComStatus ?? []).find((d) => d.data === dataAlvo);
  if (!alvo) return { disponivel: false, motivo: "Data fora do mês consultado.", status: null };
  if (alvo.status === STATUS_DIA.FUTURO) return { disponivel: false, motivo: "Não é possível lançar uma data futura.", status: alvo.status };
  if (alvo.status === STATUS_DIA.BLOQUEADO) {
    return { disponivel: false, motivo: "Existe um dia anterior deste mês ainda pendente. Resolva-o primeiro.", status: alvo.status };
  }
  return { disponivel: true, motivo: null, status: alvo.status };
}

/**
 * Agrupa datas pendentes por mês/ano — alimenta o alerta de "pendências de
 * meses anteriores" (não bloqueia o mês atual, só avisa).
 * @param {string[]} datasPendentesIso
 * @returns {Array<{ano: number, mes: number, dias: string[]}>}
 */
export function agruparPendenciasPorMes(datasPendentesIso) {
  const grupos = new Map();
  for (const dataIso of datasPendentesIso ?? []) {
    const [ano, mes] = dataIso.split("-");
    const chave = `${ano}-${mes}`;
    if (!grupos.has(chave)) grupos.set(chave, { ano: Number(ano), mes: Number(mes), dias: [] });
    grupos.get(chave).dias.push(dataIso);
  }
  return [...grupos.values()].sort((a, b) => a.ano - b.ano || a.mes - b.mes);
}

// ---------------------------------------------------------------------------
// VALIDAÇÕES PURAS (usadas pelo service; devolvem mensagem pt-BR ou null)
// ---------------------------------------------------------------------------

/**
 * "Outras deduções": positivo é livre; negativo (ajuste a favor da unidade)
 * exige permissão de correção + justificativa preenchida.
 * @param {{valor: unknown, justificativa: unknown, podeAjustarNegativo: boolean}} p
 * @returns {string|null}
 */
export function validarOutrasDeducoes({ valor, justificativa, podeAjustarNegativo }) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return "Outras deduções deve ser um número.";
  if (n < 0) {
    if (!podeAjustarNegativo) return "Você não tem permissão para lançar um ajuste negativo em outras deduções.";
    if (!justificativa || !String(justificativa).trim()) return "Informe a justificativa do ajuste negativo em outras deduções.";
  }
  return null;
}

/**
 * Avisos (não bloqueiam por si só) de inconsistência entre desempenho e
 * financeiro — devem ser exibidos na etapa de conferência do formulário.
 * @param {{qtdVendas: number, valorVendasBruto: number, valorVendasIfood: number, totalDed: number}} p
 * @returns {string[]}
 */
export function inconsistencias({ qtdVendas, valorVendasBruto, valorVendasIfood, totalDed }) {
  const avisos = [];
  const q = Number(qtdVendas) || 0;
  const v = Number(valorVendasBruto) || 0;
  if (v > 0 && q === 0) avisos.push("Há valor de vendas informado, mas a quantidade de vendas está zerada.");
  if (q > 0 && v === 0) avisos.push("Há quantidade de vendas informada, mas o valor bruto está zerado.");
  if (Number(totalDed) > (Number(valorVendasIfood) || 0)) avisos.push("O total de deduções ultrapassa o valor das vendas do iFood.");
  return avisos;
}

// ---------------------------------------------------------------------------
// DIAGNÓSTICO E RECOMENDAÇÕES
// ---------------------------------------------------------------------------

const ROTULO_INDICADOR = {
  taxas_comissoes: "Taxas e comissões",
  servicos_promocoes: "Serviços e promoções",
  taxas_entregadores: "Taxas de entregadores",
  total_deducoes: "Total de deduções",
};

const fmtPct1 = (v) => `${Number(v).toFixed(1)}%`;

/**
 * Diagnóstico executivo — nunca apresenta ponto forte sem dados suficientes.
 * @param {{indicadores: Record<string, number|null>|null, metas: Record<string, {metaIdeal: number, limite: number}>, diasPendentesNoMes: number, comparativoMesAnteriorPct: number|null}} p
 */
export function diagnostico({ indicadores, metas, diasPendentesNoMes, comparativoMesAnteriorPct }) {
  const pontosFortes = [];
  const pontosAtencao = [];
  const alertas = [];
  const indicadoresForaDaMeta = [];

  if (!indicadores) {
    return { pontosFortes, pontosAtencao, alertas, indicadoresForaDaMeta, semDadosSuficientes: true };
  }

  for (const chave of Object.keys(ROTULO_INDICADOR)) {
    const valor = indicadores[chave];
    const meta = metas?.[chave];
    if (valor == null || !meta) continue;
    const rotulo = ROTULO_INDICADOR[chave];
    if (valor <= meta.metaIdeal) {
      pontosFortes.push(`${rotulo} dentro da meta ideal (${fmtPct1(valor)} ≤ ${fmtPct1(meta.metaIdeal)}).`);
    } else if (valor <= meta.limite) {
      pontosAtencao.push(`${rotulo} acima da meta ideal, mas ainda dentro do limite (${fmtPct1(valor)}).`);
      indicadoresForaDaMeta.push(chave);
    } else {
      const critico = chave === "total_deducoes";
      alertas.push(`${critico ? "[Crítico] " : ""}${rotulo} ultrapassou o limite (${fmtPct1(valor)} > ${fmtPct1(meta.limite)}).`);
      indicadoresForaDaMeta.push(chave);
    }
  }

  const pendentes = Number(diasPendentesNoMes) || 0;
  if (pendentes > 0) {
    alertas.push(`${pendentes} dia(s) pendente(s) neste mês — os dados ainda estão incompletos.`);
  }

  if (comparativoMesAnteriorPct != null) {
    if (comparativoMesAnteriorPct > 0) {
      pontosFortes.push(`Faturamento cresceu ${fmtPct1(comparativoMesAnteriorPct)} em relação ao mês anterior.`);
    } else if (comparativoMesAnteriorPct < -5) {
      pontosAtencao.push(`Faturamento caiu ${fmtPct1(Math.abs(comparativoMesAnteriorPct))} em relação ao mês anterior.`);
    }
  }

  return { pontosFortes, pontosAtencao, alertas, indicadoresForaDaMeta, semDadosSuficientes: false };
}

const RECOMENDACAO_POR_INDICADOR = {
  taxas_comissoes: "Acompanhar de perto as taxas e comissões do iFood — estão pressionando a margem.",
  servicos_promocoes: "Revisar as campanhas e promoções ativas, priorizando as com melhor retorno sobre o investimento.",
  taxas_entregadores: "Revisar o custo das taxas de entregadores da loja.",
  total_deducoes: "Priorizar ações que reduzam custos e aumentem a rentabilidade — o total de deduções está fora da meta.",
};

/**
 * Ações recomendadas — sempre amarradas a um indicador ou pendência real,
 * nunca genéricas.
 * @param {{indicadoresForaDaMeta: string[], diasPendentesNoMes: number, semDadosSuficientes: boolean}} p
 * @returns {string[]}
 */
export function recomendacoes({ indicadoresForaDaMeta, diasPendentesNoMes, semDadosSuficientes }) {
  if (semDadosSuficientes) {
    return ["Ainda não há lançamentos suficientes neste mês para gerar recomendações confiáveis."];
  }
  const lista = [];
  for (const chave of indicadoresForaDaMeta ?? []) {
    if (RECOMENDACAO_POR_INDICADOR[chave]) lista.push(RECOMENDACAO_POR_INDICADOR[chave]);
  }
  if ((Number(diasPendentesNoMes) || 0) > 0) {
    lista.push("Regularizar os dias pendentes para manter os indicadores confiáveis.");
  }
  if (!lista.length) {
    lista.push("Manter o desempenho atual — todos os indicadores estão dentro da meta.");
  }
  return lista;
}
