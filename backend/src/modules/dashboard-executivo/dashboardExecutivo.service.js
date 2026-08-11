import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { PERMISSOES, temPermissao } from "../../shared/permissoes.js";
import { resolverMetas, obterModeloLogistico, definirModeloLogistico, historicoModeloLogistico } from "./dashboardExecutivo.metas.service.js";
import {
  hojeIsoBrasil, diasDoMes, mesAnterior, statusMes, resumoPreenchimento,
  verificarDisponibilidade, agruparPendenciasPorMes, ticketMedio, percentual,
  totalDeducoes, receitaAposDeducoes, saldoPercentual, mediaDiaria, projecaoMensal,
  confiabilidadeProjecao, validarOutrasDeducoes,
  inconsistencias, STATUS_DIA, indicadorAplicavel, statusIndicador, saldoMeta,
  distribuirValorMensal, distribuirQuantidadeMensal,
} from "./dashboardExecutivo.calc.js";
import { gerarDiagnostico, LIMIARES_DIAGNOSTICO } from "./dashboardExecutivo.diagnostico.js";

const TABELA = "lancamentos_financeiros_diarios";
const TABELA_AUDITORIA = "lancamentos_financeiros_auditoria";
const RESOLVIDOS_COM_DADOS = new Set([STATUS_DIA.PREENCHIDO, STATUS_DIA.ZERO_VENDAS]);

// ---------------------------------------------------------------------------
// UNIDADE-ALVO — resolve e valida a unidade da ação a partir da sessão.
// Nunca confia no que o cliente manda: quando a sessão já está presa a uma
// unidade, qualquer unidadeId diferente no corpo/query é recusado.
// ---------------------------------------------------------------------------
export async function resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica = false }) {
  if (unidadeIdSessao) {
    if (unidadeIdSolicitado && unidadeIdSolicitado !== unidadeIdSessao) {
      throw ApiError.forbidden("Você não tem acesso a esta unidade.");
    }
    return unidadeIdSessao;
  }
  if (!unidadeIdSolicitado) {
    if (exigirEspecifica) throw ApiError.badRequest("Selecione uma unidade específica para esta ação. A visão \"Todas as unidades\" é somente leitura.");
    return null; // "todas as unidades" — agregado, só leitura
  }
  const { data: unidade, error } = await supabase
    .from("unidades").select("id, organizacao_id").eq("id", unidadeIdSolicitado).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!unidade || unidade.organizacao_id !== organizacaoId) throw ApiError.forbidden("Você não tem acesso a esta unidade.");
  return unidade.id;
}

// ---------------------------------------------------------------------------
// PROJEÇÃO DE UM LANÇAMENTO PARA A API (campos + calculados)
// ---------------------------------------------------------------------------
function calculadosDoLancamento(row) {
  const totalDed = totalDeducoes({
    taxasComissoes: row.taxas_comissoes, servicosPromocoes: row.servicos_promocoes,
    taxasEntregadores: row.taxas_entregadores, outrasDeducoes: row.outras_deducoes,
  });
  const base = row.valor_vendas_ifood;
  const pctTotal = percentual(totalDed, base);
  return {
    ticketMedio: ticketMedio(row.valor_vendas_bruto, row.qtd_vendas),
    totalDeducoes: totalDed,
    receitaAposDeducoes: receitaAposDeducoes(base, totalDed),
    percentuais: {
      taxasComissoes: percentual(row.taxas_comissoes, base),
      servicosPromocoes: percentual(row.servicos_promocoes, base),
      taxasEntregadores: percentual(row.taxas_entregadores, base),
      outrasDeducoes: percentual(row.outras_deducoes, base),
      totalDeducoes: pctTotal,
    },
    saldoPercentual: saldoPercentual(pctTotal),
  };
}

/** Number(x), mas preserva null/undefined em vez de virar 0 — "não informado" ≠ "zero". */
const numOuNulo = (v) => (v == null ? null : Number(v));

function paraApi(row) {
  return {
    id: row.id,
    unidadeId: row.unidade_id,
    data: row.data_lancamento,
    situacao: row.situacao,
    motivoSemOperacao: row.motivo_sem_operacao ?? null,
    observacao: row.observacao ?? null,
    origemLancamento: row.origem_lancamento ?? "diario",
    qtdVendas: row.qtd_vendas ?? null,
    valorVendasBruto: numOuNulo(row.valor_vendas_bruto),
    novosClientes: row.novos_clientes ?? null,
    valorVendasIfood: numOuNulo(row.valor_vendas_ifood),
    taxasComissoes: numOuNulo(row.taxas_comissoes),
    servicosPromocoes: numOuNulo(row.servicos_promocoes),
    taxasEntregadores: numOuNulo(row.taxas_entregadores),
    outrasDeducoes: numOuNulo(row.outras_deducoes),
    justificativaAjuste: row.justificativa_ajuste ?? null,
    status: row.status,
    usuarioNome: row.usuario_nome ?? null,
    finalizadoEm: row.finalizado_em ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    calculado: calculadosDoLancamento(row),
  };
}

// ---------------------------------------------------------------------------
// UNIDADES VISÍVEIS
// ---------------------------------------------------------------------------
export async function listarUnidades({ organizacaoId, unidadeIdSessao }) {
  if (unidadeIdSessao) {
    const { data, error } = await supabase.from("unidades").select("id, nome, eh_teste").eq("id", unidadeIdSessao).maybeSingle();
    if (error) throw ApiError.internal(error.message);
    if (!data) throw ApiError.notFound("Unidade não encontrada.");
    return { unidades: [{ id: data.id, nome: data.nome, ehTeste: data.eh_teste }], agregadoDisponivel: false };
  }
  const { data, error } = await supabase
    .from("unidades").select("id, nome, eh_teste").eq("organizacao_id", organizacaoId).eq("ativo", true).order("nome");
  if (error) throw ApiError.internal(error.message);
  return { unidades: (data ?? []).map((u) => ({ id: u.id, nome: u.nome, ehTeste: u.eh_teste })), agregadoDisponivel: true };
}

// ---------------------------------------------------------------------------
// MODELO LOGÍSTICO DO IFOOD DE UMA UNIDADE (Marketplace x Full Service)
// Sempre exige uma unidade específica — "todas as unidades" não é um
// conceito válido pra este recurso (cada unidade tem o seu próprio modelo).
// ---------------------------------------------------------------------------
export async function obterModeloLogisticoUnidade({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado }) {
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: true });
  return obterModeloLogistico({ unidadeId, organizacaoId });
}

export async function atualizarModeloLogisticoUnidade({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, usuario, dados: body }) {
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: true });
  const b = v.corpo(body);
  return definirModeloLogistico({
    unidadeId, organizacaoId, modeloNovo: b.modeloLogistico, usuario, motivo: b.motivo, observacao: b.observacao,
  });
}

export async function historicoModeloLogisticoUnidade({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado }) {
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: true });
  return historicoModeloLogistico({ unidadeId, organizacaoId });
}

// ---------------------------------------------------------------------------
// CALENDÁRIO DE UM MÊS (para uma unidade específica)
// ---------------------------------------------------------------------------
async function carregarCalendarioMes({ unidadeId, ano, mes, hojeIso }) {
  const dias = diasDoMes(ano, mes);
  const inicio = dias[0];
  const fim = dias[dias.length - 1];

  const { data, error } = await supabase
    .from(TABELA).select("*").eq("unidade_id", unidadeId)
    .gte("data_lancamento", inicio).lte("data_lancamento", fim);
  if (error) throw ApiError.internal(error.message);

  const porData = new Map((data ?? []).map((r) => [r.data_lancamento, r]));
  const diasComLancamento = dias.map((data_) => ({ data: data_, lancamento: porData.get(data_) ?? null }));
  const diasComStatus = statusMes({ dias: diasComLancamento, hojeIso });
  return { diasComStatus, linhas: data ?? [] };
}

// ---------------------------------------------------------------------------
// PENDÊNCIAS DO MÊS ANTERIOR (alerta à parte — não bloqueia o mês atual)
// ---------------------------------------------------------------------------
async function calcularPendenciasMesAnterior({ unidadeId, ano, mes, hojeIso }) {
  const anterior = mesAnterior(ano, mes);
  const { diasComStatus } = await carregarCalendarioMes({ unidadeId, ano: anterior.ano, mes: anterior.mes, hojeIso });
  const pendentes = diasComStatus.filter((d) => d.status === STATUS_DIA.PENDENTE).map((d) => d.data);
  return agruparPendenciasPorMes(pendentes);
}

