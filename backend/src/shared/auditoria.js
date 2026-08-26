// Registro de auditoria da plataforma.
//
// REGRA DE OURO: auditar NUNCA derruba a operação. Se o insert falhar, a ação
// do usuário segue em frente e o erro vai para o log do servidor. O contrário
// (perder um bloqueio de empresa porque a auditoria piscou) seria pior.
//
// A imutabilidade não é imposta aqui, e sim no banco: a migration 020 instala
// triggers que recusam UPDATE/DELETE/TRUNCATE em plataforma_auditoria — vale
// inclusive para o service_role que este backend usa.

import { supabase } from "../config/supabase.js";

/** Ações canônicas. Use estas constantes em vez de string solta. */
export const ACOES = {
  // sessão
  LOGIN: "sessao.login",
  LOGOUT: "sessao.logout",
  CONTEXTO_SELECIONADO: "sessao.contexto_selecionado",
  CONTEXTO_TROCADO: "sessao.contexto_trocado",
  LOGIN_NEGADO: "sessao.login_negado",
  SENHA_DEFINIDA: "sessao.senha_definida",

  // impersonação
  IMPERSONAR_INICIO: "impersonacao.iniciada",
  IMPERSONAR_FIM: "impersonacao.encerrada",

  // empresas
  EMPRESA_CRIADA: "empresa.criada",
  EMPRESA_EDITADA: "empresa.editada",
  EMPRESA_STATUS: "empresa.status_alterado",
  EMPRESA_PLANO: "empresa.plano_alterado",
  EMPRESA_EXCLUIDA: "empresa.excluida",
  EMPRESA_MODULO_HABILITADO: "empresa.modulo_habilitado",
  EMPRESA_MODULO_DESABILITADO: "empresa.modulo_desabilitado",
  EMPRESA_MODELO_CLONADO: "empresa.modelo_clonado",

  // unidades
  UNIDADE_CRIADA: "unidade.criada",
  UNIDADE_EDITADA: "unidade.editada",
  UNIDADE_STATUS: "unidade.status_alterado",
  UNIDADE_MODULO_HABILITADO: "unidade.modulo_habilitado",
  UNIDADE_MODULO_DESABILITADO: "unidade.modulo_desabilitado",
  UNIDADE_EXCLUIDA: "unidade.excluida",
  // Troca da tabela comercial OFICIAL (balcão/iFood) — nunca gravada por
  // "modo de comparação" (isso é só estado de frontend). Ver migration 051
  // (unidade_tabela_comercial_historico), onde o antes/depois fica gravado
  // junto — esta linha em plataforma_auditoria é o espelho geral.
  UNIDADE_TABELA_COMERCIAL_ALTERADA: "unidade.tabela_comercial_alterada",
  // Estrutura organizacional (Fase D) — as ações em si são gravadas DENTRO
  // das funções PL/pgSQL da migration 053 (mesma transação da mudança),
  // não por auditar()/auditarReq(). Estas constantes existem para o
  // frontend/backend terem uma fonte única do texto exato da ação ao
  // filtrar/rotular a auditoria (ver adminUi.js e listarLogsDaUnidade).
  UNIDADE_PROMOVIDA_EMPRESA: "unidade.promovida_para_empresa",
  UNIDADE_TRANSFERIDA: "unidade.transferida_entre_empresas",
  EMPRESA_CONVERTIDA_UNIDADE: "empresa.convertida_para_unidade",

  // usuários e vínculos
  USUARIO_CRIADO: "usuario.criado",
  USUARIO_EDITADO: "usuario.editado",
  USUARIO_BLOQUEADO: "usuario.bloqueado",
  USUARIO_SENHA_REDEFINIDA: "usuario.senha_redefinida",
  USUARIO_EMAIL_ALTERADO: "usuario.email_alterado",
  USUARIO_LOGOUT_FORCADO: "usuario.logout_forcado",
  USUARIO_EXCLUIDO: "usuario.excluido",
  VINCULO_CRIADO: "vinculo.criado",
  VINCULO_EDITADO: "vinculo.editado",
  VINCULO_REMOVIDO: "vinculo.removido",

  // configuração global
  CONFIG_ALTERADA: "config.alterada",

  // Bonificação Mensal
  BONIFICACAO_META_ALTERADA: "bonificacao_mensal.meta_alterada",
  BONIFICACAO_INDICADOR_LANCADO: "bonificacao_mensal.indicador_lancado",

  // Agente Crescer (assistente de IA) — uma linha por mensagem processada,
  // sucesso ou erro (ver detalhes.sucesso). Nunca grava o texto da mensagem
  // nem da resposta, só metadados de uso (ver agente/agente.service.js).
  AGENTE_MENSAGEM_ENVIADA: "agente.mensagem_enviada",
};

