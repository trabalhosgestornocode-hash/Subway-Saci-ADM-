// Tool "consultar_parser_resumo" — resumo AGREGADO de cancelamentos/taxas de
// um mês inteiro do Parser Food Delivery.
//
// REGRA DE OURO (código calcula, IA interpreta) — e REGRA ESPECÍFICA DO
// PARSER: a classificação de CADA cancelamento (recebe taxa / não recebe /
// revisar) já foi decidida pelo motor determinístico
// (parserFoodDelivery.classificacao.js) NO MOMENTO DA IMPORTAÇÃO. Esta tool
// nunca reclassifica nada — só soma resumos de importação já calculados
// (parserFoodDelivery.service.js#resumoCancelamentosPeriodo, que só
// considera importações cujo período está TOTALMENTE contido no mês
// pedido — nunca conta parcialmente uma importação que atravessa a virada
// do mês).
import { ApiError } from "../../../shared/ApiError.js";
import { MODULOS } from "../../../shared/modulos.js";
import { PERMISSOES } from "../../../shared/permissoes.js";
import { garantirAcessoModulo, garantirPermissao } from "../agenteAcesso.js";
import * as parserService from "../../parser-food-delivery/parserFoodDelivery.service.js";
import { resolverPeriodo } from "./dashboardExecutivo.tool.js";

export const definicao = {
  name: "consultar_parser_resumo",
  description:
    "Consulta o resumo AGREGADO (do mês inteiro) de cancelamentos e taxas de entregador do Parser Food Delivery da unidade do usuário logado: quantos pedidos foram cancelados, quantos recebem taxa, quantos não recebem, quantos precisam de revisão manual, e o valor das taxas (brutas, descartadas e válidas). Use para perguntas como \"quantos pedidos foram cancelados este mês?\", \"qual o valor das taxas envolvidas?\", \"quantos recebem taxa?\", \"quantos precisam de revisão?\". Só considera importações cujo período está totalmente dentro do mês pedido — nunca reclassifica cancelamentos, só soma o que o motor automático já decidiu em cada importação.",
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
 * @param {{ano?: number, mes?: number}} input — só o que o MODELO controla.
 * @param {{organizacaoId: string, unidadeId: string|null, acesso: object}} contexto — sempre do backend.
 * @param {{resumoCancelamentosPeriodo: typeof parserService.resumoCancelamentosPeriodo}} [deps] injeção para teste.
 */
export async function executar(
  input,
  { organizacaoId, unidadeId, acesso },
  deps = { resumoCancelamentosPeriodo: parserService.resumoCancelamentosPeriodo },
) {
  garantirAcessoModulo(acesso, MODULOS.PARSER_FOOD_DELIVERY);
  garantirPermissao(acesso, PERMISSOES.PARSER_FD_VER);
  if (!unidadeId) {
    throw ApiError.badRequest("Selecione uma unidade para consultar o Parser Food Delivery — a visão consolidada não está disponível para este módulo.");
  }

  const { ano, mes } = resolverPeriodo(input);
  return deps.resumoCancelamentosPeriodo({ organizacaoId, unidadeId, ano, mes });
}