// ---------------------------------------------------------------------------
// COMPARATIVO DE FATURAMENTO + PLANO DE RECUPERAÇÃO
//
// Mês em andamento: NUNCA compara o total parcial do mês atual com o total
// fechado do mês anterior (isso super/sub-estima a variação). Compara o
// MESMO recorte de dias (1..hoje) dos dois meses — "Estratégia A" do pedido.
// Mês já fechado: compara os dois totais completos, como sempre foi.
//
// Quando há queda real E o mês ainda está em andamento, monta o plano de
// recuperação: quanto falta para alcançar o faturamento do mês anterior
// (referência), quantos dias operacionais restam, e a média diária
// necessária — com cenários quando a meta integral for pouco provável.
// ---------------------------------------------------------------------------
async function calcularComparativoEPlanoRecuperacao({ unidadeId, ano, mes, hojeIso, diasComStatus, base, media }) {
  const anterior = mesAnterior(ano, mes);
  const { diasComStatus: diasAnterior } = await carregarCalendarioMes({ unidadeId, ano: anterior.ano, mes: anterior.mes, hojeIso });
  const totalAnteriorCompleto = diasAnterior.reduce((s, d) => s + Number(d.lancamento?.valor_vendas_ifood || 0), 0);

  const [anoAtualNum, mesAtualNum] = hojeIso.split("-").map(Number);
  const mesEmAndamento = ano === anoAtualNum && mes === mesAtualNum;

  const somarAteODia = (dias, ateODia) => {
    let soma = 0, temDado = false, temEstimativa = false;
    for (const d of dias) {
      if (Number(d.data.slice(8, 10)) > ateODia) continue;
      if (!RESOLVIDOS_COM_DADOS.has(d.status)) continue;
      temDado = true;
      soma += Number(d.lancamento?.valor_vendas_ifood || 0);
      if (d.lancamento?.origem_lancamento === "distribuicao_mensal") temEstimativa = true;
    }
    return { soma, temDado, temEstimativa };
  };

  let comparativo;
  if (mesEmAndamento) {
    const diaAtual = Number(hojeIso.slice(8, 10));
    const atualParcial = somarAteODia(diasComStatus, diaAtual);
    const anteriorParcial = somarAteODia(diasAnterior, diaAtual);
    comparativo = (atualParcial.temDado && anteriorParcial.temDado && anteriorParcial.soma > 0)
      ? {
          tipo: "mesmo_periodo", diaComparado: diaAtual,
          atual: atualParcial.soma, anterior: anteriorParcial.soma,
          diferenca: atualParcial.soma - anteriorParcial.soma,
          pct: ((atualParcial.soma - anteriorParcial.soma) / anteriorParcial.soma) * 100,
          temEstimativa: atualParcial.temEstimativa || anteriorParcial.temEstimativa,
        }
      : { tipo: "indisponivel", pct: null, atual: atualParcial.soma || null, anterior: null, diferenca: null, diaComparado: diaAtual, temEstimativa: false };
  } else {
    comparativo = totalAnteriorCompleto > 0
      ? {
          tipo: "mes_fechado", diaComparado: null,
          atual: base, anterior: totalAnteriorCompleto, diferenca: base - totalAnteriorCompleto,
          pct: ((base - totalAnteriorCompleto) / totalAnteriorCompleto) * 100,
          temEstimativa: diasAnterior.some((d) => d.lancamento?.origem_lancamento === "distribuicao_mensal"),
        }
      : { tipo: "indisponivel", pct: null, atual: base || null, anterior: null, diferenca: null, diaComparado: null, temEstimativa: false };
  }

  let recuperacao = null;
  if (mesEmAndamento && totalAnteriorCompleto > 0 && base < totalAnteriorCompleto) {
    const faltante = totalAnteriorCompleto - base;
    const diasRestantes = diasComStatus.filter((d) => d.status === STATUS_DIA.FUTURO).length;
    if (diasRestantes > 0) {
      const mediaNecessaria = faltante / diasRestantes;
      const mediaBase = media ?? 0;
      const poucoProvavel = media != null && media > 0 && mediaNecessaria > media * LIMIARES_DIAGNOSTICO.recuperacaoMultiplicadorPoucoProvavel;
      recuperacao = {
        referencia: totalAnteriorCompleto, atual: base, faltante, diasRestantes,
        mediaAtual: media, mediaNecessaria, poucoProvavel,
        cenarios: {
          conservador: mediaBase,
          parcial: mediaBase * (1 + LIMIARES_DIAGNOSTICO.cenarioParcialPct / 100),
          forte: mediaBase * (1 + LIMIARES_DIAGNOSTICO.cenarioForcaPct / 100),
        },
      };
    } else {
      recuperacao = { referencia: totalAnteriorCompleto, atual: base, faltante, diasRestantes: 0, mediaAtual: media, mediaNecessaria: null, poucoProvavel: true, cenarios: null };
    }
  }

  return { comparativo, recuperacao };
}

// ---------------------------------------------------------------------------
// GET /dashboard-executivo/mes — payload agregado da página inteira
// ---------------------------------------------------------------------------
export async function obterMes({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, mes: mesRaw, ano: anoRaw }) {
  const mes = v.numero(mesRaw, "Mês", { min: 1, max: 12 });
  const ano = v.numero(anoRaw, "Ano", { min: 2000, max: 2100 });
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: false });
  const hojeIso = hojeIsoBrasil();

  if (unidadeId) {
    // O modelo logístico é DA UNIDADE — resolve antes das metas, porque cada
    // modelo tem um conjunto de metas diferente (ver dashboardExecutivo.calc.js).
    const modelo = await obterModeloLogistico({ unidadeId, organizacaoId });
    const metas = await resolverMetas({ organizacaoId, unidadeId, modeloLogistico: modelo.modeloLogistico });
    return obterMesDeUmaUnidade({ organizacaoId, unidadeId, mes, ano, hojeIso, metas, modelo });
  }

  // Visão agregada ("todas as unidades"): unidades diferentes podem estar em
  // modelos logísticos diferentes, então não existe UMA meta correta pra
  // mostrar aqui — mostrar a meta de um modelo só pra unidades no outro seria
  // um dado errado. Cards e valores continuam somados normalmente; só o
  // comparativo com meta fica indisponível nesta visão (honesto > inventado).
  return obterMesAgregado({ organizacaoId, mes, ano, hojeIso, metas: {} });
}

