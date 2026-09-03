// Persistência e leitura das métricas de uso/custo do Agente Crescer
// (agente_uso, migration 049). Uma linha por interação (mensagem do
// usuário) — o loop de tool use já soma tudo antes de chegar aqui
// (ver agente.usage.js/agente.service.js).
//
// NUNCA derruba a requisição por causa de métrica — mesmo espírito de
// shared/auditoria.js#auditar: registrar uso é observabilidade, não uma
// operação de negócio; falhar aqui não pode impedir a resposta do agente.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

/**
 * @param {{
 *   conversaId: string|null, usuarioId: string|null, organizacaoId: string, unidadeId: string|null,
 *   provider: string, model: string, pricingVersion: string,
 *   inputTokens: number, outputTokens: number, cacheCreationTokens: number, cacheReadTokens: number,
 *   estimatedCostUsd: number|null,
 *   toolCallsCount: number, toolsUsed: string[],
 *   durationMs: number, success: boolean, errorCode?: string|null,
 * }} params
 */
export async function registrarUso(params) {
  try {
    const { error } = await supabase.from("agente_uso").insert({
      conversa_id: params.conversaId ?? null,
      usuario_id: params.usuarioId ?? null,
      organizacao_id: params.organizacaoId,
      unidade_id: params.unidadeId ?? null,
      provider: params.provider,
      model: params.model,
      pricing_version: params.pricingVersion,
      input_tokens: params.inputTokens ?? 0,
      output_tokens: params.outputTokens ?? 0,
      cache_creation_tokens: params.cacheCreationTokens ?? 0,
      cache_read_tokens: params.cacheReadTokens ?? 0,
      estimated_cost_usd: params.estimatedCostUsd,
      tool_calls_count: params.toolCallsCount ?? 0,
      tools_used: params.toolsUsed ?? [],
      duration_ms: params.durationMs,
      success: params.success,
      error_code: params.errorCode ?? null,
    });
    if (error) console.error("[agente] falha ao registrar uso:", error.message);
  } catch (e) {
    console.error("[agente] exceção ao registrar uso:", e?.message);
  }
}

// ---------------------------------------------------------------------------
// LEITURA / AGREGAÇÃO (consumida pelo SuperAdmin — ver plataforma.agenteUso.service.js)
// ---------------------------------------------------------------------------

/**
 * Resolve um filtro de período em {desde, ate} ISO. `periodo` desconhecido
 * ou ausente cai em "este_mes" — nunca devolve um período vazio por engano.
 * @param {{periodo?: string, desde?: string, ate?: string}} filtro
 */
export function intervaloDoFiltro({ periodo, desde, ate } = {}) {
  const agora = new Date();
  const inicioDoDiaUtc = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  const inicioDoMesUtc = (ano, mes) => new Date(Date.UTC(ano, mes, 1)).toISOString();

  if (periodo === "hoje") return { desde: inicioDoDiaUtc(agora), ate: agora.toISOString() };
  if (periodo === "mes_anterior") {
    return {
      desde: inicioDoMesUtc(agora.getUTCFullYear(), agora.getUTCMonth() - 1),
      ate: inicioDoMesUtc(agora.getUTCFullYear(), agora.getUTCMonth()),
    };
  }
  if (periodo === "personalizado" && desde && ate) {
    return { desde: new Date(desde).toISOString(), ate: new Date(ate).toISOString() };
  }
  // "este_mes" (default)
  return { desde: inicioDoMesUtc(agora.getUTCFullYear(), agora.getUTCMonth()), ate: agora.toISOString() };
}

/**
 * Linhas cruas de agente_uso no período, opcionalmente restritas a uma
 * organização. Colunas mínimas — a agregação acontece em JS (ver funções
 * abaixo), mesmo padrão de obterMesAgregado em dashboardExecutivo.service.js.
 * @param {{periodo?: string, desde?: string, ate?: string, organizacaoId?: string}} [filtro]
 */
export async function buscarUsoNoPeriodo(filtro = {}) {
  const intervalo = intervaloDoFiltro(filtro);
  let query = supabase.from("agente_uso")
    .select("organizacao_id, unidade_id, usuario_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, estimated_cost_usd, success, created_at")
    .gte("created_at", intervalo.desde).lte("created_at", intervalo.ate);
  if (filtro.organizacaoId) query = query.eq("organizacao_id", filtro.organizacaoId);

  const { data, error } = await query;
  if (error) throw ApiError.internal(error.message);
  return { linhas: data ?? [], intervalo };
}

