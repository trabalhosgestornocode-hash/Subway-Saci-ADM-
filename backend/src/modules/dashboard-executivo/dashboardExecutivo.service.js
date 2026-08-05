import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { PERMISSOES, temPermissao } from "../../shared/permissoes.js";
import { resolverMetas } from "./dashboardExecutivo.metas.service.js";
import {
  hojeIsoBrasil, diasDoMes, mesAnterior, statusMes, resumoPreenchimento,
  verificarDisponibilidade, agruparPendenciasPorMes, ticketMedio, percentual,
  totalDeducoes, receitaAposDeducoes, saldoPercentual, mediaDiaria, projecaoMensal,
  confiabilidadeProjecao, diagnostico, recomendacoes, validarOutrasDeducoes,
  inconsistencias, STATUS_DIA,
} from "./dashboardExecutivo.calc.js";

const TABELA = "lancamentos_financeiros_diarios";
const TABELA_AUDITORIA = "lancamentos_financeiros_auditoria";
const RESOLVIDOS_COM_DADOS = new Set([STATUS_DIA.PREENCHIDO, STATUS_DIA.ZERO_VENDAS]);

// ---------------------------------------------------------------------------
// UNIDADE-ALVO — resolve e valida a unidade da ação a partir da sessão.
// Nunca confia no que o cliente manda: quando a sessão já está presa a uma
// unidade, qualquer unidadeId diferente no corpo/query é recusado.
// ---------------------------------------------------------------------------
async function resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica = false }) {
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

function paraApi(row) {
  return {
    id: row.id,
    unidadeId: row.unidade_id,
    data: row.data_lancamento,
    situacao: row.situacao,
    motivoSemOperacao: row.motivo_sem_operacao ?? null,
    observacao: row.observacao ?? null,
    qtdVendas: row.qtd_vendas,
    valorVendasBruto: Number(row.valor_vendas_bruto),
    novosClientes: row.novos_clientes,
    valorVendasIfood: Number(row.valor_vendas_ifood),
    taxasComissoes: Number(row.taxas_comissoes),
    servicosPromocoes: Number(row.servicos_promocoes),
    taxasEntregadores: Number(row.taxas_entregadores),
    outrasDeducoes: Number(row.outras_deducoes),
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
    const { data, error } = await supabase.from("unidades").select("id, nome").eq("id", unidadeIdSessao).maybeSingle();
    if (error) throw ApiError.internal(error.message);
    if (!data) throw ApiError.notFound("Unidade não encontrada.");
    return { unidades: [{ id: data.id, nome: data.nome }], agregadoDisponivel: false };
  }
  const { data, error } = await supabase
    .from("unidades").select("id, nome").eq("organizacao_id", organizacaoId).eq("ativo", true).order("nome");
  if (error) throw ApiError.internal(error.message);
  return { unidades: data ?? [], agregadoDisponivel: true };
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
// GET /dashboard-executivo/mes — payload agregado da página inteira
// ---------------------------------------------------------------------------
export async function obterMes({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, mes: mesRaw, ano: anoRaw }) {
  const mes = v.numero(mesRaw, "Mês", { min: 1, max: 12 });
  const ano = v.numero(anoRaw, "Ano", { min: 2000, max: 2100 });
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: false });
  const hojeIso = hojeIsoBrasil();
  const metas = await resolverMetas({ organizacaoId, unidadeId: unidadeId ?? unidadeIdSessao ?? null });

  if (unidadeId) return obterMesDeUmaUnidade({ organizacaoId, unidadeId, mes, ano, hojeIso, metas });
  return obterMesAgregado({ organizacaoId, mes, ano, hojeIso, metas });
}