/**
 * @typedef {object} EntradaAuditoria
 * @property {string|null} [atorId]
 * @property {string|null} [atorEmail]
 * @property {'usuario'|'superadmin'|'sistema'} [atorTipo]
 * @property {string} acao
 * @property {string|null} [entidade]
 * @property {string|null} [entidadeId]
 * @property {string|null} [organizacaoId]
 * @property {string|null} [impersonadoPor]
 * @property {Record<string, unknown>} [detalhes]
 * @property {string|null} [ip]
 * @property {string|null} [userAgent]
 */

/**
 * Grava uma entrada de auditoria. Não lança.
 * @param {EntradaAuditoria} entrada
 * @returns {Promise<void>}
 */
export async function auditar(entrada) {
  try {
    const { error } = await supabase.from("plataforma_auditoria").insert({
      ator_id: entrada.atorId ?? null,
      ator_email: entrada.atorEmail ?? null,
      ator_tipo: entrada.atorTipo ?? "usuario",
      acao: entrada.acao,
      entidade: entrada.entidade ?? null,
      entidade_id: entrada.entidadeId != null ? String(entrada.entidadeId) : null,
      organizacao_id: entrada.organizacaoId ?? null,
      impersonado_por: entrada.impersonadoPor ?? null,
      detalhes: entrada.detalhes ?? {},
      ip: entrada.ip ?? null,
      user_agent: entrada.userAgent ?? null,
    });
    if (error) console.error("[auditoria] falha ao registrar:", entrada.acao, error.message);
  } catch (e) {
    console.error("[auditoria] exceção ao registrar:", entrada.acao, e?.message);
  }
}

/**
 * Extrai ator + origem da requisição para não repetir isso em cada controller.
 * Já resolve o caso da impersonação: o ator é quem está operando (o usuário
 * "de dentro" da empresa) e `impersonadoPor` diz quem realmente estava ali.
 * @param {import('express').Request & {user?: any, acesso?: any, tenant?: any}} req
 * @returns {Partial<EntradaAuditoria>}
 */
export function contextoDaRequisicao(req) {
  const encaminhado = req.headers?.["x-forwarded-for"];
  const ip = (Array.isArray(encaminhado) ? encaminhado[0] : encaminhado)?.split(",")[0]?.trim()
    || req.socket?.remoteAddress || null;
  return {
    atorId: req.user?.id ?? null,
    atorEmail: req.user?.email ?? null,
    atorTipo: req.user?.superadmin ? "superadmin" : "usuario",
    organizacaoId: req.tenant?.organizacaoId ?? null,
    impersonadoPor: req.acesso?.impersonadoPor ?? null,
    ip,
    userAgent: req.header?.("user-agent") ?? null,
  };
}

/**
 * Açúcar: `auditar` já preenchido com o contexto da requisição.
 * @param {import('express').Request} req
 * @param {EntradaAuditoria} entrada
 */
export function auditarReq(req, entrada) {
  return auditar({ ...contextoDaRequisicao(req), ...entrada });
}