/**
 * Conta interações do Agente de UMA organização desde um instante — a base do
 * teto por organização (proteção financeira, P0.5). Usa COUNT no servidor
 * (head: true), sem transferir linhas. Nunca lança: falha aqui devolve `null`
 * e o chamador decide (fail-open — a 1ª camada por conta já protege).
 * @param {{organizacaoId: string, desdeIso: string}} p
 * @returns {Promise<number|null>}
 */
export async function contarInteracoesDaOrganizacao({ organizacaoId, desdeIso }) {
  try {
    const { count, error } = await supabase.from("agente_uso")
      .select("id", { count: "exact", head: true })
      .eq("organizacao_id", organizacaoId)
      .gte("created_at", desdeIso);
    if (error) { console.error("[agente] contagem de uso da org falhou:", error.message); return null; }
    return count ?? 0;
  } catch (e) {
    console.error("[agente] excecao ao contar uso da org:", e?.message);
    return null;
  }
}

const somarNum = (linhas, campo) => linhas.reduce((s, l) => s + (Number(l[campo]) || 0), 0);
const somarCusto = (linhas) => linhas.reduce((s, l) => s + (l.estimated_cost_usd != null ? Number(l.estimated_cost_usd) : 0), 0);

/**
 * Resumo agregado (KPIs) de um conjunto de linhas — pura, testável sem banco.
 * @param {any[]} linhas
 */
export function agregarResumo(linhas) {
  const interacoes = linhas.length;
  const custoEstimadoUsd = somarCusto(linhas);
  return {
    interacoes,
    inputTokens: somarNum(linhas, "input_tokens"),
    outputTokens: somarNum(linhas, "output_tokens"),
    cacheCreationTokens: somarNum(linhas, "cache_creation_tokens"),
    cacheReadTokens: somarNum(linhas, "cache_read_tokens"),
    custoEstimadoUsd,
    custoMedioUsd: interacoes ? custoEstimadoUsd / interacoes : null,
    falhas: linhas.filter((l) => l.success === false).length,
  };
}

/**
 * Agregação por organização — usuários/unidades contados por DISTINCT, não
 * por linha (uma organização com 200 interações do mesmo usuário tem 1
 * "usuário ativo", não 200). Ordenado por custo desc (o mais caro primeiro
 * é o que mais importa pro SuperAdmin decidir precificação).
 * @param {any[]} linhas
 */
export function agregarPorOrganizacao(linhas) {
  const porOrg = new Map();
  for (const l of linhas) {
    const chave = l.organizacao_id;
    if (!chave) continue;
    if (!porOrg.has(chave)) {
      porOrg.set(chave, { organizacaoId: chave, interacoes: 0, inputTokens: 0, outputTokens: 0, custoEstimadoUsd: 0, usuarios: new Set(), unidades: new Set() });
    }
    const acc = porOrg.get(chave);
    acc.interacoes += 1;
    acc.inputTokens += Number(l.input_tokens) || 0;
    acc.outputTokens += Number(l.output_tokens) || 0;
    if (l.estimated_cost_usd != null) acc.custoEstimadoUsd += Number(l.estimated_cost_usd);
    if (l.usuario_id) acc.usuarios.add(l.usuario_id);
    if (l.unidade_id) acc.unidades.add(l.unidade_id);
  }
  return [...porOrg.values()]
    .map((a) => ({
      organizacaoId: a.organizacaoId, interacoes: a.interacoes, inputTokens: a.inputTokens, outputTokens: a.outputTokens,
      custoEstimadoUsd: a.custoEstimadoUsd, usuariosAtivos: a.usuarios.size, unidadesAtivas: a.unidades.size,
    }))
    .sort((a, b) => b.custoEstimadoUsd - a.custoEstimadoUsd);
}

/**
 * Agregação por modelo — preparado para múltiplos modelos/providers
 * coexistirem sem mudar a forma do retorno.
 * @param {any[]} linhas
 */
export function agregarPorModelo(linhas) {
  const porModelo = new Map();
  for (const l of linhas) {
    const chave = l.model ?? "desconhecido";
    if (!porModelo.has(chave)) porModelo.set(chave, { model: chave, interacoes: 0, inputTokens: 0, outputTokens: 0, custoEstimadoUsd: 0 });
    const acc = porModelo.get(chave);
    acc.interacoes += 1;
    acc.inputTokens += Number(l.input_tokens) || 0;
    acc.outputTokens += Number(l.output_tokens) || 0;
    if (l.estimated_cost_usd != null) acc.custoEstimadoUsd += Number(l.estimated_cost_usd);
  }
  return [...porModelo.values()].sort((a, b) => b.custoEstimadoUsd - a.custoEstimadoUsd);
}
