// Fonte ÚNICA de preços dos modelos da Anthropic — nenhum outro arquivo deve
// ter um `if (model === '...')` de preço. Mudou um preço? Muda só aqui.
//
// PRECIFICAÇÃO CONGELADA NO REGISTRO: cada linha de agente_uso grava
// `estimated_cost_usd` já calculado com a tabela vigente NAQUELE MOMENTO
// (ver PRICING_VERSION abaixo) — mudar um preço aqui nunca recalcula
// registros antigos, só afeta interações novas.
//
// Cache write/read não têm entrada própria na tabela: a Anthropic documenta
// como múltiplos do preço de input (~1,25x escrita, ~0,1x leitura) — derivar
// evita duas fontes de verdade divergindo quando o preço de input mudar.
//
// Simplificação conhecida: preços "intro"/promocionais por tempo limitado
// (quando existirem) não são modelados — usa-se o preço padrão do modelo.
// O que protege contra isso não é acertar o preço exato de uma janela
// promocional, e sim `pricing_version` + histórico nunca recalculado.

/** Identifica qual tabela gerou um `estimated_cost_usd` — bump ao mudar preços. */
export const PRICING_VERSION = "anthropic-2026-06";

const MULTIPLICADOR_CACHE_ESCRITA = 1.25;
const MULTIPLICADOR_CACHE_LEITURA = 0.10;

/** USD por milhão de tokens, preço padrão (não-promocional) de cada modelo. */
const PRECO_BASE_POR_MILHAO_USD = {
  "claude-fable-5": { input: 10.00, output: 50.00 },
  "claude-mythos-5": { input: 10.00, output: 50.00 },
  "claude-opus-5": { input: 5.00, output: 25.00 },
  "claude-opus-4-8": { input: 5.00, output: 25.00 },
  "claude-opus-4-7": { input: 5.00, output: 25.00 },
  "claude-opus-4-6": { input: 5.00, output: 25.00 },
  "claude-sonnet-5": { input: 3.00, output: 15.00 },
  "claude-sonnet-4-6": { input: 3.00, output: 15.00 },
  "claude-haiku-4-5": { input: 1.00, output: 5.00 },
};

/**
 * Preços completos (input/output/cache) de um modelo, ou `null` se
 * desconhecido — nunca inventa um preço para um modelo fora da tabela.
 *
 * Aceita variantes com sufixo de data (ex.: `claude-haiku-4-5-20251001`) —
 * alguém pode configurar CLAUDE_MODEL apontando pra um snapshot fixo em vez
 * do id "corrente" sem data. A API da Anthropic aceita e cobra normalmente
 * por esse id; só a nossa tabela usa os ids sem data. Sem essa normalização,
 * toda interação com um id datado ficaria com custo `null` (não "grátis",
 * mas sem noção nenhuma do gasto real) mesmo sendo, na prática, o MESMO
 * modelo e preço do id base.
 * @param {string} model
 * @returns {{input: number, output: number, cacheWrite: number, cacheRead: number}|null}
 */
export function precosDoModelo(model) {
  const base = PRECO_BASE_POR_MILHAO_USD[model] ?? PRECO_BASE_POR_MILHAO_USD[String(model).replace(/-\d{8}$/, "")];
  if (!base) return null;
  return {
    input: base.input,
    output: base.output,
    cacheWrite: base.input * MULTIPLICADOR_CACHE_ESCRITA,
    cacheRead: base.input * MULTIPLICADOR_CACHE_LEITURA,
  };
}

/**
 * Custo estimado de UMA interação (já somando todas as chamadas à Anthropic
 * que ocorreram para respondê-la — ver agente.usage.js). Sem arredondamento
 * prematuro: devolve o valor decimal completo, quem exibe decide a precisão.
 * @param {{model: string, inputTokens?: number, outputTokens?: number, cacheCreationTokens?: number, cacheReadTokens?: number}} params
 * @returns {{estimatedCostUsd: number|null, pricingVersion: string, precificado: boolean}}
 */
export function calcularCustoUso({ model, inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0 }) {
  const precos = precosDoModelo(model);
  if (!precos) return { estimatedCostUsd: null, pricingVersion: PRICING_VERSION, precificado: false };

  const custo =
    (Number(inputTokens) || 0) / 1_000_000 * precos.input +
    (Number(outputTokens) || 0) / 1_000_000 * precos.output +
    (Number(cacheCreationTokens) || 0) / 1_000_000 * precos.cacheWrite +
    (Number(cacheReadTokens) || 0) / 1_000_000 * precos.cacheRead;

  return { estimatedCostUsd: custo, pricingVersion: PRICING_VERSION, precificado: true };
}