async function obterMesDeUmaUnidade({ organizacaoId, unidadeId, mes, ano, hojeIso, metas, modelo }) {
  const { diasComStatus, linhas } = await carregarCalendarioMes({ unidadeId, ano, mes, hojeIso });
  const resumo = resumoPreenchimento(diasComStatus);

  // "Dias com dados" = dias com valor financeiro real (PREENCHIDO ou ZERO_VENDAS).
  // SEM_OPERACAO não entra na média (loja fechada não é "um dia de vendas").
  const linhasComDados = linhas.filter((r) => {
    const status = diasComStatus.find((d) => d.data === r.data_lancamento)?.status;
    return RESOLVIDOS_COM_DADOS.has(status);
  });

  // FONTE DE VERDADE FINANCEIRA = etapa Financeiro. `valor_vendas_ifood` é o
  // faturamento; taxas/serviços/entregadores/outras são o detalhamento. A
  // etapa Desempenho (valor_vendas_bruto, qtd_vendas, novos_clientes) é
  // operacional/complementar e NUNCA alimenta faturamento, projeção,
  // comparativo ou os cards de meta — só o próprio ticket médio, que é
  // conceitualmente dela (ver dashboardExecutivo.calc.js).
  //
  // As 4 deduções usam soma NULA-CIENTE: se nenhum dia do mês tem aquele
  // campo informado (ex.: mês só com lançamento mensal, sem detalhamento),
  // o total fica `null` — nunca `0`, que faria o card parecer "dentro da
  // meta" por falta de dado (ver totalDeducoes/percentual em calc.js).
  const somaSimples = (campo) => linhasComDados.reduce((s, r) => s + Number(r[campo] || 0), 0);
  const somaNulavel = (campo) => {
    const valores = linhasComDados.map((r) => r[campo]).filter((v) => v != null);
    return valores.length ? valores.reduce((s, v) => s + Number(v), 0) : null;
  };
  const cardValores = {
    valorVendasIfood: somaSimples("valor_vendas_ifood"),
    taxasComissoes: somaNulavel("taxas_comissoes"),
    servicosPromocoes: somaNulavel("servicos_promocoes"),
    taxasEntregadores: somaNulavel("taxas_entregadores"),
    outrasDeducoes: somaNulavel("outras_deducoes"),
  };
  const totalDed = totalDeducoes({
    taxasComissoes: cardValores.taxasComissoes, servicosPromocoes: cardValores.servicosPromocoes,
    taxasEntregadores: cardValores.taxasEntregadores, outrasDeducoes: cardValores.outrasDeducoes,
  });
  const base = cardValores.valorVendasIfood;
  const indicadoresRentabilidade = {
    taxas_comissoes: percentual(cardValores.taxasComissoes, base),
    servicos_promocoes: percentual(cardValores.servicosPromocoes, base),
    taxas_entregadores: percentual(cardValores.taxasEntregadores, base),
    total_deducoes: percentual(totalDed, base),
  };
  const saldos = {
    taxas_comissoes: saldoMeta({ valorUtilizado: cardValores.taxasComissoes, percentualUtilizado: indicadoresRentabilidade.taxas_comissoes, limitePct: metas.taxas_comissoes?.limite ?? null, faturamentoBase: base }),
    servicos_promocoes: saldoMeta({ valorUtilizado: cardValores.servicosPromocoes, percentualUtilizado: indicadoresRentabilidade.servicos_promocoes, limitePct: metas.servicos_promocoes?.limite ?? null, faturamentoBase: base }),
    taxas_entregadores: saldoMeta({ valorUtilizado: cardValores.taxasEntregadores, percentualUtilizado: indicadoresRentabilidade.taxas_entregadores, limitePct: metas.taxas_entregadores?.limite ?? null, faturamentoBase: base }),
    total_deducoes: saldoMeta({ valorUtilizado: totalDed, percentualUtilizado: indicadoresRentabilidade.total_deducoes, limitePct: metas.total_deducoes?.limite ?? null, faturamentoBase: base }),
  };

  const cards = {
    // Antes chamado "vendasBrutas" e alimentado pela etapa Desempenho — era
    // exatamente o bug relatado: o card financeiro principal usando o dado
    // errado. Agora é o faturamento real do Financeiro.
    faturamento: { valor: base, diasComDados: linhasComDados.length },
    taxasComissoes: { valor: cardValores.taxasComissoes, percentual: indicadoresRentabilidade.taxas_comissoes, meta: metas.taxas_comissoes ?? null, saldo: saldos.taxas_comissoes, status: statusIndicador(indicadoresRentabilidade.taxas_comissoes, metas.taxas_comissoes) },
    servicosPromocoes: { valor: cardValores.servicosPromocoes, percentual: indicadoresRentabilidade.servicos_promocoes, meta: metas.servicos_promocoes ?? null, saldo: saldos.servicos_promocoes, status: statusIndicador(indicadoresRentabilidade.servicos_promocoes, metas.servicos_promocoes) },
    totalDeducoes: { valor: totalDed, percentual: indicadoresRentabilidade.total_deducoes, meta: metas.total_deducoes ?? null, saldo: saldos.total_deducoes, status: statusIndicador(indicadoresRentabilidade.total_deducoes, metas.total_deducoes) },
    receitaAposDeducoes: { valor: receitaAposDeducoes(base, totalDed), percentual: saldoPercentual(indicadoresRentabilidade.total_deducoes) },
  };

  // Projeção: média do FATURAMENTO (Financeiro) sobre os dias com dados;
  // multiplicador = todos os dias do mês (sem calendário operacional
  // configurável ainda — ver migration 023).
  const media = mediaDiaria(linhasComDados.map((r) => (r.valor_vendas_ifood == null ? null : Number(r.valor_vendas_ifood))));
  const projecao = projecaoMensal(media, diasComStatus.length);
  const diasVencidos = diasComStatus.filter((d) => d.status !== STATUS_DIA.FUTURO).length;
  const confiabilidade = confiabilidadeProjecao({
    diasVencidos, diasResolvidos: resumo.diasPreenchidos, diasComDados: linhasComDados.length,
  });

  // Comparativo com o período de referência — trata mês em andamento com
  // cuidado (não compara um mês parcial com um mês fechado inteiro) e, se
  // houver queda real, monta o plano de recuperação. Ver função abaixo.
  const { comparativo, recuperacao } = await calcularComparativoEPlanoRecuperacao({
    unidadeId, ano, mes, hojeIso, diasComStatus, base, media,
  });

  const diasEstimados = linhas.filter((r) => r.origem_lancamento === "distribuicao_mensal").length;
  const diasPendentesDatas = diasComStatus
    .filter((d) => d.status === STATUS_DIA.PENDENTE || d.status === STATUS_DIA.BLOQUEADO)
    .map((d) => d.data);

  const indicadoresParaDiagnostico = {
    taxas_comissoes: { atual: null, valor: cardValores.taxasComissoes, meta: metas.taxas_comissoes ?? null, saldo: saldos.taxas_comissoes, naoAplicavel: !indicadorAplicavel(modelo.modeloLogistico, "taxas_comissoes") },
    servicos_promocoes: { atual: null, valor: cardValores.servicosPromocoes, meta: metas.servicos_promocoes ?? null, saldo: saldos.servicos_promocoes, naoAplicavel: !indicadorAplicavel(modelo.modeloLogistico, "servicos_promocoes") },
    taxas_entregadores: { atual: null, valor: cardValores.taxasEntregadores, meta: metas.taxas_entregadores ?? null, saldo: saldos.taxas_entregadores, naoAplicavel: !indicadorAplicavel(modelo.modeloLogistico, "taxas_entregadores") },
    total_deducoes: { atual: null, valor: totalDed, meta: metas.total_deducoes ?? null, saldo: saldos.total_deducoes, naoAplicavel: !indicadorAplicavel(modelo.modeloLogistico, "total_deducoes") },
  };
  for (const [k, v] of Object.entries(indicadoresRentabilidade)) {
    indicadoresParaDiagnostico[k].atual = indicadoresParaDiagnostico[k].naoAplicavel ? null : v;
  }

  const diagnosticoNovo = gerarDiagnostico({
    indicadores: indicadoresParaDiagnostico,
    faturamentoBase: base,
    diasComDados: linhasComDados.length,
    diasPendentes: resumo.diasPendentes,
    diasPendentesDatas,
    diasEstimados,
    comparativo,
    recuperacao,
  });

  const pendenciasMesesAnteriores = await calcularPendenciasMesAnterior({ unidadeId, ano, mes, hojeIso });

  return {
    agregado: false,
    unidadeId,
    ehTeste: modelo.ehTeste,
    modeloLogistico: modelo.modeloLogistico,
    modeloLogisticoRotulo: modelo.modeloLogisticoRotulo,
    periodo: { mes, ano },
    resumoPreenchimento: resumo,
    calendario: diasComStatus,
    pendenciasMesesAnteriores,
    cards,
    indicadoresRentabilidade: Object.fromEntries(
      Object.entries(indicadoresRentabilidade).map(([k, atualBruto]) => {
        const aplicavel = indicadorAplicavel(modelo.modeloLogistico, k);
        const atual = aplicavel ? atualBruto : null;
        const valorUtilizado = { taxas_comissoes: cardValores.taxasComissoes, servicos_promocoes: cardValores.servicosPromocoes, taxas_entregadores: cardValores.taxasEntregadores, total_deducoes: totalDed }[k] ?? null;
        return [k, {
          atual, metaIdeal: metas[k]?.metaIdeal ?? null, limite: metas[k]?.limite ?? null,
          naoAplicavel: !aplicavel,
          status: aplicavel ? statusIndicador(atual, metas[k]) : null,
          saldo: aplicavel ? saldoMeta({ valorUtilizado, percentualUtilizado: atual, limitePct: metas[k]?.limite ?? null, faturamentoBase: base }) : null,
        }];
      }),
    ),
    graficos: {
      comparativoPercentuais: Object.entries(indicadoresRentabilidade)
        .filter(([indicador]) => indicadorAplicavel(modelo.modeloLogistico, indicador))
        .map(([indicador, atual]) => ({
          indicador, atual, metaIdeal: metas[indicador]?.metaIdeal ?? null, limite: metas[indicador]?.limite ?? null,
        })),
      composicaoDeducoes: [
        { indicador: "taxas_comissoes", valor: cardValores.taxasComissoes },
        { indicador: "servicos_promocoes", valor: cardValores.servicosPromocoes },
        { indicador: "taxas_entregadores", valor: cardValores.taxasEntregadores },
        { indicador: "outras_deducoes", valor: cardValores.outrasDeducoes },
      ],
      evolucaoDiaria: diasComStatus.map((d) => ({
        data: d.data, status: d.status,
        valor: d.lancamento ? Number(d.lancamento.valor_vendas_ifood) : null,
        origemLancamento: d.lancamento?.origem_lancamento ?? null,
      })),
      evolucaoDeducoes: diasComStatus.map((d) => ({
        data: d.data, status: d.status,
        percentualTotalDeducoes: d.lancamento
          ? percentual(totalDeducoes({
              taxasComissoes: d.lancamento.taxas_comissoes, servicosPromocoes: d.lancamento.servicos_promocoes,
              taxasEntregadores: d.lancamento.taxas_entregadores, outrasDeducoes: d.lancamento.outras_deducoes,
            }), d.lancamento.valor_vendas_ifood)
          : null,
        metaIdeal: metas.total_deducoes?.metaIdeal ?? null, limite: metas.total_deducoes?.limite ?? null,
      })),
    },
    projecao: {
      mediaDiaria: media, diasConsiderados: linhasComDados.length, diasResolvidos: resumo.diasPreenchidos,
      diasPendentes: resumo.diasPendentes, diasPrevistos: diasComStatus.length, projecaoMensal: projecao,
      confiabilidade: confiabilidade.nivel, justificativa: confiabilidade.justificativa,
      parcial: resumo.diasPendentes > 0,
    },
    diagnostico: diagnosticoNovo,
  };
}

