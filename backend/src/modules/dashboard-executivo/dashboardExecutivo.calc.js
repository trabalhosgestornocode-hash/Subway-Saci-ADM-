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

/**
 * Dia anterior a uma data ISO (AAAA-MM-DD) — comparação de CALENDÁRIO, não
 * subtração de milissegundos: `Date.UTC` normaliza sozinho quando o dia
 * vira 0 (cai pro último dia do mês anterior), incluindo virada de ano
 * (janeiro -> dezembro do ano anterior). Usado pela regra "Financeiro só
 * aparece quando a data do lançamento é ontem" (dashboardExecutivo.service.js).
 * @param {string} dataIso
 * @returns {string}
 */
export function diaAnterior(dataIso) {
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia - 1));
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
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
 * Ticket médio = valor bruto ÷ quantidade de vendas. Nunca divide por zero e
 * nunca inventa um lado da conta: se qualquer um dos dois não foi informado
 * (null/undefined — "não sei"), o ticket médio é indisponível, não 0.
 * @param {number|null} valorBruto @param {number|null} qtdVendas @returns {number|null}
 */
export function ticketMedio(valorBruto, qtdVendas) {
  if (valorBruto == null || qtdVendas == null) return null;
  const q = Number(qtdVendas);
  const v = Number(valorBruto);
  if (!Number.isFinite(q) || !Number.isFinite(v) || q <= 0) return null;
  return v / q;
}

/**
 * Percentual de `valor` sobre `base` (0-100). Null quando a base é inválida
 * OU quando `valor` não foi informado (não confundir "0% de verdade" com
 * "não sei quanto foi").
 * @param {number|null} valor @param {number} base @returns {number|null}
 */
export function percentual(valor, base) {
  if (valor == null) return null;
  const b = Number(base);
  if (!Number.isFinite(b) || b <= 0) return null;
  return (Number(valor) / b) * 100;
}

/**
 * Soma as 4 deduções. Se NENHUMA foi informada, o total é indisponível
 * (null) — não um 0 que faria um card de meta parecer "dentro da meta" por
 * falta de dado. Se ALGUMAS foram informadas, soma só as conhecidas (melhor
 * esforço) — é o caso normal de um lançamento diário real, onde as 4 sempre
 * chegam preenchidas juntas.
 * @param {{taxasComissoes: number|null, servicosPromocoes: number|null, taxasEntregadores: number|null, outrasDeducoes: number|null}} p
 * @returns {number|null}
 */
export function totalDeducoes({ taxasComissoes, servicosPromocoes, taxasEntregadores, outrasDeducoes }) {
  const partes = [taxasComissoes, servicosPromocoes, taxasEntregadores, outrasDeducoes];
  if (partes.every((p) => p == null)) return null;
  return partes.reduce((s, p) => s + (p == null ? 0 : Number(p)), 0);
}

/**
 * Receita após deduções. Indisponível se o total de deduções não pôde ser
 * calculado — apresentar `valorVendas` sozinho aqui insinuaria "deduções
 * zero", o que não sabemos.
 * @param {number} valorVendas @param {number|null} totalDed @returns {number|null}
 */
