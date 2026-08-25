// Tool "sugerir_navegacao" — Etapa F.1. Única forma pela qual uma resposta
// do Agente Crescer pode carregar uma "action" de navegação.
//
// REGRA DE OURO: Claude escolhe uma INTENÇÃO (`target`, de um enum fechado)
// — nunca uma URL, nunca uma rota livre. Todo o resto (se o usuário tem
// acesso ao destino, o rótulo do botão, quais parâmetros sobrevivem) é
// decidido por agente.acoes.js, nunca por este arquivo nem pelo modelo.
//
// NUNCA um erro "duro": destino sem acesso, target desconhecido ou parâmetro
// obrigatório ausente viram `{ sugerida: false }` — o mesmo que "não
// sugerir nada". Isso é esperado (Claude pode tentar sugerir algo que o
// usuário não tem acesso sem saber disso de antemão) — não é uma falha.
import { ACOES_NAVEGACAO, TARGETS_VALIDOS, resolverAcao } from "../agente.acoes.js";

export const definicao = {
  name: "sugerir_navegacao",
  description:
    "Sugere ao usuário um atalho de navegação para uma área específica do Crescer com Delivery relacionada à sua análise. Use SÓ quando genuinamente ajudar a continuar a investigação (ex.: depois de identificar cancelamentos que precisam de revisão, sugerir abrir a tela de Cancelamentos) — nunca é obrigatório, a maioria das respostas não precisa disso. Isto é SOMENTE navegação — nunca uma ação de escrita, nunca altera nada. Não sugira uma tela em que o usuário já está (verifique o contexto atual da tela antes de chamar esta ferramenta).",
  input_schema: {
    type: "object",
    properties: {
      target: {
        type: "string", enum: TARGETS_VALIDOS,
        description: "Destino da navegação. Use 'product_detail' com productName pra abrir um produto específico, 'ingredient_detail' com ingredientName pra um insumo específico, 'parser_order' com orderNumber pra um pedido específico — os demais targets não usam parâmetro.",
      },
      productName: { type: "string", description: "Nome do produto — só junto de target='product_detail'." },
      ingredientName: { type: "string", description: "Nome do insumo — só junto de target='ingredient_detail'." },
      orderNumber: { type: "string", description: "Número do pedido ('N Pedido') — só junto de target='parser_order'." },
    },
    required: ["target"],
    additionalProperties: false,
  },
};

/**
 * @param {{target?: string, productName?: string, ingredientName?: string, orderNumber?: string}} input — só o que o MODELO controla.
 * @param {{acesso: object}} contexto — sempre do backend.
 */
export async function executar(input, { acesso }) {
  const params = { productName: input?.productName, ingredientName: input?.ingredientName, orderNumber: input?.orderNumber };
  const acao = resolverAcao({ target: input?.target, params, acesso });
  return acao ? { sugerida: true, action: acao } : { sugerida: false };
}

// Exportado só por conveniência de teste/documentação (o catálogo de acesso
// já é reexportado por agente.acoes.js — nada aqui precisa dele em si).
export { ACOES_NAVEGACAO };
