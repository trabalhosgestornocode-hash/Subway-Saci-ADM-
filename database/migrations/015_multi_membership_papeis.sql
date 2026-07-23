-- =====================================================================
-- MIGRATION 015 — Multi-membership, papéis novos e Superadmin de plataforma
-- =====================================================================
-- OBJETIVO (Fase 2 — consolidar o modelo multiempresa/multiunidade)
--   Introduz a arquitetura decidida para a plataforma Crescer com Delivery:
--     * um usuário pode pertencer a VÁRIAS organizações e/ou unidades
--       (tabelas de vínculo, em vez do organizacao_id/unidade_id único de perfis);
--     * papéis novos por vínculo (organization_admin, unit_manager, finance,
--       operations, viewer);
--     * papel GLOBAL platform_superadmin (admin central da Crescer), concedido
--       fora dos vínculos, com base de auditoria dos acessos a clientes.
--
-- ESTA MIGRATION É ADITIVA — NÃO QUEBRA NADA:
--   * NÃO altera a tabela `perfis` (o vínculo único atual continua valendo).
--   * NÃO altera as policies da migration 014 (o isolamento já validado pelo
--     teste de integração continua idêntico).
--   * Só CRIA tabelas/enum/funções novas e faz BACKFILL a partir de `perfis`.
--   A "virada" (backend e RLS passarem a usar os vínculos em vez de perfis)
--   será uma migration/PR SEPARADO, feito de forma incremental e testado com
--   o teste de isolamento estendido. Aqui apenas preparamos o terreno.
--
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ENUM DE PAPÉIS (lista inicial decidida; refinável no futuro)
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'papel_acesso') then
    create type papel_acesso as enum (
      'platform_superadmin',  -- admin central da plataforma (concedido via plataforma_admins)
      'organization_admin',   -- admin do cliente (toda a organização)
      'unit_manager',         -- gestor de uma unidade
      'finance',              -- financeiro
      'operations',           -- operação
      'viewer'                -- somente leitura
    );
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. VÍNCULOS: usuário <-> organização (N:N) e usuário <-> unidade (N:N)
--    O usuário é a identidade do Supabase Auth (auth.users), independente
--    da linha legada em `perfis`.
-- ---------------------------------------------------------------------
create table if not exists usuarios_organizacoes (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  papel papel_acesso not null default 'viewer',
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (usuario_id, organizacao_id),
  -- superadmin de plataforma NÃO é papel de vínculo (é global, ver plataforma_admins)
  constraint uo_papel_valido check (papel <> 'platform_superadmin')
);
create index if not exists idx_uo_usuario on usuarios_organizacoes(usuario_id);
create index if not exists idx_uo_org on usuarios_organizacoes(organizacao_id);

create table if not exists usuarios_unidades (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  -- papel na unidade: NULL = herda o papel da organização; senão, sobrepõe.
  papel papel_acesso,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (usuario_id, unidade_id),
  constraint uu_papel_valido check (papel is null or papel <> 'platform_superadmin')
);
create index if not exists idx_uu_usuario on usuarios_unidades(usuario_id);
create index if not exists idx_uu_unidade on usuarios_unidades(unidade_id);