async function obterMesAgregado({ organizacaoId, mes, ano, hojeIso, metas }) {
  const dias = diasDoMes(ano, mes);
  const { data, error } = await supabase
    .from(TABELA).select("*").eq("organizacao_id", organizacaoId)
    .gte("data_lancamento", dias[0]).lte("data_lancamento", dias[dias.length - 1]);
  if (error) throw ApiError.internal(error.message);

  const linhas = (data ?? []).filter((r) => r.status === "finalizado" || r.status === "rascunho"); // inclui rascunho na visão agregada (é leitura)
  const somaSimples = (campo) => linhas.reduce((s, r) => s + Number(r[campo] || 0), 0);
  const somaNulavel = (campo) => {
    const valoresCampo = linhas.map((r) => r[campo]).filter((v) => v != null);
    return valoresCampo.length ? valoresCampo.reduce((s, v) => s + Number(v), 0) : null;
  };
  const valores = {
    // Financeiro é a fonte de verdade — mesma regra da visão por unidade.
    valorVendasIfood: somaSimples("valor_vendas_ifood"),
    taxasComissoes: somaNulavel("taxas_comissoes"),
    servicosPromocoes: somaNulavel("servicos_promocoes"),
    taxasEntregadores: somaNulavel("taxas_entregadores"),
    outrasDeducoes: somaNulavel("outras_deducoes"),
  };
  const totalDed = totalDeducoes({
    taxasComissoes: valores.taxasComissoes, servicosPromocoes: valores.servicosPromocoes,
    taxasEntregadores: valores.taxasEntregadores, outrasDeducoes: valores.outrasDeducoes,
  });
  const base = valores.valorVendasIfood;
  const indicadoresRentabilidade = {
    taxas_comissoes: percentual(valores.taxasComissoes, base),
    servicos_promocoes: percentual(valores.servicosPromocoes, base),
    taxas_entregadores: percentual(valores.taxasEntregadores, base),
    total_deducoes: percentual(totalDed, base),
  };

  // Evolução diária somada de todas as unidades (Financeiro).
  const porData = new Map();
  for (const r of linhas) {
    const acc = porData.get(r.data_lancamento) ?? 0;
    porData.set(r.data_lancamento, acc + Number(r.valor_vendas_ifood || 0));
  }
  const evolucaoDiaria = dias.map((d) => ({
    data: d, status: d > hojeIso ? STATUS_DIA.FUTURO : (porData.has(d) ? STATUS_DIA.PREENCHIDO : STATUS_DIA.PENDENTE),
    valor: porData.get(d) ?? null,
  }));

  return {
    agregado: true,
    unidadeId: null,
    modeloLogistico: null,
    periodo: { mes, ano },
    aviso: "Visão consolidada de todas as unidades — somente leitura. Selecione uma unidade específica para lançar ou corrigir dados. Como cada unidade pode estar em um modelo logístico diferente (Marketplace/Full Service), as metas não são exibidas nesta visão agregada.",
    cards: {
      faturamento: { valor: base, diasComDados: linhas.length },
      taxasComissoes: { valor: valores.taxasComissoes, percentual: indicadoresRentabilidade.taxas_comissoes, meta: metas.taxas_comissoes ?? null, status: statusIndicador(indicadoresRentabilidade.taxas_comissoes, metas.taxas_comissoes) },
      servicosPromocoes: { valor: valores.servicosPromocoes, percentual: indicadoresRentabilidade.servicos_promocoes, meta: metas.servicos_promocoes ?? null, status: statusIndicador(indicadoresRentabilidade.servicos_promocoes, metas.servicos_promocoes) },
      totalDeducoes: { valor: totalDed, percentual: indicadoresRentabilidade.total_deducoes, meta: metas.total_deducoes ?? null, status: statusIndicador(indicadoresRentabilidade.total_deducoes, metas.total_deducoes) },
      receitaAposDeducoes: { valor: receitaAposDeducoes(base, totalDed), percentual: saldoPercentual(indicadoresRentabilidade.total_deducoes) },
    },
    indicadoresRentabilidade: Object.fromEntries(
      Object.entries(indicadoresRentabilidade).map(([k, atual]) => [k, {
        atual, metaIdeal: metas[k]?.metaIdeal ?? null, limite: metas[k]?.limite ?? null,
        status: statusIndicador(atual, metas[k]),
      }]),
    ),
    graficos: {
      comparativoPercentuais: Object.entries(indicadoresRentabilidade).map(([indicador, atual]) => ({
        indicador, atual, metaIdeal: metas[indicador]?.metaIdeal ?? null, limite: metas[indicador]?.limite ?? null,
      })),
      composicaoDeducoes: [
        { indicador: "taxas_comissoes", valor: valores.taxasComissoes },
        { indicador: "servicos_promocoes", valor: valores.servicosPromocoes },
        { indicador: "taxas_entregadores", valor: valores.taxasEntregadores },
        { indicador: "outras_deducoes", valor: valores.outrasDeducoes },
      ],
      evolucaoDiaria,
    },
  };
}

// ---------------------------------------------------------------------------
// GET /dashboard-executivo/lancamentos/:data
// ---------------------------------------------------------------------------
export async function obterLancamentoPorData({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, data }) {
  const dataIso = v.dataOpcional(data, "Data") ?? (() => { throw ApiError.badRequest("Data é obrigatória."); })();
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: true });

  const { data: row, error } = await supabase
    .from(TABELA).select("*").eq("unidade_id", unidadeId).eq("data_lancamento", dataIso).maybeSingle();
  if (error) throw ApiError.internal(error.message);

  const hojeIso = hojeIsoBrasil();
  const [ano, mes] = dataIso.split("-").map(Number);
  const { diasComStatus } = await carregarCalendarioMes({ unidadeId, ano, mes, hojeIso });
  const disponibilidade = verificarDisponibilidade(diasComStatus, dataIso);

  return { lancamento: row ? paraApi(row) : null, disponibilidade };
}

