-- =====================================================================
-- MIGRATION 061 — Painel Administrativo (acesso)
-- =====================================================================
-- OBJETIVO
--   Um TERCEIRO ambiente, além do operacional (empresa/unidade) e do Painel
--   SuperAdmin: o PAINEL ADMINISTRATIVO da Crescer com Delivery — GERENCIAL,
--   cross-tenant, para os donos/gestores internos da Crescer monitorarem o
--   preenchimento e a qualidade dos dados de TODAS as empresas monitoradas
--   (o primeiro monitor é o Dashboard iFood / fechamento diário D-1).
--
--   NÃO é Superadmin. Quem tem acesso aqui NÃO ganha poder técnico
--   (empresas / unidades / usuários / módulos / permissões / vínculos /
--   impersonação). É só visão de monitoramento.
--
--   Mesmo padrão de `plataforma_admins` (migration 015): um flag GLOBAL,
--   desacoplado dos vínculos de empresa/unidade, relido a cada request pelo
--   middleware `requirePainelAdministrativo` — revogar surte efeito na hora,
--   sem sessão para encerrar.
--
-- ESCOPO DESTA MIGRATION: só a tabela de acesso. NENHUM dado de
--   monitoramento é persistido — status, pendências e conformidade são
--   sempre derivados em tempo real dos lançamentos existentes
--   (lancamentos_financeiros_diarios), reaproveitando statusMes/RESOLVIDOS
--   do domínio do Dashboard iFood.
--
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

create table if not exists painel_administrativo_usuarios (
  usuario_id  uuid primary key references auth.users(id) on delete cascade,
  ativo       boolean not null default true,
  criado_por  uuid references auth.users(id) on delete set null,  -- quem concedeu o acesso
  observacao  text,                                               -- por que / contexto da concessão
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table painel_administrativo_usuarios is
  'Acesso GLOBAL ao Painel Administrativo da Crescer (monitoramento gerencial cross-tenant). NAO e SuperAdmin: nao concede nenhum poder tecnico. Espelha plataforma_admins.';

-- updated_at automático (reaproveita set_updated_at() do schema.sql)
drop trigger if exists trg_padmadm_upd on painel_administrativo_usuarios;
create trigger trg_padmadm_upd before update on painel_administrativo_usuarios
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- RLS — mesmo padrão de rls_padm_superadmin (migration 015).
-- DORMENTE para o app: o backend usa service_role e ignora RLS; todo dado
-- do painel passa pelo backend, atrás de requirePainelAdministrativo. Esta
-- policy é defesa em profundidade para o eventual acesso autenticado direto.
-- ---------------------------------------------------------------------
alter table painel_administrativo_usuarios enable row level security;
drop policy if exists rls_padmadm_self on painel_administrativo_usuarios;
create policy rls_padmadm_self on painel_administrativo_usuarios
  for select using (usuario_id = auth.uid() or is_platform_superadmin());

-- ---------------------------------------------------------------------
-- CONCESSÃO DO PRIMEIRO ACESSO
--   Descomente e ajuste o e-mail. Nunca hardcode de UUID — resolve pelo
--   `perfis` (mesma abordagem de plataforma.usuarios.service.js).
-- ---------------------------------------------------------------------
-- insert into painel_administrativo_usuarios (usuario_id, observacao)
-- select id, 'Acesso inicial (migration 061)'
--   from perfis
--  where lower(email) = lower('EMAIL_AQUI')
-- on conflict (usuario_id) do nothing;

-- =====================================================================
-- VERIFICAÇÃO
--   -- Quem tem acesso ao Painel Administrativo:
--   select pau.usuario_id, p.email, pau.ativo, pau.created_at
--     from painel_administrativo_usuarios pau
--     join perfis p on p.id = pau.usuario_id
--    where pau.ativo
--    order by pau.created_at;
--
--   -- O SuperAdmin permanece INALTERADO (esta migration não o toca):
--   select count(*) as superadmins_ativos from plataforma_admins where ativo;
--
--   -- Os vínculos de empresa/unidade permanecem INALTERADOS:
--   select count(*) from usuarios_organizacoes;
--   select count(*) from usuarios_unidades;
-- =====================================================================
-- ROLLBACK
--   drop table if exists painel_administrativo_usuarios;   -- nada mais é tocado
-- =====================================================================