-- ---------------------------------------------------------------------
-- 3. SUPERADMIN DE PLATAFORMA (global) + auditoria de acesso a clientes
-- ---------------------------------------------------------------------
create table if not exists plataforma_admins (
  usuario_id uuid primary key references auth.users(id) on delete cascade,
  ativo boolean not null default true,
  observacao text,                     -- por que/quem concedeu
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Registro de cada vez que um superadmin ASSUME o contexto de uma organização
-- (ação "Acessar organização"). Suporta o requisito de acesso identificável e
-- auditável. Populada pela aplicação; começa vazia.
create table if not exists plataforma_acessos (
  id uuid primary key default gen_random_uuid(),
  superadmin_id uuid not null references auth.users(id) on delete cascade,
  organizacao_id uuid references organizacoes(id) on delete set null,
  acao text not null default 'acessar_organizacao',
  contexto jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_pa_superadmin on plataforma_acessos(superadmin_id);
create index if not exists idx_pa_org on plataforma_acessos(organizacao_id);
create index if not exists idx_pa_data on plataforma_acessos(created_at);

-- updated_at automático (reaproveita set_updated_at() do schema.sql)
drop trigger if exists trg_uo_upd on usuarios_organizacoes;
create trigger trg_uo_upd before update on usuarios_organizacoes
  for each row execute function set_updated_at();
drop trigger if exists trg_uu_upd on usuarios_unidades;
create trigger trg_uu_upd before update on usuarios_unidades
  for each row execute function set_updated_at();
drop trigger if exists trg_padm_upd on plataforma_admins;
create trigger trg_padm_upd before update on plataforma_admins
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- 4. HELPERS para o RLS baseado em vínculos (ainda NÃO usados pelas policies
--    da 014 — ficam prontos para a migration da "virada"). security definer
--    para ignorar RLS e evitar recursão.
-- ---------------------------------------------------------------------
create or replace function is_platform_superadmin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from plataforma_admins
    where usuario_id = auth.uid() and ativo
  );
$$;

-- Organizações às quais o usuário tem vínculo ATIVO (para: organizacao_id in (...))
create or replace function auth_organizacao_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select organizacao_id from usuarios_organizacoes
  where usuario_id = auth.uid() and ativo;
$$;

-- Unidades às quais o usuário tem vínculo ATIVO
create or replace function auth_unidade_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select unidade_id from usuarios_unidades
  where usuario_id = auth.uid() and ativo;
$$;

-- ---------------------------------------------------------------------
-- 5. BACKFILL a partir de `perfis` (não perde nenhum vínculo atual).
--    Cada perfil vira 1 vínculo de organização + (se houver) 1 de unidade.
--    Mapa dos papéis antigos -> novos.
-- ---------------------------------------------------------------------
insert into usuarios_organizacoes (usuario_id, organizacao_id, papel, ativo)
select p.id, p.organizacao_id,
  (case p.papel::text
     when 'admin'         then 'organization_admin'
     when 'desenvolvedor' then 'organization_admin'
     when 'gerente'       then 'unit_manager'
     when 'financeiro'    then 'finance'
     when 'operador'      then 'operations'
     when 'leitura'       then 'viewer'
     else 'viewer'
   end)::papel_acesso,
  coalesce(p.ativo, true)
from perfis p
on conflict (usuario_id, organizacao_id) do nothing;

insert into usuarios_unidades (usuario_id, unidade_id, ativo)
select p.id, p.unidade_id, coalesce(p.ativo, true)
from perfis p
where p.unidade_id is not null
on conflict (usuario_id, unidade_id) do nothing;

-- OBS: nenhum platform_superadmin é criado automaticamente (não presumimos quem
-- é da Crescer). Para conceder manualmente depois de rodar esta migration:
--   insert into plataforma_admins (usuario_id, observacao)
--   select id, 'Superadmin Crescer' from auth.users where email = 'SEU_EMAIL_AQUI'
--   on conflict (usuario_id) do update set ativo = true;

-- ---------------------------------------------------------------------
-- 6. RLS das NOVAS tabelas (mantém o padrão deny-by-default do projeto).
--    Backend usa service_role (ignora RLS). Estas policies valem para acesso
--    direto autenticado: cada um vê apenas os PRÓPRIOS vínculos; superadmin vê
--    tudo. Escritas continuam exclusivas do backend (service_role).
-- ---------------------------------------------------------------------
alter table usuarios_organizacoes enable row level security;
drop policy if exists rls_uo_self on usuarios_organizacoes;
create policy rls_uo_self on usuarios_organizacoes
  for select to authenticated
  using (usuario_id = auth.uid() or is_platform_superadmin());

alter table usuarios_unidades enable row level security;
drop policy if exists rls_uu_self on usuarios_unidades;
create policy rls_uu_self on usuarios_unidades
  for select to authenticated
  using (usuario_id = auth.uid() or is_platform_superadmin());

alter table plataforma_admins enable row level security;
drop policy if exists rls_padm_superadmin on plataforma_admins;
create policy rls_padm_superadmin on plataforma_admins
  for all to authenticated
  using (is_platform_superadmin())
  with check (is_platform_superadmin());

alter table plataforma_acessos enable row level security;
drop policy if exists rls_pa_superadmin on plataforma_acessos;
create policy rls_pa_superadmin on plataforma_acessos
  for select to authenticated
  using (superadmin_id = auth.uid() or is_platform_superadmin());

-- ---------------------------------------------------------------------
-- 7. VERIFICAÇÃO (rode separadamente)
-- ---------------------------------------------------------------------
--   select 'usuarios_organizacoes' t, count(*) from usuarios_organizacoes
--   union all select 'usuarios_unidades', count(*) from usuarios_unidades
--   union all select 'perfis (origem)', count(*) from perfis;
--   -- usuarios_organizacoes deve ter >= nº de perfis distintos por org.
--
--   select tablename, rowsecurity from pg_tables
--   where schemaname='public'
--     and tablename in ('usuarios_organizacoes','usuarios_unidades',
--                       'plataforma_admins','plataforma_acessos');
-- =====================================================================
-- PRÓXIMO PASSO (migration/PR separado — NÃO nesta migration):
--   * "Virada" do RLS: nas policies da 014, trocar
--       organizacao_id = auth_organizacao_id()   ->  organizacao_id in (select auth_organizacao_ids())
--       unidade_id     = auth_unidade_id()        ->  unidade_id     in (select auth_unidade_ids())
--     e adicionar "or is_platform_superadmin()" onde o superadmin deva enxergar.
--   * Backend: resolver o contexto (org/unidade selecionada) a partir dos
--     vínculos, não mais do perfil único.
--   * Estender o teste de isolamento: usuário multi-org e acesso do superadmin.
-- =====================================================================
-- FIM
-- =====================================================================