// ---------------------------------------------------------------------------
// NORMALIZAÇÃO DOS DADOS DE ENTRADA DO FORMULÁRIO (etapas 1-3)
// ---------------------------------------------------------------------------
function normalizarDadosLancamento(body, { podeAjustarNegativo }) {
  const b = v.corpo(body);
  const situacao = v.umDe(b.situacao, "Situação", ["normal", "sem_operacao", "zero_vendas"]);
  const statusAlvo = v.umDeOpcional(b.status, "Status", ["rascunho", "finalizado"], "rascunho");

  // "Sem operação"/"Zero vendas" são ZEROS REAIS e conhecidos (a loja não
  // funcionou, ou funcionou e não vendeu nada) — bem diferente de "não sei".
  // Por isso continuam gravando 0, não null.
  if (situacao === "sem_operacao") {
    const motivo = v.texto(b.motivoSemOperacao, "Motivo de não operação", { min: 1, max: 300 });
    return {
      situacao, statusAlvo, motivoSemOperacao: motivo, observacao: v.textoOpcional(b.observacao, "Observação", { max: 1000 }),
      qtdVendas: 0, valorVendasBruto: 0, novosClientes: 0, valorVendasIfood: 0,
      taxasComissoes: 0, servicosPromocoes: 0, taxasEntregadores: 0, outrasDeducoes: 0, justificativaAjuste: null,
      avisos: [],
    };
  }

  if (situacao === "zero_vendas") {
    return {
      situacao, statusAlvo, motivoSemOperacao: null, observacao: v.textoOpcional(b.observacao, "Observação", { max: 1000 }),
      qtdVendas: 0, valorVendasBruto: 0, novosClientes: v.numeroOpcionalNulo(b.novosClientes, "Novos clientes", { min: 0 }),
      valorVendasIfood: 0, taxasComissoes: 0, servicosPromocoes: 0, taxasEntregadores: 0, outrasDeducoes: 0, justificativaAjuste: null,
      avisos: [],
    };
  }

  // situacao === "normal" — ETAPA DESEMPENHO (qtdVendas/valorVendasBruto/
  // novosClientes) é OPCIONAL: nada aqui bloqueia o lançamento, e o que não
  // for informado vira null (nunca 0) — "não sei" ≠ "foi zero". A etapa
  // Financeiro continua obrigatória: é a fonte de verdade financeira e o
  // franqueado sempre tem esse extrato do iFood em mãos.
  const qtdVendasRaw = v.numeroOpcionalNulo(b.qtdVendas, "Quantidade de vendas", { min: 0 });
  const qtdVendas = qtdVendasRaw == null ? null : Math.trunc(qtdVendasRaw);
  const valorVendasBruto = v.numeroOpcionalNulo(b.valorVendasBruto, "Valor bruto das vendas", { min: 0 });
  const novosClientesRaw = v.numeroOpcionalNulo(b.novosClientes, "Novos clientes", { min: 0 });
  const novosClientes = novosClientesRaw == null ? null : Math.trunc(novosClientesRaw);
  const valorVendasIfood = v.numero(b.valorVendasIfood, "Valor das vendas (iFood)", { min: 0 });
  const taxasComissoes = v.numero(b.taxasComissoes, "Taxas e comissões", { min: 0 });
  const servicosPromocoes = v.numero(b.servicosPromocoes, "Serviços e promoções", { min: 0 });
  const taxasEntregadores = v.numero(b.taxasEntregadores, "Taxas de entregadores", { min: 0 });
  const outrasDeducoes = v.numero(b.outrasDeducoes, "Outras deduções", { min: -1e9, max: 1e9 });
  const justificativaAjuste = v.textoOpcional(b.justificativaAjuste, "Justificativa do ajuste", { max: 500 });

  const erroAjuste = validarOutrasDeducoes({ valor: outrasDeducoes, justificativa: justificativaAjuste, podeAjustarNegativo });
  if (erroAjuste) throw ApiError.badRequest(erroAjuste);

  const totalDed = totalDeducoes({ taxasComissoes, servicosPromocoes, taxasEntregadores, outrasDeducoes });
  const avisos = inconsistencias({ qtdVendas, valorVendasBruto, valorVendasIfood, totalDed });

  if (statusAlvo === "finalizado" && avisos.length > 0 && !v.booleano(b.confirmarAvisos, false)) {
    throw ApiError.badRequest(`Existem inconsistências que precisam de confirmação antes de finalizar: ${avisos.join(" ")}`, { avisos, confirmacaoNecessaria: true });
  }

  return {
    situacao, statusAlvo, motivoSemOperacao: null, observacao: v.textoOpcional(b.observacao, "Observação", { max: 1000 }),
    qtdVendas, valorVendasBruto, novosClientes, valorVendasIfood,
    taxasComissoes, servicosPromocoes, taxasEntregadores, outrasDeducoes, justificativaAjuste,
    avisos,
  };
}

// ---------------------------------------------------------------------------
// POST /dashboard-executivo/lancamentos
// ---------------------------------------------------------------------------
export async function criarLancamento({ organizacaoId, unidadeIdSessao, acesso, usuario, dados: body }) {
  const b = v.corpo(body);
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado: b.unidadeId, exigirEspecifica: true });
  const dataIso = v.dataOpcional(b.data, "Data");
  if (!dataIso) throw ApiError.badRequest("Data é obrigatória.");

  const hojeIso = hojeIsoBrasil();
  if (dataIso > hojeIso) throw ApiError.badRequest("Não é possível lançar uma data futura.");

  const [ano, mes] = dataIso.split("-").map(Number);
  const { diasComStatus } = await carregarCalendarioMes({ unidadeId, ano, mes, hojeIso });
  const disponibilidade = verificarDisponibilidade(diasComStatus, dataIso);
  if (!disponibilidade.disponivel) throw new ApiError(409, disponibilidade.motivo, { statusDia: disponibilidade.status });
  if (disponibilidade.status !== STATUS_DIA.PENDENTE) {
    throw new ApiError(409, "Já existe um lançamento para esta data. Utilize a edição.", { statusDia: disponibilidade.status });
  }

  const podeAjustarNegativo = temPermissao(acesso.permissoes, PERMISSOES.DASHBOARD_EXECUTIVO_CORRIGIR);
  const dados = normalizarDadosLancamento(body, { podeAjustarNegativo });

  const linha = {
    organizacao_id: organizacaoId,
    unidade_id: unidadeId,
    data_lancamento: dataIso,
    situacao: dados.situacao,
    motivo_sem_operacao: dados.motivoSemOperacao,
    observacao: dados.observacao,
    qtd_vendas: dados.qtdVendas,
    valor_vendas_bruto: dados.valorVendasBruto,
    novos_clientes: dados.novosClientes,
    valor_vendas_ifood: dados.valorVendasIfood,
    taxas_comissoes: dados.taxasComissoes,
    servicos_promocoes: dados.servicosPromocoes,
    taxas_entregadores: dados.taxasEntregadores,
    outras_deducoes: dados.outrasDeducoes,
    justificativa_ajuste: dados.justificativaAjuste,
    status: dados.statusAlvo,
    usuario_id: usuario?.id ?? null,
    usuario_nome: usuario?.nome ?? null,
    usuario_email: usuario?.email ?? null,
    finalizado_em: dados.statusAlvo === "finalizado" ? new Date().toISOString() : null,
  };

  const { data: row, error } = await supabase.from(TABELA).insert(linha).select("*").single();
  if (error) {
    if (/duplicate key|unique/i.test(error.message)) {
      throw new ApiError(409, "Já existe um lançamento para esta unidade e data.", { statusDia: STATUS_DIA.PREENCHIDO });
    }
    throw ApiError.badRequest(error.message);
  }

  if (dados.outrasDeducoes < 0) {
    await registrarAuditoria({
      lancamentoId: row.id, organizacaoId, unidadeId, campo: "outras_deducoes",
      valorAnterior: null, valorNovo: String(dados.outrasDeducoes), usuario, motivo: dados.justificativaAjuste,
    });
  }

  return { lancamento: paraApi(row), avisos: dados.avisos };
}

