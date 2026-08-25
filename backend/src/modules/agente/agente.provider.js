// Única porta de saída para a Anthropic — isola o resto do módulo do SDK.
// O restante do Agente Crescer (service, tools, prompt) não conhece o SDK
// da Anthropic; fala só com `enviarMensagem`. Trocar de provider no futuro
// mexe apenas neste arquivo.
//
// Chave e modelo SEMPRE de variável de ambiente — nunca hardcoded, nunca
// espalhado em outros arquivos (CLAUDE_MODEL é lido só aqui).
import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "../../shared/ApiError.js";

/** Modelo do Agente Crescer — único lugar do código que lê CLAUDE_MODEL. */
export const MODELO = process.env.CLAUDE_MODEL || "claude-opus-5";

// Resposta é uma explicação em texto curto, não código — teto generoso o
// bastante para uma análise completa, sem exagerar (ver claude-api skill:
// "deliberadamente curto" é motivo válido para não usar o default de 16000).
const MAX_TOKENS_RESPOSTA = 4096;

let clienteSingleton = null;
function obterClientePadrao() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw ApiError.internal("Agente Crescer indisponível: ANTHROPIC_API_KEY não configurada no servidor.");
  }
  if (!clienteSingleton) clienteSingleton = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return clienteSingleton;
}

/**
 * @param {{system: string, messages: any[], tools: any[]}} params
 * @param {{cliente?: any}} [deps] injeção para teste — nunca usado em produção.
 * @returns {Promise<import('@anthropic-ai/sdk').default.Message>}
 */
export async function enviarMensagem({ system, messages, tools }, deps = {}) {
  const cliente = deps.cliente ?? obterClientePadrao();
  try {
    const resposta = await cliente.messages.create({
      model: MODELO,
      max_tokens: MAX_TOKENS_RESPOSTA,
      system,
      messages,
      tools,
    });
    return normalizarResposta(resposta);
  } catch (erro) {
    throw mapearErro(erro);
  }
}

/**
 * Normaliza o `usage` da Anthropic para uma estrutura interna independente
 * de provider (camelCase, nomes estáveis) — o resto do módulo (agente.usage.js,
 * agente.pricing.js, SuperAdmin) nunca lê `input_tokens`/`cache_read_input_tokens`
 * direto do SDK. Preparado para, no futuro, outro provider (OpenAI/Google)
 * devolver a mesma forma sem mexer na camada de métricas.
 *
 * Preserva TODOS os campos originais da resposta (`...resposta`) — o loop de
 * tool use em agente.service.js continua lendo `.stop_reason`/`.content`
 * normalmente; só `.usage` e `.model`/`.provider` ganham a forma normalizada.
 * @param {import('@anthropic-ai/sdk').default.Message} resposta
 */
function normalizarResposta(resposta) {
  return {
    ...resposta,
    provider: "anthropic",
    model: resposta.model ?? MODELO,
    usage: {
      inputTokens: resposta.usage?.input_tokens ?? 0,
      outputTokens: resposta.usage?.output_tokens ?? 0,
      cacheCreationTokens: resposta.usage?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: resposta.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

/**
 * Traduz erros da Anthropic para ApiError, sem vazar detalhe técnico ao
 * cliente (a mensagem original vai só para o log do servidor).
 * @param {unknown} erro
 */
export function mapearErro(erro) {
  if (erro instanceof ApiError) return erro;
  if (erro instanceof Anthropic.AuthenticationError) {
    console.error("[agente] falha de autenticação com a Anthropic:", erro.message);
    return ApiError.internal("Agente Crescer indisponível no momento.");
  }
  if (erro instanceof Anthropic.RateLimitError) {
    return new ApiError(503, "Agente Crescer está temporariamente sobrecarregado. Tente novamente em instantes.");
  }
  if (erro instanceof Anthropic.APIConnectionError) {
    return new ApiError(503, "Não foi possível conectar ao serviço de IA. Tente novamente em instantes.");
  }
  if (erro instanceof Anthropic.APIError) {
    console.error("[agente] erro da API Anthropic:", erro.status, erro.message);
    return ApiError.internal("Falha ao consultar o Agente Crescer.");
  }
  console.error("[agente] erro inesperado ao chamar a Anthropic:", erro?.message);
  return ApiError.internal("Falha ao consultar o Agente Crescer.");
}
