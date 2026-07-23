// Descoberta do pedido corrente da unidade.
//
// Regra dura: o orderId SEMPRE vem do findProxPedidoV2. Nunca é fixado em
// código, nem em .env, nem reaproveitado de uma sincronização anterior — o
// ultimo_order_id gravado é histórico, não fonte de verdade.

import { getCurrentOrder } from "./martinbrower.api.client.js";
import { normalizarPedido } from "./martinbrower.normalizer.js";
import { mbErro, MB_ERROS } from "./martinbrower.errors.js";
import { mbLog, mascararClientId } from "./martinbrower.logsafe.js";

/**
 * @returns {{orderId, janelaInicio, janelaFinal, consultadoEm, financialRestriction, percBruto}}
 * @throws MARTIN_BROWER_ORDER_NOT_FOUND quando não há pedido disponível
 */
export async function descobrirPedidoAtual({ clientId, sessao, sinal }) {
  const payload = await getCurrentOrder(clientId, sessao, { sinal });
  const pedido = normalizarPedido(payload);

  // Restrição financeira é registrada e exibida, mas NÃO impede a coleta do
  // catálogo por si só: só bloqueia quando não há pedido junto com ela.
  if (pedido.financialRestriction) {
    mbLog("warn", "pedido.restricao_financeira", {
      clientId: mascararClientId(clientId), restricao: pedido.financialRestriction,
    });
  }

  if (!pedido.orderId) {
    if (pedido.financialRestriction) {
      throw mbErro(MB_ERROS.MARTIN_BROWER_FINANCIAL_RESTRICTION, {
        detalhes: { restricao: pedido.financialRestriction },
      });
    }
    throw mbErro(MB_ERROS.MARTIN_BROWER_ORDER_NOT_FOUND);
  }

  mbLog("info", "pedido.encontrado", {
    clientId: mascararClientId(clientId), orderId: pedido.orderId,
    janelaInicio: pedido.janelaInicio, janelaFinal: pedido.janelaFinal,
  });

  return pedido;
}