// ---------------------------------------------------------------------------
// PUT /dashboard-executivo/lancamentos/:id
// ---------------------------------------------------------------------------
export async function atualizarLancamento({ organizacaoId, unidadeIdSessao, acesso, usuario, id, dados: body }) {
  const lancamentoId = v.uuid(id, "Lançamento");
  const { data: antes, error: eAntes } = await supabase
    .from(TABELA).select("*").eq("id", lancamentoId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (eAntes) throw ApiError.internal(eAntes.message);
  if (!antes) throw ApiError.notFound("Lançamento não encontrado.");

  if (unidadeIdSessao && antes.unidade_id !== unidadeIdSessao) {
    throw ApiError.forbidden("Você não tem acesso a este lançamento.");
  }

  const eraFinalizado = antes.status === "finalizado";
  const podeCorrigir = temPermissao(acesso.permissoes, PERMISSOES.DASHBOARD_EXECUTIVO_CORRIGIR);

  let motivoCorrecao = null;
  if (eraFinalizado) {
    if (!podeCorrigir) throw ApiError.forbidden("Editar um lançamento finalizado exige a permissão de correção.");
    motivoCorrecao = v.texto(v.corpo(body).motivo, "Motivo da correção", { min: 3, max: 500 });
  }

  const dados = normalizarDadosLancamento(body, { podeAjustarNegativo: podeCorrigir });

  const patch = {
    situacao: dados.situacao,
    motivo_sem_operacao: dados.motivoSemOperacao,
    observacao: dados.observacao,
    qtd_vendas: dados.qtdVendas,
    valor_vendas_bruto: dados.valorVendasBruto,
    novos_clientes: dados.novosClientes,
    valor_vendas_ifood: dados.valorVendasIfood,
    taxas_comissoes: dados.taxasComissoes,
    servicos_promocoes: dados.servicosPromocoes,
    taxas_entregadores: dados.taxasEntregadores,
    outras_deducoes: dados.outrasDeducoes,
    justificativa_ajuste: dados.justificativaAjuste,
  };
  // Uma vez finalizado, permanece finalizado (correção não "desfinaliza").
  // A partir de rascunho, o próprio PUT pode finalizar.
  patch.status = eraFinalizado ? "finalizado" : dados.statusAlvo;
  if (!eraFinalizado && dados.statusAlvo === "finalizado") {
    patch.finalizado_em = new Date().toISOString();
    patch.usuario_id = usuario?.id ?? antes.usuario_id;
    patch.usuario_nome = usuario?.nome ?? antes.usuario_nome;
    patch.usuario_email = usuario?.email ?? antes.usuario_email;
  }

  // `organizacao_id` repetido na própria escrita (não só na leitura acima,
  // linha 676): defesa em profundidade — o `id` já foi validado contra o
  // tenant, mas a escrita não deve depender só de quem chamou ter feito isso.
  const { data: depois, error } = await supabase
    .from(TABELA).update(patch).eq("id", lancamentoId).eq("organizacao_id", organizacaoId).select("*").single();
  if (error) throw ApiError.badRequest(error.message);

  // Auditoria: um lançamento finalizado editado grava uma linha POR CAMPO
  // alterado, preservando o registro original (nunca se sobrescreve "em silêncio").
  if (eraFinalizado) {
    const CAMPOS_AUDITADOS = [
      ["situacao", "situacao"], ["motivo_sem_operacao", "motivo_sem_operacao"], ["observacao", "observacao"],
      ["qtd_vendas", "qtd_vendas"], ["valor_vendas_bruto", "valor_vendas_bruto"], ["novos_clientes", "novos_clientes"],
      ["valor_vendas_ifood", "valor_vendas_ifood"], ["taxas_comissoes", "taxas_comissoes"],
      ["servicos_promocoes", "servicos_promocoes"], ["taxas_entregadores", "taxas_entregadores"],
      ["outras_deducoes", "outras_deducoes"],
    ];
    for (const [campoAntes, campoDepois] of CAMPOS_AUDITADOS) {
      const valorAntes = antes[campoAntes];
      const valorDepois = depois[campoDepois];
      if (String(valorAntes ?? "") !== String(valorDepois ?? "")) {
        await registrarAuditoria({
          lancamentoId, organizacaoId, unidadeId: antes.unidade_id, campo: campoDepois,
          valorAnterior: valorAntes != null ? String(valorAntes) : null,
          valorNovo: valorDepois != null ? String(valorDepois) : null,
          usuario, motivo: motivoCorrecao,
        });
      }
    }
  } else if (Number(dados.outrasDeducoes) < 0 && Number(antes.outras_deducoes) >= 0) {
    // Rascunho ganhando um ajuste negativo pela primeira vez: audita mesmo sem "correção" formal.
    await registrarAuditoria({
      lancamentoId, organizacaoId, unidadeId: antes.unidade_id, campo: "outras_deducoes",
      valorAnterior: String(antes.outras_deducoes), valorNovo: String(dados.outrasDeducoes),
      usuario, motivo: dados.justificativaAjuste,
    });
  }

  return { lancamento: paraApi(depois), avisos: dados.avisos };
}

async function registrarAuditoria({ lancamentoId, organizacaoId, unidadeId, campo, valorAnterior, valorNovo, usuario, motivo }) {
  const { error } = await supabase.from(TABELA_AUDITORIA).insert({
    lancamento_id: lancamentoId,
    organizacao_id: organizacaoId,
    unidade_id: unidadeId,
    campo,
    valor_anterior: valorAnterior,
    valor_novo: valorNovo,
    usuario_id: usuario?.id ?? null,
    usuario_nome: usuario?.nome ?? null,
    usuario_email: usuario?.email ?? null,
    motivo: motivo ?? "Não informado",
  });
  if (error) console.error("[dashboard-executivo] falha ao registrar auditoria:", error.message);
}

// ---------------------------------------------------------------------------
// DELETE (de verdade) DE UM LANÇAMENTO — universal (qualquer unidade, real
// ou de teste), restrito a quem tem DASHBOARD_EXECUTIVO_EXCLUIR (só
// organization_admin, ver permissoes.js). Diferente do reset de teste: aqui
// é UM dia só, sem cascata, e sempre com motivo + snapshot completo — nunca
// se apaga um lançamento financeiro "em silêncio".
// ---------------------------------------------------------------------------
export async function excluirLancamento({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, usuario, id, motivo: motivoRaw }) {
  const lancamentoId = v.uuid(id, "Lançamento");
  const motivo = v.texto(motivoRaw, "Motivo da exclusão", { min: 3, max: 500 });

  const { data: linha, error } = await supabase
    .from(TABELA).select("*").eq("id", lancamentoId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!linha) throw ApiError.notFound("Lançamento não encontrado.");

  // Mesma regra de escopo das demais ações: sessão presa a uma unidade não
  // pode agir sobre lançamento de outra unidade, mesmo com a permissão.
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado: unidadeIdSolicitado ?? linha.unidade_id, exigirEspecifica: true });
  if (linha.unidade_id !== unidadeId) throw ApiError.forbidden("Você não tem acesso a este lançamento.");

  // Snapshot ANTES de apagar — tabela própria, sem FK para o lançamento (que
  // está prestes a deixar de existir), então o registro da exclusão nunca
  // some junto com o que foi apagado.
  const { error: eLog } = await supabase.from("lancamentos_financeiros_exclusoes").insert({
    organizacao_id: organizacaoId, unidade_id: linha.unidade_id, data_lancamento: linha.data_lancamento,
    lancamento_snapshot: linha, motivo,
    usuario_id: usuario?.id ?? null, usuario_nome: usuario?.nome ?? null, usuario_email: usuario?.email ?? null,
  });
  if (eLog) console.error("[dashboard-executivo] falha ao registrar log de exclusão:", eLog.message);

  const { error: eDel } = await supabase.from(TABELA).delete().eq("id", lancamentoId);
  if (eDel) throw ApiError.badRequest(eDel.message);

  return { excluido: true, data: linha.data_lancamento, unidadeId: linha.unidade_id };
}