export function receitaAposDeducoes(valorVendas, totalDed) {
  if (totalDed == null) return null;
  return (Number(valorVendas) || 0) - Number(totalDed);
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

// ---------------------------------------------------------------------------
// STATUS FRENTE À META — fonte única (era duplicado: um cálculo aqui, outro
// no frontend). Cards, diagnóstico e a nova visão de "quanto ainda resta"
// usam todos esta mesma função.
// ---------------------------------------------------------------------------

/**
 * @param {number|null} atual @param {{metaIdeal: number, limite: number}|null|undefined} meta
 * @returns {{chave: 'sem_dados'|'dentro_da_meta'|'atencao'|'fora_da_meta', label: string}}
 */
export function statusIndicador(atual, meta) {
  if (atual == null || meta == null || meta.metaIdeal == null || meta.limite == null) {
    return { chave: "sem_dados", label: "Dados insuficientes" };
  }
  if (atual <= meta.metaIdeal) return { chave: "dentro_da_meta", label: "Dentro da meta" };
  if (atual <= meta.limite) return { chave: "atencao", label: "Atenção" };
  return { chave: "fora_da_meta", label: "Fora da meta" };
}

/**
 * Quanto do LIMITE (não da meta ideal) ainda está disponível — em pontos
 * percentuais e, quando dá pra calcular, em reais.
 * limiteEmReais = faturamentoBase × limite%; saldo = limiteEmReais − valorUtilizado.
 * @param {{valorUtilizado: number|null, percentualUtilizado: number|null, limitePct: number|null, faturamentoBase: number|null}} p
 * @returns {{disponivelPp: number|null, disponivelReais: number|null, limiteReais: number|null, status: 'sem_dados'|'disponivel'|'limite_atingido'|'acima_do_limite'}}
 */
export function saldoMeta({ valorUtilizado, percentualUtilizado, limitePct, faturamentoBase }) {
  if (percentualUtilizado == null || limitePct == null) {
    return { disponivelPp: null, disponivelReais: null, limiteReais: null, status: "sem_dados" };
  }
  const disponivelPp = limitePct - percentualUtilizado;
  let limiteReais = null;
  let disponivelReais = null;
  if (faturamentoBase != null && faturamentoBase > 0 && valorUtilizado != null) {
    limiteReais = (faturamentoBase * limitePct) / 100;
    disponivelReais = limiteReais - valorUtilizado;
  }
  const status = disponivelPp > 0 ? "disponivel" : disponivelPp === 0 ? "limite_atingido" : "acima_do_limite";
  return { disponivelPp, disponivelReais, limiteReais, status };
}

// ---------------------------------------------------------------------------
// LANÇAMENTO DE FATURAMENTO MENSAL — distribuição exata em centavos
// ---------------------------------------------------------------------------

/**
 * Distribui um valor mensal (reais) por N dias sem perder nem sobrar um
 * centavo: converte para centavos inteiros, divide, e o resto (sempre < N
 * centavos) vai para os primeiros dias. A soma dos valores retornados é
 * SEMPRE exatamente igual a `valorTotalReais` — nunca aproxima.
 * @param {number} valorTotalReais @param {number} quantidadeDias
 * @returns {number[]} um valor em reais por dia (tamanho = quantidadeDias)
 */
export function distribuirValorMensal(valorTotalReais, quantidadeDias) {
  const dias = Math.trunc(Number(quantidadeDias));
  if (!Number.isFinite(dias) || dias <= 0) return [];
  const totalCentavos = Math.round(Number(valorTotalReais) * 100);
  const baseCentavos = Math.floor(totalCentavos / dias);
  const resto = totalCentavos - baseCentavos * dias;
  return Array.from({ length: dias }, (_, i) => (baseCentavos + (i < resto ? 1 : 0)) / 100);
}

/**
 * Mesma ideia de `distribuirValorMensal`, mas para CONTAGENS inteiras
 * (quantidade de pedidos, novos clientes do mês) — sem centavos, o resto vai
 * pros primeiros dias. A soma é sempre exatamente igual ao total informado.
 * @param {number} quantidadeTotal @param {number} quantidadeDias
 * @returns {number[]}
 */
export function distribuirQuantidadeMensal(quantidadeTotal, quantidadeDias) {
  const dias = Math.trunc(Number(quantidadeDias));
  if (!Number.isFinite(dias) || dias <= 0) return [];
  const total = Math.trunc(Number(quantidadeTotal));
  const base = Math.floor(total / dias);
  const resto = total - base * dias;
  return Array.from({ length: dias }, (_, i) => base + (i < resto ? 1 : 0));
}

// Campos "extra" (opcionais) de um lançamento mensal — os que usam contagem
// inteira (pedidos, novos clientes) em vez de valor em reais. Usado tanto
// aqui quanto no service para decidir qual função de distribuição aplicar.
export const CAMPOS_EXTRAS_MENSAL_INTEIROS = new Set(["qtdVendasTotal", "novosClientesTotal"]);

/**
 * Funde a edição de um lançamento mensal com o que já estava salvo, e
 * recalcula a distribuição diária — regra de atualização do item 2/3 do
 * pedido: só substitui o que veio no `patch`; o que não veio preserva o
 * valor salvo (nunca "some" nem vira zero). Determinístico: reaplicar o
 * mesmo total sobre o mesmo número de dias sempre reproduz as mesmas
 * fatias, então mesmo um campo "sem mudança real" pode passar por aqui sem
 * problema algum.
 *
 * @param {{valorTotalMensal: number, extras: Record<string, number|null>}} atual — valores hoje salvos no lote
 * @param {{valorTotalMensal?: number, extras?: Record<string, number|null>}} patch — só as chaves que o usuário de fato editou (chave ausente = não editado)
 * @param {number} quantidadeDias — nº de dias vinculados a este lote (fixo: a edição nunca muda QUAIS dias pertencem ao lote, só os valores deles)
 * @returns {{valorTotalMensal: number, extras: Record<string, number|null>, fatiasPorCampo: {valorVendasIfood: number[], [extra: string]: (number[]|null)}}}
 */
export function recalcularDistribuicaoMensal({ valorAtual, extrasAtuais, patch, quantidadeDias }) {
  const valorTotalMensal = Object.prototype.hasOwnProperty.call(patch, "valorTotalMensal") && patch.valorTotalMensal != null
    ? Number(patch.valorTotalMensal) : Number(valorAtual);

  const patchExtras = patch.extras ?? {};
  const extras = {};
  for (const campo of Object.keys(extrasAtuais)) {
    extras[campo] = Object.prototype.hasOwnProperty.call(patchExtras, campo) ? patchExtras[campo] : extrasAtuais[campo];
  }

  const fatiasPorCampo = { valorVendasIfood: distribuirValorMensal(valorTotalMensal, quantidadeDias) };
  for (const [campo, valor] of Object.entries(extras)) {
    if (valor == null) { fatiasPorCampo[campo] = null; continue; }
    fatiasPorCampo[campo] = CAMPOS_EXTRAS_MENSAL_INTEIROS.has(campo)
      ? distribuirQuantidadeMensal(valor, quantidadeDias)
      : distribuirValorMensal(valor, quantidadeDias);
  }

  return { valorTotalMensal, extras, fatiasPorCampo };
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
// MODELO LOGÍSTICO DO IFOOD (Marketplace x Full Service)
// ---------------------------------------------------------------------------

export const MODELOS_LOGISTICOS = ["marketplace", "full_service"];

export const ROTULO_MODELO = {
  marketplace: "Marketplace",
  full_service: "Full Service",
};

/**
 * Quais indicadores de rentabilidade existem em cada modelo. É esta lista —
 * não a presença ou ausência de uma linha em `metas_indicadores` — que
 * decide se um indicador é "não aplicável": no Full Service quem entrega é
 * o parceiro do iFood, então não existe meta de "motoboy próprio"
 * (taxas_entregadores). Fonte única dessa regra de negócio.
 * @type {Record<string, string[]>}
 */
export const INDICADORES_POR_MODELO = {
  marketplace: ["taxas_comissoes", "servicos_promocoes", "taxas_entregadores", "total_deducoes"],
  full_service: ["taxas_comissoes", "servicos_promocoes", "total_deducoes"],
};

/**
 * @param {string} modelo @param {string} indicador @returns {boolean}
 */
export function indicadorAplicavel(modelo, indicador) {
  return (INDICADORES_POR_MODELO[modelo] ?? INDICADORES_POR_MODELO.full_service).includes(indicador);
}

// Diagnóstico executivo e Plano de Ação viraram um motor à parte —
// dashboardExecutivo.diagnostico.js — que usa statusIndicador/saldoMeta
// daqui como base, mas gera pontos fortes/atenção/alertas/ações
// quantitativos, ligados 1:1 por id (ver DIAGNOSTICO_ARQUITETURA lá).
