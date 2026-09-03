// Tool "consultar_dashboard_dia" — detalhe de UM dia do Dashboard Executivo.
//
// REGRA DE OURO (código calcula, IA interpreta): reaproveita
// dashboardExecutivo.service.js#obterLancamentoPorData (financeiro do dia) e
// #obterMes (desempenho operacional já calculado em DELTA por dia). Nenhum
// cálculo novo aqui além de uma subtração pura (deltaFinanceiro, em
// dashboardExecutivo.calc.js — fonte única das fórmulas).
//
// ARMADILHA REAL DO DADO (por isso três blocos no retorno, não um): no
// schema do Dashboard Executivo, tanto Desempenho quanto Financeiro são
// gravados como SNAPSHOT ACUMULADO (dia 1 do mês até a data do lançamento)
// — nunca o valor isolado daquele dia sozinho. O motor já resolve isso para
// Desempenho (`obterMes().desempenhoOperacional.evolucaoDiaria` traz o
// delta pronto — reaproveitado aqui como `operacionalDoDia`). Para
// Financeiro NÃO existe delta pronto em lugar nenhum do produto (só é
// preenchido esporadicamente, então um delta entre dois snapshots
// DISTANTES mentiria, atribuindo vários dias a um só) — por isso
// `financeiroIsoladoDoDia` só é calculado, e só nesta tool, quando o dia
// IMEDIATAMENTE ANTERIOR também tem Financeiro preenchido (comparação
// exata, matematicamente garantida); caso contrário vem `null` e
// `financeiroAcumulado` (o snapshot bruto, rotulado como acumulado) é o
// único dado disponível.
//
// DISTINÇÃO CRÍTICA (pedido da Fase 1.5): "sem lançamento" é DIFERENTE de
// "data futura" é DIFERENTE de "lançamento existe com valor zero de
// verdade". A tool nunca inventa zero — só `possuiLancamento: true` carrega
// valores.
import { ApiError } from "../../../shared/ApiError.js";
import { MODULOS } from "../../../shared/modulos.js";
import { PERMISSOES } from "../../../shared/permissoes.js";
import * as v from "../../../shared/validar.js";
import { garantirAcessoModulo, garantirPermissao } from "../agenteAcesso.js";
import * as dashboardExecutivoService from "../../dashboard-executivo/dashboardExecutivo.service.js";
import { STATUS_DIA, diaAnterior, deltaFinanceiro } from "../../dashboard-executivo/dashboardExecutivo.calc.js";

export const definicao = {
  name: "consultar_dashboard_dia",
  description:
    "Consulta o lançamento de UM DIA específico do Dashboard Executivo (iFood) da unidade do usuário logado. Use quando a pergunta for sobre um dia específico (ex.: \"dia 4\", \"ontem\", \"22/08\") — consultar_dashboard_executivo só traz o total do MÊS. IMPORTANTE sobre os campos do retorno: 'operacionalDoDia' (vendas, ticket médio) é o valor REAL e ISOLADO daquele dia. 'financeiroIsoladoDoDia' (taxas, comissões, deduções, ajustes) também é o valor EXATO e ISOLADO daquele dia — só vem preenchido quando foi possível calcular com certeza (comparando com o dia anterior); quando vier null, use 'financeiroAcumulado' (o snapshot acumulado desde o dia 1 do mês até essa data) e deixe claro que é um valor ACUMULADO, não isolado daquele dia (ex.: \"até o dia 11, acumulou R$ X\", nunca \"no dia 11 gastou R$ X\"). 'ajustesFavorLoja' é CRÉDITO/reembolso a favor da loja (aumenta a receita líquida, NÃO é despesa); 'ajustesContraLoja' é DÉBITO/desconto contra a loja (reduz a receita líquida, entra no total de deduções). Se a data ainda não ocorreu, ou não houver lançamento registrado, a ferramenta informa isso explicitamente — nunca invente um valor para um dia sem lançamento.",
  input_schema: {
    type: "object",
    properties: {
      data: { type: "string", description: "Data no formato AAAA-MM-DD (ex.: 2026-08-04)." },
    },
    required: ["data"],
    additionalProperties: false,
  },
};

/**
 * @param {{data?: string}} input — só o que o MODELO controla.
 * @param {{organizacaoId: string, unidadeId: string|null, acesso: object}} contexto — sempre do backend.
 * @param {{obterLancamentoPorData: typeof dashboardExecutivoService.obterLancamentoPorData, obterMes: typeof dashboardExecutivoService.obterMes}} [deps] injeção para teste.
 */
export async function executar(
  input,
  { organizacaoId, unidadeId, acesso },
  deps = { obterLancamentoPorData: dashboardExecutivoService.obterLancamentoPorData, obterMes: dashboardExecutivoService.obterMes },
) {
  garantirAcessoModulo(acesso, MODULOS.IFOOD_DASHBOARD);
  garantirPermissao(acesso, PERMISSOES.DASHBOARD_EXECUTIVO_VER);

  const data = v.dataOpcional(input?.data, "Data");
  if (!data) throw ApiError.badRequest("Informe a data (formato AAAA-MM-DD).");

  const contexto = { organizacaoId, unidadeId };
  const resultado = await deps.obterLancamentoPorData({
    organizacaoId,
    unidadeIdSessao: unidadeId,
    unidadeIdSolicitado: undefined, // NUNCA do modelo — mesma regra das outras tools.
    data,
  });

  if (resultado.disponibilidade.status === STATUS_DIA.FUTURO) {
    return { data, possuiLancamento: false, motivo: "data_futura" };
  }
  if (!resultado.lancamento) {
    return { data, possuiLancamento: false, motivo: "sem_lancamento" };
  }

  const [operacionalDoDia, financeiroIsoladoDoDia] = await Promise.all([
    buscarOperacionalDoDia(deps, data, contexto),
    calcularFinanceiroIsolado(deps, data, resultado.lancamento, contexto),
  ]);
  return normalizar(data, resultado.lancamento, operacionalDoDia, financeiroIsoladoDoDia);
}

