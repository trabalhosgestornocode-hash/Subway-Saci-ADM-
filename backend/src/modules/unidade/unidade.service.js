// Configuração da PRÓPRIA unidade, pelo tenant (organization_admin com
// `configuracoes.gerenciar`) — espelha o mesmo dado que o SuperAdmin já edita
// em plataforma.unidades.service.js#atualizarUnidade, mas escopado por
// `req.tenant` (nunca aceita unidadeId vindo do corpo/query: só a unidade do
// Context Token da própria sessão pode ser alterada por aqui).
//
// Por enquanto só cobre TABELAS COMERCIAIS (balcão/iFood) — é o que o pedido
// original pede para corrigir nesta fase. Outros campos de "Dados da
// Unidade" (endereço, telefone...) continuam só no SuperAdmin até virarem
// necessidade real (ver configuracoes.js — aquela tela hoje é decorativa
// para a maior parte das seções, isto aqui é o começo de torná-la real).
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { auditarReq, ACOES } from "../../shared/auditoria.js";
import { resolverTabelasComerciaisUnidade, normalizarCanalTabela } from "../../shared/tabelaComercial.js";

/**
 * Tabela comercial oficial da unidade (balcão + iFood) — a mesma fonte que
 * Dashboard/Produtos-CMV usam, exposta para a tela de Configurações mostrar
 * ANTES de qualquer edição.
 * @param {{unidadeId: string|null}} p
 */
export async function obterTabelasComerciais({ unidadeId }) {
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para ver as tabelas comerciais.");
  return resolverTabelasComerciaisUnidade({ unidadeId });
}

/**
 * Troca REAL da tabela oficial de um canal. Nunca confundir com "modo de
 * comparação" das telas (isso não grava nada — é estado só de frontend).
 * @param {import('express').Request} req
 * @param {{canal?: string, novaTabela?: string, motivo?: string}} body
 */
export async function alterarTabelaComercial(req, body) {
  const { unidadeId, organizacaoId } = req.tenant ?? {};
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para alterar sua tabela comercial.");

  if (!["balcao", "ifood"].includes(body?.canal)) throw ApiError.badRequest("Canal inválido — use 'balcao' ou 'ifood'.");
  const canal = normalizarCanalTabela(body.canal);
  const novaTabela = v.texto(body?.novaTabela, "Nova tabela", { max: 20 });
  const motivo = v.textoOpcional(body?.motivo, "Motivo", { max: 300 });
  const coluna = canal === "ifood" ? "tabela_ifood" : "tabela_balcao";

  const { data: antes, error: erroAntes } = await supabase
    .from("unidades").select(`id, nome, ${coluna}`).eq("id", unidadeId).eq("organizacao_id", organizacaoId).maybeSingle();
  if (erroAntes) throw ApiError.internal(erroAntes.message);
  if (!antes) throw ApiError.notFound("Unidade não encontrada.");

  const tabelaAnterior = antes[coluna] ?? null;
  if (tabelaAnterior === novaTabela) {
    return { canal, tabelaAnterior, tabelaNova: novaTabela, alterado: false };
  }

  const { error: erroUpdate } = await supabase.from("unidades").update({ [coluna]: novaTabela }).eq("id", unidadeId);
  if (erroUpdate) throw ApiError.internal(erroUpdate.message);

  // Histórico dedicado (migration 051) — guarda o antes/depois; a linha em
  // plataforma_auditoria abaixo é o espelho geral (mesmo padrão de
  // unidade_modelo_logistico_historico / migration 024).
  const { error: erroHistorico } = await supabase.from("unidade_tabela_comercial_historico").insert({
    unidade_id: unidadeId, organizacao_id: organizacaoId, canal,
    tabela_anterior: tabelaAnterior, tabela_nova: novaTabela,
    usuario_id: req.user?.id ?? null, usuario_nome: req.user?.nome ?? null, usuario_email: req.user?.email ?? null,
    origem: "tenant", motivo,
  });
  if (erroHistorico) console.error("[unidade] falha ao gravar histórico de tabela comercial:", erroHistorico.message);

  await auditarReq(req, {
    acao: ACOES.UNIDADE_TABELA_COMERCIAL_ALTERADA,
    entidade: "unidade", entidadeId: unidadeId,
    detalhes: { unidade: antes.nome, canal, tabelaAnterior, tabelaNova: novaTabela, motivo: motivo ?? undefined },
  });

  return { canal, tabelaAnterior, tabelaNova: novaTabela, alterado: true };
}
