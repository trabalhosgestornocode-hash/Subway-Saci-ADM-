// Guarda de acesso para as TOOLS do Agente Crescer.
//
// Por que isto existe: a rota /agente passa por requireModulo(AGENTE_IA),
// mas isso só garante que a empresa contratou o AGENTE em si. Uma tool que
// consulta dados de OUTRO módulo (ex.: Dashboard Executivo) precisa validar
// esse outro módulo por conta própria antes de tocar no service dele —
// senão o Agente vira um jeito de contornar um módulo não contratado.
//
// Mesma regra de bypass de requireModulo/requirePermissao (middlewares/auth.js):
// superadmin em impersonação passa por qualquer módulo/permissão — ele entrou
// para dar suporte, e a rastreabilidade é a auditoria, não um bloqueio aqui.

import { ApiError } from "../../shared/ApiError.js";
import { rotuloModulo } from "../../shared/modulos.js";
import { temPermissao } from "../../shared/permissoes.js";

/**
 * @param {import('../../middlewares/auth.js').AcessoContexto|undefined} acesso
 * @param {string} moduloId
 */
export function garantirAcessoModulo(acesso, moduloId) {
  if (!acesso) throw ApiError.forbidden("Contexto de empresa não definido.");
  if (acesso.impersonando) return;
  if (!acesso.modulos.includes(moduloId)) {
    throw ApiError.forbidden(`Módulo "${rotuloModulo(moduloId)}" não contratado por esta empresa.`);
  }
}

/**
 * @param {import('../../middlewares/auth.js').AcessoContexto|undefined} acesso
 * @param {string} permissao
 */
export function garantirPermissao(acesso, permissao) {
  if (!acesso) throw ApiError.forbidden("Contexto de empresa não definido.");
  if (acesso.impersonando) return;
  if (!temPermissao(acesso.permissoes, permissao)) {
    throw ApiError.forbidden("Permissão insuficiente para esta ação.");
  }
}