// ---------------------------------------------------------------------------
// GET /dashboard-executivo/historico — rollup de 12 meses
// ---------------------------------------------------------------------------
export async function obterHistorico({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, ano: anoRaw }) {
  const ano = v.numero(anoRaw, "Ano", { min: 2000, max: 2100 });
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: false });

  let q = supabase.from(TABELA).select("*")
    .gte("data_lancamento", `${ano}-01-01`).lte("data_lancamento", `${ano}-12-31`)
    .in("status", ["finalizado", "rascunho"]);
  q = unidadeId ? q.eq("unidade_id", unidadeId) : q.eq("organizacao_id", organizacaoId);
  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);

  const hojeIso = hojeIsoBrasil();
  const meses = [];
  let totalMesAnterior = null;
  for (let mes = 1; mes <= 12; mes++) {
    const dias = diasDoMes(ano, mes);
    const linhasMes = (data ?? []).filter((r) => r.data_lancamento >= dias[0] && r.data_lancamento <= dias[dias.length - 1]);
    const linhasComDados = linhasMes.filter((r) => r.status === "finalizado" && r.situacao !== "sem_operacao");
    const linhasFinalizadas = linhasMes.filter((r) => r.status === "finalizado");
    // Faturamento = Financeiro (fonte de verdade). Simples porque
    // valor_vendas_ifood é sempre exigido em qualquer lançamento "normal".
    const somaSimples = (campo) => linhasFinalizadas.reduce((s, r) => s + Number(r[campo] || 0), 0);
    // Deduções: null quando NENHUM dia do mês tem aquele detalhamento — um
    // mês só com lançamento mensal (sem taxas/comissões conhecidas) não
    // pode aparecer como "0% de dedução".
    const somaNulavel = (campo) => {
      const valoresCampo = linhasFinalizadas.map((r) => r[campo]).filter((v) => v != null);
      return valoresCampo.length ? valoresCampo.reduce((s, v) => s + Number(v), 0) : null;
    };

    const faturamento = somaSimples("valor_vendas_ifood");
    const totalDed = totalDeducoes({
      taxasComissoes: somaNulavel("taxas_comissoes"), servicosPromocoes: somaNulavel("servicos_promocoes"),
      taxasEntregadores: somaNulavel("taxas_entregadores"), outrasDeducoes: somaNulavel("outras_deducoes"),
    });
    const diasFinalizados = linhasFinalizadas.length;
    const diasRascunho = linhasMes.filter((r) => r.status === "rascunho").length;
    const diasVencidosNoMes = dias.filter((d) => d <= hojeIso).length;
    const diasPendentes = Math.max(diasVencidosNoMes - diasFinalizados - diasRascunho, 0);

    // Ticket médio: Desempenho, e só combina dias em que AMBOS (qtd e valor
    // bruto) são conhecidos — nunca mistura a soma de um dia que tem só um
    // dos dois. Um mês de puro lançamento mensal (sem Desempenho nenhum)
    // resulta corretamente em `null`, não em "R$ 0,00".
    const linhasComParDesempenho = linhasComDados.filter((r) => r.qtd_vendas != null && r.valor_vendas_bruto != null);
    const qtdVendasPareado = linhasComParDesempenho.reduce((s, r) => s + Number(r.qtd_vendas), 0);
    const valorVendasBrutoPareado = linhasComParDesempenho.reduce((s, r) => s + Number(r.valor_vendas_bruto), 0);
    const qtdVendas = linhasComParDesempenho.length ? qtdVendasPareado : null;

    const media = mediaDiaria(linhasComDados.map((r) => (r.valor_vendas_ifood == null ? null : Number(r.valor_vendas_ifood))));
    const statusMesRotulo = ano * 100 + mes > Number(hojeIso.slice(0, 7).replace("-", ""))
      ? "futuro"
      : (diasPendentes > 0 ? "incompleto" : (diasFinalizados > 0 ? "completo" : "sem_dados"));

    const comparativoMesAnteriorPct = totalMesAnterior != null && totalMesAnterior > 0
      ? ((faturamento - totalMesAnterior) / totalMesAnterior) * 100 : null;

    meses.push({
      mes, ano, status: statusMesRotulo,
      diasPreenchidos: diasFinalizados, diasPendentes, diasRascunho,
      faturamento, qtdVendas,
      ticketMedio: ticketMedio(qtdVendas != null ? valorVendasBrutoPareado : null, qtdVendas),
      totalDeducoes: totalDed,
      percentualDeducoes: percentual(totalDed, faturamento),
      receitaAposDeducoes: receitaAposDeducoes(faturamento, totalDed),
      mediaDiaria: media,
      projecaoMensal: projecaoMensal(media, dias.length),
      comparativoMesAnteriorPct,
    });
    totalMesAnterior = faturamento > 0 ? faturamento : totalMesAnterior;
  }

  return { ano, unidadeId, meses };
}

// ---------------------------------------------------------------------------
// LANÇAMENTO DE FATURAMENTO MENSAL
//
// Para meses históricos onde o franqueado só sabe o total do mês, não o
// detalhe por dia. Distribui o valor pelos dias SEM lançamento (nunca
// sobrescreve um dia que já tem registro — rascunho ou finalizado, qualquer
// situação). Cada dia gerado nasce com origem_lancamento='distribuicao_mensal'
// e SEM Desempenho/detalhamento financeiro (null — não inventa o que não se
// sabe). Mesmo endpoint faz preview (confirmar=false) e execução
// (confirmar=true), igual ao padrão já usado no reset de teste.
// ---------------------------------------------------------------------------

async function localizarDiasParaDistribuicao({ unidadeId, ano, mes, hojeIso }) {
  const diasDoMesTodos = diasDoMes(ano, mes);
  const diasElegiveis = diasDoMesTodos.filter((d) => d <= hojeIso); // nunca no futuro
  if (!diasElegiveis.length) {
    return { diasDoMesTodos, diasComLancamento: [], diasElegiveisParaDistribuir: [] };
  }
  const { data, error } = await supabase
    .from(TABELA).select("data_lancamento").eq("unidade_id", unidadeId)
    .gte("data_lancamento", diasElegiveis[0]).lte("data_lancamento", diasElegiveis[diasElegiveis.length - 1]);
  if (error) throw ApiError.internal(error.message);
  const comLancamento = new Set((data ?? []).map((r) => r.data_lancamento));
  return {
    diasDoMesTodos,
    diasComLancamento: [...comLancamento],
    diasElegiveisParaDistribuir: diasElegiveis.filter((d) => !comLancamento.has(d)),
  };
}

// Campos extras do lançamento mensal: TODOS opcionais — o franqueado pode
// saber só o faturamento total, ou também os totais de pedidos/deduções do
// mês. O que não for informado continua null em cada dia gerado (nunca 0).
const CAMPOS_EXTRAS_MENSAL = [
  ["qtdVendasTotal", "Quantidade de pedidos do mês"],
  ["novosClientesTotal", "Novos clientes do mês"],
  ["taxasComissoesTotal", "Taxas e comissões do mês"],
  ["servicosPromocoesTotal", "Serviços e promoções do mês"],
  ["taxasEntregadoresTotal", "Taxas de entregadores do mês"],
  ["outrasDeducoesTotal", "Outras deduções do mês"],
];

function validarEntradaLancamentoMensal({ mesRaw, anoRaw, valorRaw, extrasRaw }) {
  const mes = v.numero(mesRaw, "Mês", { min: 1, max: 12 });
  const ano = v.numero(anoRaw, "Ano", { min: 2000, max: 2100 });
  const valorTotalMensal = v.numero(valorRaw, "Faturamento total do mês", { min: 0.01 });
  const extras = {};
  for (const [campo, rotulo] of CAMPOS_EXTRAS_MENSAL) {
    extras[campo] = v.numeroOpcionalNulo(extrasRaw?.[campo], rotulo, { min: 0 });
  }
  return { mes, ano, valorTotalMensal, extras };
}

