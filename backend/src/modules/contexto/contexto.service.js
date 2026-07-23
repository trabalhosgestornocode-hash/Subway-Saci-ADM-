import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

// Contexto de acesso do usuário autenticado (base para o seletor de organização):
//   * é superadmin de plataforma?
//   * a quais organizações e unidades ele tem VÍNCULO ativo (usuarios_*);
//   * se for superadmin, também a lista de TODAS as organizações (para o
//     "Acessar organização" do Painel da Plataforma).
// Read-only e escopado ao próprio usuário. Não altera o requireAuth atual.
export async function obterContexto({ usuarioId }) {
  const [superRes, orgsRes, unidsRes] = await Promise.all([
    supabase.from("plataforma_admins")
      .select("usuario_id").eq("usuario_id", usuarioId).eq("ativo", true).maybeSingle(),
    supabase.from("usuarios_organizacoes")
      .select("papel, organizacoes(id, nome)")
      .eq("usuario_id", usuarioId).eq("ativo", true),
    supabase.from("usuarios_unidades")
      .select("papel, unidades(id, nome, organizacao_id)")
      .eq("usuario_id", usuarioId).eq("ativo", true),
  ]);
  for (const r of [orgsRes, unidsRes]) if (r.error) throw ApiError.internal(r.error.message);

  const superadmin = !!superRes.data;

  const organizacoes = (orgsRes.data ?? [])
    .map((r) => ({ id: r.organizacoes?.id, nome: r.organizacoes?.nome, papel: r.papel }))
    .filter((o) => o.id);

  const unidades = (unidsRes.data ?? [])
    .map((r) => ({ id: r.unidades?.id, nome: r.unidades?.nome, organizacaoId: r.unidades?.organizacao_id, papel: r.papel }))
    .filter((u) => u.id);

  const resultado = { superadmin, organizacoes, unidades };

  // Superadmin escolhe QUALQUER organização para "acessar" — devolve a lista toda.
  if (superadmin) {
    const { data, error } = await supabase
      .from("organizacoes").select("id, nome, ativo").order("nome");
    if (error) throw ApiError.internal(error.message);
    resultado.todasOrganizacoes = data ?? [];
  }

  return resultado;
}

// Registra o "Acessar organização" do superadmin (auditoria em plataforma_acessos).
// Restrito ao platform_superadmin — é o acesso de suporte a ambiente de cliente que
// precisa ser identificável/auditável. A troca de contexto em si acontece depois,
// via header x-organizacao-id (validado no requireAuth).
export async function registrarAcessoSuperadmin({ usuarioId, organizacaoId, ip, userAgent }) {
  if (!organizacaoId) throw ApiError.badRequest("organizacaoId é obrigatório.");

  const { data: superRow } = await supabase
    .from("plataforma_admins").select("usuario_id")
    .eq("usuario_id", usuarioId).eq("ativo", true).maybeSingle();
  if (!superRow) throw ApiError.forbidden("Ação restrita ao superadmin da plataforma.");

  const { data: org } = await supabase
    .from("organizacoes").select("id, nome").eq("id", organizacaoId).maybeSingle();
  if (!org) throw ApiError.notFound("Organização não encontrada.");

  const { error } = await supabase.from("plataforma_acessos").insert({
    superadmin_id: usuarioId,
    organizacao_id: organizacaoId,
    acao: "acessar_organizacao",
    contexto: { ip: ip ?? null, userAgent: userAgent ?? null },
  });
  if (error) throw ApiError.internal(error.message);

  return { organizacao: org, registrado: true };
}

// Histórico de acessos do superadmin (para painel de auditoria da plataforma).
export async function listarAcessosSuperadmin({ usuarioId, limite = 100 }) {
  const { data: superRow } = await supabase
    .from("plataforma_admins").select("usuario_id")
    .eq("usuario_id", usuarioId).eq("ativo", true).maybeSingle();
  if (!superRow) throw ApiError.forbidden("Ação restrita ao superadmin da plataforma.");

  const { data, error } = await supabase
    .from("plataforma_acessos")
    .select("id, superadmin_id, organizacao_id, acao, created_at, organizacoes(nome)")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(Number(limite) || 100, 1), 500));
  if (error) throw ApiError.internal(error.message);

  return (data ?? []).map((r) => ({
    id: r.id, superadminId: r.superadmin_id, organizacaoId: r.organizacao_id,
    organizacaoNome: r.organizacoes?.nome ?? null, acao: r.acao, em: r.created_at,
  }));
}
