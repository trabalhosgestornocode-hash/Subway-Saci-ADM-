import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

// Papéis aceitos (espelham o enum papel_usuario após a migration 003).
const PAPEIS_VALIDOS = ["desenvolvedor", "admin", "gerente", "financeiro", "operador", "leitura"];

function traduz(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("already been registered") || m.includes("already exists") || m.includes("duplicate"))
    return "Já existe um usuário com este e-mail.";
  if (m.includes("invalid input value for enum") || m.includes("invalid enum"))
    return "Perfil indisponível — rode a migration 003 (papéis) no Supabase.";
  if (m.includes("password")) return "Senha inválida (mínimo de 8 caracteres).";
  return msg || "Falha na operação.";
}

export async function listarUsuarios({ organizacaoId }) {
  const { data, error } = await supabase
    .from("perfis")
    .select("id, nome, email, papel, ativo, created_at")
    .eq("organizacao_id", organizacaoId)
    .order("created_at", { ascending: true });
  if (error) throw ApiError.internal(error.message);
  return data;
}

// Cria a conta real no Supabase Auth + o perfil vinculado (mesma organização).
export async function criarUsuario({ organizacaoId, unidadeId, nome, email, senha, papel }) {
  email = String(email || "").trim().toLowerCase();
  nome = String(nome || "").trim() || email.split("@")[0];
  senha = String(senha || "");
  if (!email) throw ApiError.badRequest("E-mail é obrigatório.");
  if (senha.length < 8) throw ApiError.badRequest("A senha deve ter ao menos 8 caracteres.");
  if (!PAPEIS_VALIDOS.includes(papel)) throw ApiError.badRequest("Perfil inválido.");

  // 1) conta no Auth (email já confirmado -> login imediato com a senha definida)
  const { data: created, error: e1 } = await supabase.auth.admin.createUser({
    email, password: senha, email_confirm: true, user_metadata: { nome },
  });
  if (e1 || !created?.user) throw ApiError.badRequest(traduz(e1?.message));
  const uid = created.user.id;

  // 2) perfil vinculado à organização do solicitante
  const { error: e2 } = await supabase.from("perfis").insert({
    id: uid, organizacao_id: organizacaoId, unidade_id: unidadeId ?? null,
    nome, email, papel, ativo: true,
  });
  if (e2) {
    // rollback: remove a conta Auth se o perfil não gravar (evita conta órfã)
    await supabase.auth.admin.deleteUser(uid).catch(() => {});
    throw ApiError.badRequest(traduz(e2.message));
  }
  return { id: uid, nome, email, papel, ativo: true };
}

export async function atualizarUsuario({ organizacaoId, id, papel, ativo }) {
  const patch = {};
  if (papel !== undefined) {
    if (!PAPEIS_VALIDOS.includes(papel)) throw ApiError.badRequest("Perfil inválido.");
    patch.papel = papel;
  }
  if (ativo !== undefined) patch.ativo = !!ativo;
  if (!Object.keys(patch).length) return { id };

  const { data, error } = await supabase
    .from("perfis").update(patch)
    .eq("id", id).eq("organizacao_id", organizacaoId)
    .select("id").single();
  if (error || !data) throw ApiError.badRequest(traduz(error?.message) || "Usuário não encontrado.");
  return { id, ...patch };
}

export async function excluirUsuario({ organizacaoId, id, solicitanteId }) {
  if (id === solicitanteId) throw ApiError.badRequest("Você não pode excluir o próprio usuário.");
  const { data: perfil } = await supabase
    .from("perfis").select("id").eq("organizacao_id", organizacaoId).eq("id", id).single();
  if (!perfil) throw ApiError.notFound("Usuário não encontrado nesta organização.");

  // Apaga a conta no Auth; o perfil cai por ON DELETE CASCADE (perfis.id -> auth.users.id).
  const { error } = await supabase.auth.admin.deleteUser(id);
  if (error) throw ApiError.badRequest(traduz(error.message));
  return { id };
}