export async function lancamentoMensal({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, usuario, dados: body, confirmar }) {
  const b = v.corpo(body);
  const { mes, ano, valorTotalMensal, extras } = validarEntradaLancamentoMensal({
    mesRaw: b.mes, anoRaw: b.ano, valorRaw: b.valorTotalMensal, extrasRaw: b,
  });
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado: b.unidadeId, exigirEspecifica: true });
  const hojeIso = hojeIsoBrasil();

  const { diasDoMesTodos, diasComLancamento, diasElegiveisParaDistribuir } =
    await localizarDiasParaDistribuicao({ unidadeId, ano, mes, hojeIso });

  if (!diasElegiveisParaDistribuir.length) {
    throw ApiError.badRequest(
      diasComLancamento.length
        ? "Todos os dias já decorridos deste mês já têm lançamento — não há dia disponível para a distribuição."
        : "Este mês ainda não tem nenhum dia decorrido para receber a distribuição.",
    );
  }

  const preview = {
    mes, ano, valorTotalMensal,
    diasNoMes: diasDoMesTodos.length,
    diasComLancamento: diasComLancamento.length,
    diasParaDistribuir: diasElegiveisParaDistribuir.length,
    valorMedioAproximado: valorTotalMensal / diasElegiveisParaDistribuir.length,
    // Só informativo pro preview mostrar o que também será distribuído.
    camposExtrasInformados: CAMPOS_EXTRAS_MENSAL.filter(([campo]) => extras[campo] != null).map(([campo]) => campo),
  };
  if (!confirmar) return preview;

  const n = diasElegiveisParaDistribuir.length;
  const fatias = distribuirValorMensal(valorTotalMensal, n);
  // Cada campo extra só é distribuído se o franqueado informou o total —
  // senão fica null em todo dia (nunca 0). Contagens usam distribuição
  // inteira; valores em R$ usam a mesma exatidão em centavos do faturamento.
  const fatiasQtdVendas = extras.qtdVendasTotal != null ? distribuirQuantidadeMensal(extras.qtdVendasTotal, n) : null;
  const fatiasNovosClientes = extras.novosClientesTotal != null ? distribuirQuantidadeMensal(extras.novosClientesTotal, n) : null;
  const fatiasTaxasComissoes = extras.taxasComissoesTotal != null ? distribuirValorMensal(extras.taxasComissoesTotal, n) : null;
  const fatiasServicosPromocoes = extras.servicosPromocoesTotal != null ? distribuirValorMensal(extras.servicosPromocoesTotal, n) : null;
  const fatiasTaxasEntregadores = extras.taxasEntregadoresTotal != null ? distribuirValorMensal(extras.taxasEntregadoresTotal, n) : null;
  const fatiasOutrasDeducoes = extras.outrasDeducoesTotal != null ? distribuirValorMensal(extras.outrasDeducoesTotal, n) : null;

  const { data: lote, error: eLote } = await supabase.from("lancamentos_financeiros_distribuicao_mensal").insert({
    organizacao_id: organizacaoId, unidade_id: unidadeId, ano, mes,
    valor_total_centavos: Math.round(valorTotalMensal * 100),
    dias_distribuidos: n,
    usuario_id: usuario?.id ?? null, usuario_nome: usuario?.nome ?? null, usuario_email: usuario?.email ?? null,
  }).select("id").single();
  if (eLote) throw ApiError.badRequest(eLote.message);

  const linhas = diasElegiveisParaDistribuir.map((dataLancamento, i) => ({
    organizacao_id: organizacaoId, unidade_id: unidadeId, data_lancamento: dataLancamento,
    situacao: "normal", status: "finalizado",
    origem_lancamento: "distribuicao_mensal", distribuicao_mensal_id: lote.id,
    valor_vendas_ifood: fatias[i],
    qtd_vendas: fatiasQtdVendas ? fatiasQtdVendas[i] : null,
    // valor_vendas_bruto (Desempenho) NÃO é perguntado de novo — o
    // franqueado já informou o faturamento total uma vez (Financeiro). Só
    // quando ele também informa a quantidade de pedidos é que a mesma fatia
    // de faturamento é reaproveitada aqui, pra ticket médio poder ser
    // calculado; sem quantidade, fica null (sem ticket médio mesmo).
    valor_vendas_bruto: fatiasQtdVendas ? fatias[i] : null,
    novos_clientes: fatiasNovosClientes ? fatiasNovosClientes[i] : null,
    taxas_comissoes: fatiasTaxasComissoes ? fatiasTaxasComissoes[i] : null,
    servicos_promocoes: fatiasServicosPromocoes ? fatiasServicosPromocoes[i] : null,
    taxas_entregadores: fatiasTaxasEntregadores ? fatiasTaxasEntregadores[i] : null,
    outras_deducoes: fatiasOutrasDeducoes ? fatiasOutrasDeducoes[i] : null,
    usuario_id: usuario?.id ?? null, usuario_nome: usuario?.nome ?? null, usuario_email: usuario?.email ?? null,
    finalizado_em: new Date().toISOString(),
  }));

  const { error: eIns } = await supabase.from(TABELA).insert(linhas);
  if (eIns) {
    // Não deixa um lote órfão se a inserção dos dias falhar no meio (ex.:
    // corrida com um lançamento diário criado entre o preview e a confirmação).
    await supabase.from("lancamentos_financeiros_distribuicao_mensal").delete().eq("id", lote.id);
    if (/duplicate key|unique/i.test(eIns.message)) {
      throw new ApiError(409, "Algum dia deste mês recebeu um lançamento entre a prévia e a confirmação. Recarregue e tente novamente.");
    }
    throw ApiError.badRequest(eIns.message);
  }

  return { ...preview, confirmado: true, distribuicaoId: lote.id, diasCriados: diasElegiveisParaDistribuir };
}

// ---------------------------------------------------------------------------
// RESET DE DIA — SÓ EM UNIDADE DE TESTE (eh_teste = true).
//
// Exclusão física de verdade, algo que NUNCA existe pra unidade real (ver
// criarLancamento/atualizarLancamento acima — nenhum DELETE ali, de propósito).
// A checagem de eh_teste é SEMPRE buscada fresca no banco aqui, nunca confiada
// a partir do cliente — mesmo que alguém chame a rota direto na unha para a
// Subway Saci, isto recusa.
// ---------------------------------------------------------------------------
async function garantirUnidadeDeTeste({ unidadeId, organizacaoId }) {
  const { data, error } = await supabase
    .from("unidades").select("id, organizacao_id, eh_teste").eq("id", unidadeId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data || data.organizacao_id !== organizacaoId) throw ApiError.notFound("Unidade não encontrada.");
  if (!data.eh_teste) {
    throw ApiError.forbidden("O reset de lançamentos só está disponível em unidades de teste.");
  }
}

async function lancamentosAPartirDe({ unidadeId, dataAlvo }) {
  const { data, error } = await supabase
    .from(TABELA).select("id, data_lancamento").eq("unidade_id", unidadeId)
    .gte("data_lancamento", dataAlvo).order("data_lancamento");
  if (error) throw ApiError.internal(error.message);
  return (data ?? []).map((l) => ({ id: l.id, data: l.data_lancamento }));
}

/** Preview (dry-run): quais lançamentos seriam removidos, sem apagar nada. */
export async function previewResetTeste({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, data: dataRaw }) {
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: true });
  await garantirUnidadeDeTeste({ unidadeId, organizacaoId });
  const dataAlvo = v.dataOpcional(dataRaw, "Data") ?? (() => { throw ApiError.badRequest("Data é obrigatória."); })();

  const lancamentos = await lancamentosAPartirDe({ unidadeId, dataAlvo });
  if (!lancamentos.length) throw ApiError.notFound("Não existe lançamento nesta data (ou posterior) para resetar.");

  return { unidadeId, dataAlvo, lancamentos };
}

/** Executa de fato: apaga a partir da data (inclusive) e registra o log de teste. */
export async function executarResetTeste({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, data: dataRaw, usuario }) {
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: true });
  await garantirUnidadeDeTeste({ unidadeId, organizacaoId });
  const dataAlvo = v.dataOpcional(dataRaw, "Data") ?? (() => { throw ApiError.badRequest("Data é obrigatória."); })();

  const lancamentos = await lancamentosAPartirDe({ unidadeId, dataAlvo });
  if (!lancamentos.length) throw ApiError.notFound("Não existe lançamento nesta data (ou posterior) para resetar.");

  // Log ANTES de apagar: se o delete falhar no meio, ao menos fica o registro
  // da tentativa (não é a auditoria financeira real — essa nunca é tocada aqui).
  const { error: eLog } = await supabase.from("dashboard_teste_reset_log").insert({
    organizacao_id: organizacaoId, unidade_id: unidadeId,
    usuario_id: usuario?.id ?? null, usuario_nome: usuario?.nome ?? null, usuario_email: usuario?.email ?? null,
    data_inicial_reset: dataAlvo,
    lancamentos_removidos: lancamentos,
  });
  if (eLog) console.error("[dashboard-executivo] falha ao registrar log de reset de teste:", eLog.message);

  const { error: eDel } = await supabase
    .from(TABELA).delete().eq("unidade_id", unidadeId).gte("data_lancamento", dataAlvo);
  if (eDel) throw ApiError.badRequest(eDel.message);

  return { unidadeId, dataAlvo, removidos: lancamentos.map((l) => l.data) };
}
