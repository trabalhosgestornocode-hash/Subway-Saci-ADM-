import { supabase } from "../config/supabase.js";
import { ApiError } from "../shared/ApiError.js";

// Autenticação real: valida o JWT do Supabase, carrega o perfil e checa se está ativo.
// O tenant PADRÃO vem do PERFIL autenticado. Opcionalmente, o cliente pode SELECIONAR
// um contexto (org/unidade) via headers x-organizacao-id / x-unidade-id — mas ele é
// sempre VALIDADO contra os vínculos do usuário (ou liberado ao platform_superadmin),
// nunca confiado cru. Sem os headers, o comportamento é idêntico ao anterior.
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

    // Contexto PADRÃO = o do perfil (retrocompatível: é o que acontece hoje).
    let organizacaoId = perfil.organizacao_id;
    let unidadeId = perfil.unidade_id;
    req.contexto = { selecionado: false, viaSuperadmin: false };

    // Contexto SELECIONADO (opt-in): só entra em cena se o cliente enviar os headers.
    const selOrg = req.header("x-organizacao-id") || null;
    const selUni = req.header("x-unidade-id") || null;
    if (selOrg || selUni) {
      const ctx = await resolverContextoSelecionado({ perfil, selOrg, selUni });
      if (!ctx.ok) return next(ApiError.forbidden(ctx.motivo));
      organizacaoId = ctx.organizacaoId;
      unidadeId = ctx.unidadeId;
      req.contexto = { selecionado: true, viaSuperadmin: ctx.viaSuperadmin };
    }

    req.tenant = { organizacaoId, unidadeId };
    next();
  } catch (e) {
    next(ApiError.unauthorized("Falha ao autenticar."));
  }
}

// Resolve e VALIDA o contexto (org/unidade) escolhido pelo cliente via headers.
// Retorna { ok, organizacaoId, unidadeId, viaSuperadmin } ou { ok:false, motivo }.
// Só é chamado quando há header de contexto — o caminho padrão não paga esse custo.
async function resolverContextoSelecionado({ perfil, selOrg, selUni }) {
  const usuarioId = perfil.id;

  // platform_superadmin: acesso global (o contexto explícito é responsabilidade da app).
  const { data: superRow } = await supabase
    .from("plataforma_admins").select("usuario_id")
    .eq("usuario_id", usuarioId).eq("ativo", true).maybeSingle();
  const superadmin = !!superRow;

  let organizacaoId = selOrg || perfil.organizacao_id;
  let unidadeId = null;

  // Se uma unidade foi escolhida, ela define (e precisa bater com) a organização.
  if (selUni) {
    const { data: uni } = await supabase
      .from("unidades").select("id, organizacao_id").eq("id", selUni).maybeSingle();
    if (!uni) return { ok: false, motivo: "Unidade não encontrada." };
    if (selOrg && uni.organizacao_id !== selOrg)
      return { ok: false, motivo: "Unidade não pertence à organização informada." };
    organizacaoId = uni.organizacao_id;
    unidadeId = uni.id;
  }

  if (superadmin) {
    if (selOrg) {
      const { data: org } = await supabase
        .from("organizacoes").select("id").eq("id", organizacaoId).maybeSingle();
      if (!org) return { ok: false, motivo: "Organização não encontrada." };
    }
    return { ok: true, organizacaoId, unidadeId, viaSuperadmin: true };
  }

  // Usuário comum: exige vínculo ATIVO com a organização...
  const { data: vo } = await supabase
    .from("usuarios_organizacoes").select("organizacao_id")
    .eq("usuario_id", usuarioId).eq("organizacao_id", organizacaoId).eq("ativo", true).maybeSingle();
  if (!vo) return { ok: false, motivo: "Sem vínculo com esta organização." };

  // ...e, se uma unidade foi escolhida, vínculo ATIVO com ela.
  if (unidadeId) {
    const { data: vu } = await supabase
      .from("usuarios_unidades").select("unidade_id")
      .eq("usuario_id", usuarioId).eq("unidade_id", unidadeId).eq("ativo", true).maybeSingle();
    if (!vu) return { ok: false, motivo: "Sem vínculo com esta unidade." };
  }

  return { ok: true, organizacaoId, unidadeId, viaSuperadmin: false };
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
