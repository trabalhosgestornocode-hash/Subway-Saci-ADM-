// Tool "listar_cancelamentos" — lista cancelamentos INDIVIDUAIS de um mês,
// já classificados pelo motor automático, com filtro por classificação e/ou
// nível de confiança.
//
// REGRA DE OURO DO PARSER: nunca reclassifica — só lista o que
// parserFoodDelivery.classificacao.js já decidiu no momento da importação
// (ver parserFoodDelivery.service.js#listarCancelamentosPeriodo).
import { ApiError } from "../../../shared/ApiError.js";
import { MODULOS } from "../../../shared/modulos.js";
import { PERMISSOES } from "../../../shared/permissoes.js";
import { garantirAcessoModulo, garantirPermissao } from "../agenteAcesso.js";
import * as parserService from "../../parser-food-delivery/parserFoodDelivery.service.js";
import { CLASSIFICACAO_CANCELAMENTO, NIVEL_CONFIANCA } from "../../parser-food-delivery/parserFoodDelivery.classificacao.js";
import { resolverPeriodo } from "./dashboardExecutivo.tool.js";

const CLASSIFICACOES_VALIDAS = Object.values(CLASSIFICACAO_CANCELAMENTO);
const NIVEIS_VALIDOS = Object.values(NIVEL_CONFIANCA);

export const definicao = {
  name: "listar_cancelamentos",
  description:
    "Lista os cancelamentos INDIVIDUAIS de um mês do Parser Food Delivery (número do pedido, data/hora, taxa, classificação, motivo, nível de confiança, se há correção manual). Use para perguntas como \"quais cancelamentos precisam da minha atenção?\" (filtre classificacao: \"revisar\"), \"quais cancelamentos têm confiança muito alta?\" (filtre nivelConfianca: \"muito_alta\"), ou para ver a lista completa do mês sem filtro. Por padrão retorna os 15 mais recentes, limitado a 30. A classificação já vem do motor automático — esta ferramenta nunca decide nem reclassifica nada.",
  input_schema: {
    type: "object",
    properties: {
      ano: { type: "integer", description: "Ano de referência (ex.: 2026). Se omitido, usa o ano atual." },
      mes: { type: "integer", description: "Mês de referência, de 1 a 12. Se omitido, usa o mês atual." },
      classificacao: { type: "string", enum: CLASSIFICACOES_VALIDAS, description: "Filtra pela classificação automática. Omitir para todas." },
      nivelConfianca: { type: "string", enum: NIVEIS_VALIDOS, description: "Filtra pelo nível de confiança da classificação. Omitir para todos." },
      limite: { type: "integer", description: "Quantos cancelamentos retornar (máximo 30). Padrão: 15." },
    },
    additionalProperties: false,
  },
};

/**
 * @param {{ano?: number, mes?: number, classificacao?: string, nivelConfianca?: string, limite?: number}} input
 * @param {{organizacaoId: string, unidadeId: string|null, acesso: object}} contexto
 * @param {{listarCancelamentosPeriodo: typeof parserService.listarCancelamentosPeriodo}} [deps] injeção para teste.
 */
export async function executar(
  input,
  { organizacaoId, unidadeId, acesso },
  deps = { listarCancelamentosPeriodo: parserService.listarCancelamentosPeriodo },
) {
  garantirAcessoModulo(acesso, MODULOS.PARSER_FOOD_DELIVERY);
  garantirPermissao(acesso, PERMISSOES.PARSER_FD_VER);
  if (!unidadeId) {
    throw ApiError.badRequest("Selecione uma unidade para consultar o Parser Food Delivery — a visão consolidada não está disponível para este módulo.");
  }

  const { ano, mes } = resolverPeriodo(input);
  const classificacao = CLASSIFICACOES_VALIDAS.includes(input?.classificacao) ? input.classificacao : undefined;
  const nivelConfianca = NIVEIS_VALIDOS.includes(input?.nivelConfianca) ? input.nivelConfianca : undefined;

  return deps.listarCancelamentosPeriodo({ organizacaoId, unidadeId, ano, mes, classificacao, nivelConfianca, limite: input?.limite });
}