/**
 * Delta (valor isolado) de Desempenho para o dia — já calculado por
 * obterMes()/listaDesempenhoDiario. Não crítico: se o mês falhar por algum
 * motivo (ex.: visão agregada sem unidade), a tool ainda responde com o
 * resto, em vez de derrubar a consulta inteira.
 */
async function buscarOperacionalDoDia(deps, data, { organizacaoId, unidadeId }) {
  try {
    const [ano, mes] = data.split("-").map(Number);
    const mesCompleto = await deps.obterMes({ organizacaoId, unidadeIdSessao: unidadeId, unidadeIdSolicitado: undefined, ano, mes });
    if (mesCompleto.agregado) return null;
    const ponto = mesCompleto.desempenhoOperacional?.evolucaoDiaria?.find((d) => d.data === data);
    if (!ponto || ponto.valor == null) return null;
    return { valorVendasBruto: ponto.valor, qtdVendas: ponto.deltaQtdVendas, novosClientes: ponto.deltaNovosClientes };
  } catch {
    return null;
  }
}

/**
 * Delta EXATO do Financeiro do dia — só quando o dia imediatamente anterior
 * TAMBÉM tem Financeiro preenchido (garantia matemática, ver deltaFinanceiro
 * em dashboardExecutivo.calc.js). Consulta mais 1 dia via a MESMA
 * obterLancamentoPorData já usada acima — nenhum cálculo de negócio novo,
 * só a subtração pura do helper de calc.js.
 */
async function calcularFinanceiroIsolado(deps, data, atual, { organizacaoId, unidadeId }) {
  if (atual.valorVendasIfood == null) return null; // nada a isolar se este dia nem tem Financeiro
  try {
    const dataAnterior = diaAnterior(data);
    const resultadoAnterior = await deps.obterLancamentoPorData({
      organizacaoId, unidadeIdSessao: unidadeId, unidadeIdSolicitado: undefined, data: dataAnterior,
    });
    const anterior = resultadoAnterior.lancamento;
    if (!anterior || anterior.valorVendasIfood == null) return null; // dia anterior sem Financeiro -> delta não confiável

    const valorVendasIfood = deltaFinanceiro(atual.valorVendasIfood, anterior.valorVendasIfood);
    const taxasComissoes = deltaFinanceiro(atual.taxasComissoes, anterior.taxasComissoes);
    const servicosPromocoes = deltaFinanceiro(atual.servicosPromocoes, anterior.servicosPromocoes);
    const taxasEntregadores = deltaFinanceiro(atual.taxasEntregadores, anterior.taxasEntregadores);
    const ajustesFavorLoja = deltaFinanceiro(atual.ajustesFavorLoja, anterior.ajustesFavorLoja);
    const ajustesContraLoja = deltaFinanceiro(atual.ajustesContraLoja, anterior.ajustesContraLoja);
    if ([valorVendasIfood, taxasComissoes, servicosPromocoes, taxasEntregadores, ajustesFavorLoja, ajustesContraLoja].every((v) => v == null)) return null;

    return { diaComparado: dataAnterior, valorVendasIfood, taxasComissoes, servicosPromocoes, taxasEntregadores, ajustesFavorLoja, ajustesContraLoja };
  } catch {
    return null;
  }
}

function normalizar(data, l, operacionalDoDia, financeiroIsoladoDoDia) {
  return {
    data,
    possuiLancamento: true,
    situacao: l.situacao,
    motivoSemOperacao: l.motivoSemOperacao,
    // Valor ISOLADO deste dia (delta) — ver descrição da tool acima.
    operacionalDoDia,
    // Valor ISOLADO e EXATO deste dia, calculado contra o dia anterior — só
    // preenchido quando confiável (ver calcularFinanceiroIsolado acima).
    financeiroIsoladoDoDia,
    // Snapshot ACUMULADO desde o dia 1 do mês até esta data — null quando o
    // Financeiro não foi preenchido especificamente nesta data.
    financeiroAcumulado: l.valorVendasIfood == null ? null : {
      periodoInicio: `${data.slice(0, 7)}-01`,
      periodoFim: data,
      valorVendasIfood: l.valorVendasIfood,
      taxasComissoes: l.taxasComissoes,
      servicosPromocoes: l.servicosPromocoes,
      taxasEntregadores: l.taxasEntregadores,
      ajustesFavorLoja: l.ajustesFavorLoja,
      ajustesContraLoja: l.ajustesContraLoja,
      totalDeducoes: l.calculado.totalDeducoes,
      receitaLiquida: l.calculado.receitaLiquida,
      percentuais: l.calculado.percentuais,
    },
  };
}
