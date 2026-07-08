import { supabase } from "../config/supabase.js";
import { ApiError } from "../shared/ApiError.js";

// Autenticação real: valida o JWT do Supabase, carrega o perfil e checa se está ativo.
// O tenant (organização/unidade) vem do PERFIL autenticado — nunca de headers do cliente.
export async function requireAuth(req, _res, next) {
  try {
    const header = req.header("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!token) return next(ApiError.unauthorized("Token de acesso ausente."));

    // Valida o token junto ao Supabase Auth (assinatura + expiração)
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return next(ApiError.unauthorized("Sessão inválida ou expirada."));

    // Carrega o perfil administrativo vinculado a este usuário
    const { data: perfil, error: pe } = await supabase
      .from("perfis")
      .select("id, organizacao_id, unidade_id, papel, nome, ativo")
      .eq("id", data.user.id)
      .single();

    if (pe || !perfil) return next(ApiError.forbidden("Sem perfil de acesso. Contate o administrador."));
    if (!perfil.ativo) return next(ApiError.forbidden("Usuário inativo."));

    req.user = { id: perfil.id, email: data.user.email, papel: perfil.papel, nome: perfil.nome };
    req.tenant = { organizacaoId: perfil.organizacao_id, unidadeId: perfil.unidade_id };
    next();
  } catch (e) {
    next(ApiError.unauthorized("Falha ao autenticar."));
  }
}

// Restringe uma rota a determinados papéis (ex: apenas 'admin').
export function requirePapel(...papeis) {
  return (req, _res, next) => {
    if (!req.user || !papeis.includes(req.user.papel)) {
      return next(ApiError.forbidden("Permissão insuficiente para esta ação."));
    }
    next();
  };
}