async function obterMesDeUmaUnidade({ organizacaoId, unidadeId, mes, ano, hojeIso, metas }) {
  const { diasComStatus, linhas } = await carregarCalendarioMes({ unidadeId, ano, mes, hojeIso });
  const resumo = resumoPreenchimento(diasComStatus);

  // "Dias com dados" = dias com valor financeiro real (PREENCHIDO ou ZERO_VENDAS).
  // SEM_OPERACAO não entra na média (loja fechada não é "um dia de vendas").
  const linhasComDados = linhas.filter((r) => {
    const status = diasComStatus.find((d) => d.data === r.data_lancamento)?.status;
    return RESOLVIDOS_COM_DADOS.has(status);
  });

  const somaCampo = (campo) => linhasComDados.reduce((s, r) => s + Number(r[campo] || 0), 0);
  const cardValores = {
    valorVendasBruto: somaCampo("valor_vendas_bruto"),
    qtdVendas: linhasComDados.reduce((s, r) => s + Number(r.qtd_vendas || 0), 0),
    valorVendasIfood: somaCampo("valor_vendas_ifood"),
    taxasComissoes: somaCampo("taxas_comissoes"),
    servicosPromocoes: somaCampo("servicos_promocoes"),
    taxasEntregadores: somaCampo("taxas_entregadores"),
    outrasDeducoes: somaCampo("outras_deducoes"),
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

  const cards = {
    vendasBrutas: { valor: cardValores.valorVendasBruto, percentualSobreVendas: 100 },
    taxasComissoes: { valor: cardValores.taxasComissoes, percentual: indicadoresRentabilidade.taxas_comissoes, meta: metas.taxas_comissoes ?? null },
    servicosPromocoes: { valor: cardValores.servicosPromocoes, percentual: indicadoresRentabilidade.servicos_promocoes, meta: metas.servicos_promocoes ?? null },
    totalDeducoes: { valor: totalDed, percentual: indicadoresRentabilidade.total_deducoes, meta: metas.total_deducoes ?? null },
    receitaAposDeducoes: { valor: receitaAposDeducoes(base, totalDed), percentual: saldoPercentual(indicadoresRentabilidade.total_deducoes) },
  };

  // Projeção: média sobre os dias COM DADOS; multiplicador = todos os dias do
  // mês (sem calendário operacional configurável ainda — ver migration 023).
  const media = mediaDiaria(linhasComDados.map((r) => Number(r.valor_vendas_bruto)));
  const projecao = projecaoMensal(media, diasComStatus.length);
  const diasVencidos = diasComStatus.filter((d) => d.status !== STATUS_DIA.FUTURO).length;
  const confiabilidade = confiabilidadeProjecao({
    diasVencidos, diasResolvidos: resumo.diasPreenchidos, diasComDados: linhasComDados.length,
  });

  // Comparativo com o mês anterior (faturamento bruto).
  const anterior = mesAnterior(ano, mes);
  const { linhas: linhasAnterior } = await carregarCalendarioMes({ unidadeId, ano: anterior.ano, mes: anterior.mes, hojeIso });
  const totalAnterior = linhasAnterior.reduce((s, r) => s + Number(r.valor_vendas_bruto || 0), 0);
  const comparativoMesAnteriorPct = totalAnterior > 0 ? ((cardValores.valorVendasBruto - totalAnterior) / totalAnterior) * 100 : null;

  const diagn = diagnostico({
    indicadores: linhasComDados.length ? indicadoresRentabilidade : null,
    metas, diasPendentesNoMes: resumo.diasPendentes, comparativoMesAnteriorPct,
  });
  const recom = recomendacoes({
    indicadoresForaDaMeta: diagn.indicadoresForaDaMeta, diasPendentesNoMes: resumo.diasPendentes,
    semDadosSuficientes: diagn.semDadosSuficientes,
  });

  const pendenciasMesesAnteriores = await calcularPendenciasMesAnterior({ unidadeId, ano, mes, hojeIso });

  return {
    agregado: false,
    unidadeId,
    periodo: { mes, ano },
    resumoPreenchimento: resumo,
    calendario: diasComStatus,
    pendenciasMesesAnteriores,
    cards,
    indicadoresRentabilidade: Object.fromEntries(
      Object.entries(indicadoresRentabilidade).map(([k, atual]) => [k, { atual, metaIdeal: metas[k]?.metaIdeal ?? null, limite: metas[k]?.limite ?? null }]),
    ),
    graficos: {
      comparativoPercentuais: Object.entries(indicadoresRentabilidade).map(([indicador, atual]) => ({
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
        valor: d.lancamento ? Number(d.lancamento.valor_vendas_bruto) : null,
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
    diagnostico: diagn,
    recomendacoes: recom,
  };
}

async function obterMesAgregado({ organizacaoId, mes, ano, hojeIso, metas }) {
  const dias = diasDoMes(ano, mes);
  const { data, error } = await supabase
    .from(TABELA).select("*").eq("organizacao_id", organizacaoId)
    .gte("data_lancamento", dias[0]).lte("data_lancamento", dias[dias.length - 1]);
  if (error) throw ApiError.internal(error.message);

  const linhas = (data ?? []).filter((r) => r.status === "finalizado" || r.status === "rascunho"); // inclui rascunho na visão agregada (é leitura)
  const somaCampo = (campo) => linhas.reduce((s, r) => s + Number(r[campo] || 0), 0);
  const valores = {
    valorVendasBruto: somaCampo("valor_vendas_bruto"),
    valorVendasIfood: somaCampo("valor_vendas_ifood"),
    taxasComissoes: somaCampo("taxas_comissoes"),
    servicosPromocoes: somaCampo("servicos_promocoes"),
    taxasEntregadores: somaCampo("taxas_entregadores"),
    outrasDeducoes: somaCampo("outras_deducoes"),
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

  // Evolução diária somada de todas as unidades.
  const porData = new Map();
  for (const r of linhas) {
    const acc = porData.get(r.data_lancamento) ?? 0;
    porData.set(r.data_lancamento, acc + Number(r.valor_vendas_bruto || 0));
  }
  const evolucaoDiaria = dias.map((d) => ({
    data: d, status: d > hojeIso ? STATUS_DIA.FUTURO : (porData.has(d) ? STATUS_DIA.PREENCHIDO : STATUS_DIA.PENDENTE),
    valor: porData.get(d) ?? null,
  }));

  return {
    agregado: true,
    unidadeId: null,
    periodo: { mes, ano },
    aviso: "Visão consolidada de todas as unidades — somente leitura. Selecione uma unidade específica para lançar ou corrigir dados.",
    cards: {
      vendasBrutas: { valor: valores.valorVendasBruto, percentualSobreVendas: 100 },
      taxasComissoes: { valor: valores.taxasComissoes, percentual: indicadoresRentabilidade.taxas_comissoes, meta: metas.taxas_comissoes ?? null },
      servicosPromocoes: { valor: valores.servicosPromocoes, percentual: indicadoresRentabilidade.servicos_promocoes, meta: metas.servicos_promocoes ?? null },
      totalDeducoes: { valor: totalDed, percentual: indicadoresRentabilidade.total_deducoes, meta: metas.total_deducoes ?? null },
      receitaAposDeducoes: { valor: receitaAposDeducoes(base, totalDed), percentual: saldoPercentual(indicadoresRentabilidade.total_deducoes) },
    },
    indicadoresRentabilidade: Object.fromEntries(
      Object.entries(indicadoresRentabilidade).map(([k, atual]) => [k, { atual, metaIdeal: metas[k]?.metaIdeal ?? null, limite: metas[k]?.limite ?? null }]),
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
      qtdVendas: 0, valorVendasBruto: 0, novosClientes: v.numeroOpcional(b.novosClientes, "Novos clientes", { min: 0, padrao: 0 }),
      valorVendasIfood: 0, taxasComissoes: 0, servicosPromocoes: 0, taxasEntregadores: 0, outrasDeducoes: 0, justificativaAjuste: null,
      avisos: [],
    };
  }

  // situacao === "normal"
  const qtdVendas = Math.trunc(v.numero(b.qtdVendas, "Quantidade de vendas", { min: 0 }));
  const valorVendasBruto = v.numero(b.valorVendasBruto, "Valor bruto das vendas", { min: 0 });
  const novosClientes = Math.trunc(v.numeroOpcional(b.novosClientes, "Novos clientes", { min: 0, padrao: 0 }));
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

  const { data: depois, error } = await supabase
    .from(TABELA).update(patch).eq("id", lancamentoId).select("*").single();
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
    const somaCampo = (campo) => linhasMes.filter((r) => r.status === "finalizado").reduce((s, r) => s + Number(r[campo] || 0), 0);

    const valorVendasBruto = somaCampo("valor_vendas_bruto");
    const qtdVendas = linhasMes.filter((r) => r.status === "finalizado").reduce((s, r) => s + Number(r.qtd_vendas || 0), 0);
    const valorVendasIfood = somaCampo("valor_vendas_ifood");
    const totalDed = totalDeducoes({
      taxasComissoes: somaCampo("taxas_comissoes"), servicosPromocoes: somaCampo("servicos_promocoes"),
      taxasEntregadores: somaCampo("taxas_entregadores"), outrasDeducoes: somaCampo("outras_deducoes"),
    });
    const diasFinalizados = linhasMes.filter((r) => r.status === "finalizado").length;
    const diasRascunho = linhasMes.filter((r) => r.status === "rascunho").length;
    const diasVencidosNoMes = dias.filter((d) => d <= hojeIso).length;
    const diasPendentes = Math.max(diasVencidosNoMes - diasFinalizados - diasRascunho, 0);

    const media = mediaDiaria(linhasComDados.map((r) => Number(r.valor_vendas_bruto)));
    const statusMesRotulo = ano * 100 + mes > Number(hojeIso.slice(0, 7).replace("-", ""))
      ? "futuro"
      : (diasPendentes > 0 ? "incompleto" : (diasFinalizados > 0 ? "completo" : "sem_dados"));

    const comparativoMesAnteriorPct = totalMesAnterior != null && totalMesAnterior > 0
      ? ((valorVendasBruto - totalMesAnterior) / totalMesAnterior) * 100 : null;

    meses.push({
      mes, ano, status: statusMesRotulo,
      diasPreenchidos: diasFinalizados, diasPendentes, diasRascunho,
      faturamentoBruto: valorVendasBruto, qtdVendas,
      ticketMedio: ticketMedio(valorVendasBruto, qtdVendas),
      totalDeducoes: totalDed,
      percentualDeducoes: percentual(totalDed, valorVendasIfood),
      receitaAposDeducoes: receitaAposDeducoes(valorVendasIfood, totalDed),
      mediaDiaria: media,
      projecaoMensal: projecaoMensal(media, dias.length),
      comparativoMesAnteriorPct,
    });
    totalMesAnterior = valorVendasBruto > 0 ? valorVendasBruto : totalMesAnterior;
  }

  return { ano, unidadeId, meses };
}
