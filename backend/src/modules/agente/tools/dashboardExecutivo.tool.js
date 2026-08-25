// Tool "consultar_dashboard_executivo" — expõe ao Claude só o que ele
// precisa para interpretar o mês: números JÁ CALCULADOS pelo service real.
//
// REGRA DE OURO (código calcula, IA interpreta): esta tool NUNCA recalcula
// faturamento, ticket médio, projeção ou meta — só chama
// dashboardExecutivo.service.js#obterMes (a mesma função que alimenta a tela
// do Dashboard Executivo) e devolve um subconjunto normalizado do retorno.
//
// SEGURANÇA DE TENANT: `organizacaoId`/`unidadeId` vêm SEMPRE de `contexto`
// (construído pelo backend a partir de req.tenant) — o `input_schema` nem
// expõe organizacaoId/unidadeId ao modelo, e mesmo que apareça uma chave
// assim dentro de `input` (ex.: um provider comprometido), esta função nunca
// lê `input.unidadeId`/`input.organizacaoId` para nada.
import { ApiError } from "../../../shared/ApiError.js";
import { MODULOS } from "../../../shared/modulos.js";
import { PERMISSOES } from "../../../shared/permissoes.js";
import { garantirAcessoModulo, garantirPermissao } from "../agenteAcesso.js";
import * as dashboardExecutivoService from "../../dashboard-executivo/dashboardExecutivo.service.js";
import { hojeIsoBrasil } from "../../dashboard-executivo/dashboardExecutivo.calc.js";

export const definicao = {
  name: "consultar_dashboard_executivo",
  description:
    "Consulta os números REAIS já calculados do Dashboard Executivo (iFood) da unidade do usuário logado, para um mês específico: faturamento, taxas e comissões, serviços e promoções, taxas de entregadores, outras deduções, total de deduções, receita após deduções, ticket médio e projeção do mês. Use sempre que o usuário perguntar sobre faturamento, vendas, metas, deduções, ticket médio ou desempenho financeiro do mês. Nunca invente esses números — sempre consulte esta ferramenta antes de responder sobre eles.",
  input_schema: {
    type: "object",
    properties: {
      ano: { type: "integer", description: "Ano de referência (ex.: 2026). Se omitido, usa o ano atual." },
      mes: { type: "integer", description: "Mês de referência, de 1 a 12. Se omitido, usa o mês atual." },
    },
    additionalProperties: false,
  },
};

/**
 * Extrai e valida { ano, mes } de um input de tool, aplicando "mês atual"
 * como default. Compartilhado com a tool de diagnóstico (mesmo período).
 * @param {{ano?: unknown, mes?: unknown}|undefined} input
 */
export function resolverPeriodo(input) {
  const hoje = hojeIsoBrasil();
  const ano = Number.isInteger(input?.ano) ? input.ano : Number(hoje.slice(0, 4));
  const mes = Number.isInteger(input?.mes) ? input.mes : Number(hoje.slice(5, 7));
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) throw ApiError.badRequest("Mês deve estar entre 1 e 12.");
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) throw ApiError.badRequest("Ano inválido.");
  return { ano, mes };
}

/**
 * @param {{ano?: number, mes?: number}} input — só o que o MODELO controla.
 * @param {{organizacaoId: string, unidadeId: string|null, acesso: object}} contexto — sempre do backend.
 * @param {{obterMes: typeof dashboardExecutivoService.obterMes}} [deps] injeção para teste.
 */
export async function executar(input, { organizacaoId, unidadeId, acesso }, deps = { obterMes: dashboardExecutivoService.obterMes }) {
  garantirAcessoModulo(acesso, MODULOS.IFOOD_DASHBOARD);
  garantirPermissao(acesso, PERMISSOES.DASHBOARD_EXECUTIVO_VER);

  const { ano, mes } = resolverPeriodo(input);

  const dados = await deps.obterMes({
    organizacaoId,
    unidadeIdSessao: unidadeId,
    unidadeIdSolicitado: undefined, // NUNCA do modelo — ver cabeçalho do arquivo.
    ano,
    mes,
  });

  return dados.agregado ? normalizarAgregado(dados) : normalizarUnidade(dados);
}

function normalizarUnidade(d) {
  return {
    visao: "unidade",
    periodo: d.periodo,
    modeloLogistico: d.modeloLogisticoRotulo,
    unidadeDeTeste: d.ehTeste,
    resumoPreenchimento: d.resumoPreenchimento,
    cards: d.cards,
    projecao: d.projecao,
    pendenciasMesesAnteriores: d.pendenciasMesesAnteriores,
  };
}

function normalizarAgregado(d) {
  return {
    visao: "todas_as_unidades",
    aviso: d.aviso,
    periodo: d.periodo,
    cards: d.cards,
  };
}
