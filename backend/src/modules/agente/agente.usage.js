// Acumulação PURA de usage (tokens) ao longo do loop de tool use.
//
// Uma interação do usuário pode envolver várias chamadas à Anthropic (uma
// por iteração do loop, ver agente.service.js). O custo/uso real da
// interação é a SOMA de todas elas, nunca só a última — este arquivo é a
// fonte única desse somatório, para poder ser testado isoladamente.

/** @returns {{inputTokens: number, outputTokens: number, cacheCreationTokens: number, cacheReadTokens: number}} */
export function usageVazio() {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

/**
 * Soma um usage parcial (de UMA chamada à Anthropic) ao total acumulado.
 * Campo ausente/undefined conta como 0 — nunca derruba o acúmulo por causa
 * de um campo opcional que o provider não devolveu.
 * @param {ReturnType<typeof usageVazio>} total
 * @param {Partial<ReturnType<typeof usageVazio>>|undefined} parcial
 * @returns {ReturnType<typeof usageVazio>} novo objeto — não muta `total`
 */
export function acumularUsage(total, parcial) {
  return {
    inputTokens: total.inputTokens + (parcial?.inputTokens ?? 0),
    outputTokens: total.outputTokens + (parcial?.outputTokens ?? 0),
    cacheCreationTokens: total.cacheCreationTokens + (parcial?.cacheCreationTokens ?? 0),
    cacheReadTokens: total.cacheReadTokens + (parcial?.cacheReadTokens ?? 0),
  };
}
