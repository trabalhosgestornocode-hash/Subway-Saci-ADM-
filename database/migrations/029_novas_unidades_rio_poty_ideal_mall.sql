-- =====================================================================
-- MIGRATION 029 — Novas unidades: Subway Rio Poty e Subway Ideal Mall
-- =====================================================================
-- OBJETIVO
--   Duas lojas novas, REAIS (eh_teste=false), dentro do Grupo Saci (mesma
--   organização da Subway Saci — Matriz) — não são empresas/tenants novos,
--   compartilham o catálogo de produtos/insumos/CMV da organização:
--     Subway Rio Poty   -> modelo logístico do iFood: Full Service
--     Subway Ideal Mall -> modelo logístico do iFood: Marketplace
--
--   Ficam vazias de propósito: nenhum lançamento (Dashboard iFood ou
--   Bonificação Mensal) e nenhuma meta de bonificação são criados aqui —
--   os valores reais de meta ainda não foram definidos (ver migration 028,
--   que só semeou metas para a Subway Saci).
--
--   Vínculo do usuário: replica a mesma necessidade já explicada na
--   migration 025 — como projetospeu@gmail.com já tem vínculos explícitos
--   POR UNIDADE (usuarios_unidades) desde aquela migration, qualquer
--   unidade nova precisa de uma linha aqui pra aparecer no seletor dele,
--   senão fica invisível mesmo com o vínculo de empresa intacto por baixo.
--
-- IDEMPOTENTE: pode ser reexecutada com segurança (casa por nome dentro
--   da mesma organização; não duplica unidade nem vínculo).
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. AS 2 UNIDADES NOVAS
-- ---------------------------------------------------------------------
insert into unidades (organizacao_id, nome, eh_teste, modelo_logistico_ifood)
select '00000000-0000-0000-0000-000000000001'::uuid, v.nome, false, v.modelo::modelo_logistico_ifood_enum
from (values
  ('Subway Rio Poty', 'full_service'),
  ('Subway Ideal Mall', 'marketplace')
) as v(nome, modelo)
where not exists (
  select 1 from unidades u
  where u.organizacao_id = '00000000-0000-0000-0000-000000000001'::uuid and u.nome = v.nome
);

-- ---------------------------------------------------------------------
-- 2. VÍNCULO do usuário administrador com as 2 unidades novas (mesmo
--    motivo documentado na migration 025 — sem isso ele não as vê).
--    papel = null: herda organization_admin do vínculo de empresa que já
--    tem, nenhuma permissão fica restrita.
-- ---------------------------------------------------------------------
do $$
declare
  v_usuario_id uuid;
begin
  select id into v_usuario_id from auth.users where email = 'projetospeu@gmail.com';

  if v_usuario_id is not null then
    insert into usuarios_unidades (usuario_id, unidade_id, papel)
    select v_usuario_id, u.id, null
    from unidades u
    where u.organizacao_id = '00000000-0000-0000-0000-000000000001'::uuid
      and u.nome in ('Subway Rio Poty', 'Subway Ideal Mall')
    on conflict (usuario_id, unidade_id) do nothing;
  end if;
end $$;

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente):
--   select id, nome, eh_teste, modelo_logistico_ifood from unidades
--   where organizacao_id = '00000000-0000-0000-0000-000000000001'
--   order by nome;
-- =====================================================================
