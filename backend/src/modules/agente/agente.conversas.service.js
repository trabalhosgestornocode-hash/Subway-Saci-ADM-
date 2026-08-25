// Persistência do histórico conversacional do Agente Crescer (Fase 1.5).
//
// Memória CURTA e desta conversa só — nada de embeddings/vector DB/RAG/
// resumo semântico/memória entre empresas. É literalmente "as últimas N
// mensagens desta conversa" (ver HISTORICO_MAX_MENSAGENS).
//
// ISOLAMENTO: `buscarConversa` NUNCA busca só pelo id — sempre usuario_id +
// organizacao_id + unidade_id juntos (ver migration 048). Um conversationId
// de outro tenant simplesmente não é encontrado; o chamador (agente.service.js)
// trata "não encontrado" e "não pertence a este tenant" exatamente da mesma
// forma (cria uma conversa nova), sem revelar a diferença ao cliente.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

// `acoes` é da migration 050 (Etapa F.1) — se ainda não rodou no ambiente,
// degrada graciosamente (mesmo padrão de insumos.service.js#RE_COLUNA_AUSENTE):
// lê sem a coluna, grava sem a coluna, nunca derruba a conversa por causa disso.
const RE_COLUNA_AUSENTE = /does not exist|schema cache|could not find/i;

/** Quantas mensagens (usuário + agente) entram no contexto enviado a Claude. Configurável — ver .env.example. */
export const HISTORICO_MAX_MENSAGENS = Number(process.env.AGENTE_HISTORICO_MAX_MENSAGENS) || 12;

/** Quantas mensagens o GET de histórico devolve para reconstruir a tela (pode ser maior que o limite enviado a Claude). */
const HISTORICO_MAX_EXIBICAO = 100;

/**
 * @param {{conversaId: string|null|undefined, usuarioId: string|null, organizacaoId: string, unidadeId: string|null}} params
 * @returns {Promise<{id: string}|null>}
 */
export async function buscarConversa({ conversaId, usuarioId, organizacaoId, unidadeId }) {
  if (!conversaId) return null;
  let query = supabase.from("agente_conversas").select("id")
    .eq("id", conversaId).eq("organizacao_id", organizacaoId);
  query = usuarioId ? query.eq("usuario_id", usuarioId) : query.is("usuario_id", null);
  query = unidadeId ? query.eq("unidade_id", unidadeId) : query.is("unidade_id", null);
  const { data, error } = await query.maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data ?? null;
}

/**
 * @param {{usuarioId: string|null, organizacaoId: string, unidadeId: string|null}} params
 * @returns {Promise<string>} id da conversa criada
 */
export async function criarConversa({ usuarioId, organizacaoId, unidadeId }) {
  const { data, error } = await supabase.from("agente_conversas")
    .insert({ usuario_id: usuarioId ?? null, organizacao_id: organizacaoId, unidade_id: unidadeId ?? null })
    .select("id").single();
  if (error) throw ApiError.internal(error.message);
  return data.id;
}

/**
 * Mensagens de uma conversa, em ordem cronológica (mais antiga primeiro).
 * @param {string} conversaId
 * @param {number} [limite]
 * @returns {Promise<Array<{papel: 'user'|'assistant', conteudo: string, toolsUtilizadas: string[], acoes: object[], criadoEm: string}>>}
 */
export async function buscarMensagens(conversaId, limite = HISTORICO_MAX_EXIBICAO) {
  let res = await supabase.from("agente_mensagens")
    .select("papel, conteudo, tools_utilizadas, acoes, criado_em")
    .eq("conversa_id", conversaId).order("criado_em", { ascending: false }).limit(limite);
  if (res.error && RE_COLUNA_AUSENTE.test(res.error.message)) {
    res = await supabase.from("agente_mensagens")
      .select("papel, conteudo, tools_utilizadas, criado_em")
      .eq("conversa_id", conversaId).order("criado_em", { ascending: false }).limit(limite);
  }
  if (res.error) throw ApiError.internal(res.error.message);
  return (res.data ?? []).reverse().map((m) => ({
    papel: m.papel, conteudo: m.conteudo, toolsUtilizadas: m.tools_utilizadas ?? [], acoes: m.acoes ?? [], criadoEm: m.criado_em,
  }));
}

/**
 * Grava um turno (usuário ou agente) e toca `atualizado_em` da conversa —
 * mesmo espírito do heartbeat de sessão em middlewares/auth.js, mas aqui
 * bloqueante: é uma escrita real de dado, não telemetria descartável.
 *
 * `acoes` (Etapa F.1, migration 050) — só em mensagens 'assistant', pra elas
 * reaparecerem ao reidratar a conversa (F5). NUNCA é fonte de autorização: é
 * só o que foi sugerido NAQUELE momento — clicar numa action antiga sempre
 * revalida módulo/permissão atuais no frontend/router, nunca confia nisto.
 * @param {{conversaId: string, papel: 'user'|'assistant', conteudo: string, toolsUtilizadas?: string[], acoes?: object[]}} params
 */
export async function salvarMensagem({ conversaId, papel, conteudo, toolsUtilizadas = [], acoes = [] }) {
  const linha = { conversa_id: conversaId, papel, conteudo, tools_utilizadas: toolsUtilizadas, acoes };
  let res = await supabase.from("agente_mensagens").insert(linha);
  if (res.error && RE_COLUNA_AUSENTE.test(res.error.message)) {
    const { acoes: _semAcoes, ...semColunaNova } = linha;
    res = await supabase.from("agente_mensagens").insert(semColunaNova);
  }
  if (res.error) throw ApiError.internal(res.error.message);
  await supabase.from("agente_conversas").update({ atualizado_em: new Date().toISOString() }).eq("id", conversaId);
}
