// Tool "consultar_cancelamento" — explica UM pedido cancelado específico:
// classificação, motivo, nível de confiança, regra aplicada, timeline dos
// eventos e se houve correção manual.
//
// REGRA DE OURO DO PARSER (a mais importante desta tool): a decisão
// (recebe/não recebe/revisar) é SEMPRE do motor determinístico
// (parserFoodDelivery.classificacao.js), calculada no momento da
// importação. Esta tool NUNCA decide nem reclassifica — só busca a
// classificação/timeline já gravados e devolve para Claude explicar em
// linguagem simples.
import { ApiError } from "../../../shared/ApiError.js";
import { MODULOS } from "../../../shared/modulos.js";
import { PERMISSOES } from "../../../shared/permissoes.js";
import { garantirAcessoModulo, garantirPermissao } from "../agenteAcesso.js";
import * as parserService from "../../parser-food-delivery/parserFoodDelivery.service.js";

export const definicao = {
  name: "consultar_cancelamento",
  description:
    "Busca UM pedido cancelado específico pelo número (\"N Pedido\") do Parser Food Delivery e devolve a classificação automática (recebe taxa / não recebe taxa / revisar), o motivo em texto já explicado pelo motor, o nível de confiança, a regra de negócio aplicada, a timeline dos eventos do pedido (despacho/aceite/coleta/chegada/cancelamento) e se houve correção manual posterior. Use para \"por que o pedido #XXXX recebe/não recebe taxa?\" ou \"explique este cancelamento\". Se o mesmo número aparecer em mais de um mês, informe ano/mês para desambiguar — senão a ferramenta devolve os candidatos em vez de escolher um sozinho.",
  input_schema: {
    type: "object",
    properties: {
      numeroPedido: { type: "string", description: "Número do pedido ('N Pedido'), como aparece no relatório — ex.: \"123456\"." },
      ano: { type: "integer", description: "Ano do pedido, só para desambiguar se o número repetir em outro mês." },
      mes: { type: "integer", description: "Mês do pedido (1-12), só para desambiguar se o número repetir em outro mês." },
    },
    required: ["numeroPedido"],
    additionalProperties: false,
  },
};

/**
 * @param {{numeroPedido?: string, ano?: number, mes?: number}} input — só o que o MODELO controla.
 * @param {{organizacaoId: string, unidadeId: string|null, acesso: object}} contexto — sempre do backend.
 * @param {{consultarCancelamento: typeof parserService.consultarCancelamento}} [deps] injeção para teste.
 */
export async function executar(
  input,
  { organizacaoId, unidadeId, acesso },
  deps = { consultarCancelamento: parserService.consultarCancelamento },
) {
  garantirAcessoModulo(acesso, MODULOS.PARSER_FOOD_DELIVERY);
  garantirPermissao(acesso, PERMISSOES.PARSER_FD_VER);
  if (!unidadeId) {
    throw ApiError.badRequest("Selecione uma unidade para consultar o Parser Food Delivery — a visão consolidada não está disponível para este módulo.");
  }

  const numeroPedido = String(input?.numeroPedido ?? "").trim();
  if (!numeroPedido) throw ApiError.badRequest("Informe o número do pedido a consultar.");

  const ano = Number.isInteger(input?.ano) ? input.ano : undefined;
  const mes = Number.isInteger(input?.mes) ? input.mes : undefined;

  return deps.consultarCancelamento({ organizacaoId, unidadeId, numeroPedido, ano, mes });
}
