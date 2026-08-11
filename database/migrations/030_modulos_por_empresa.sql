-- =====================================================================
-- MIGRATION 030 — Controle de módulos por empresa (provisionamento SaaS)
-- =====================================================================
-- OBJETIVO
--   Cada empresa passa a ter sua PRÓPRIA lista de módulos habilitados
--   (Dashboard, Produtos/CMV, Insumos, Dashboard iFood, Martin Brower...).
--   Sem isso, toda empresa criada enxerga o sistema inteiro — o painel
--   SuperAdmin não tem como vender "só 4 módulos" nem revogar um depois.
--
--   Arquitetura escolhida (em vez de dezenas de colunas booleanas em
--   `organizacoes`): um catálogo (`modulos`) + uma tabela de vínculo
--   (`organizacao_modulos`). Presença de linha = módulo habilitado; remover
--   a linha desabilita. O identificador de cada módulo é estável (texto),
--   nunca um id sequencial — é o que o backend/frontend referenciam no
--   código (ver backend/src/shared/modulos.js).
--
--   `sessoes_contexto.modulos` congela o conjunto no momento da seleção de
--   contexto — o mesmo padrão já usado para `permissoes` (migration 020):
--   mudar os módulos de uma empresa exige revogar as sessões vivas dela
--   para valer na hora (o painel já faz isso ao alterar status/plano).
--
--   `organizacoes.eh_modelo` / `modelo_origem_id` são só PREPARAÇÃO para o
--   futuro "Modelo Padrão" (empresa-molde clonável). Nenhuma clonagem é
--   implementada aqui — só as colunas que a funcionalidade vai usar.
--
-- PRÉ-REQUISITOS: migrations 014, 015, 016, 020 aplicadas (helpers
--   auth_organizacao_ids(), is_platform_superadmin(), set_updated_at()).
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. CATÁLOGO DE MÓDULOS
-- ---------------------------------------------------------------------
create table if not exists modulos (
  id text primary key,                 -- identificador estável (ex: 'products_cmv')
  nome text not null,
  categoria text not null check (categoria in ('operacao', 'integracao')),
  ordem int not null default 0,
  ativo boolean not null default true,  -- kill-switch global (existe na plataforma?)
  created_at timestamptz not null default now()
);

-- Catálogo inicial — espelha backend/src/shared/modulos.js (fonte única no
-- código). ON CONFLICT atualiza nome/categoria/ordem sem apagar vínculos já
-- criados (a FK de organizacao_modulos aponta para este id, que não muda).
insert into modulos (id, nome, categoria, ordem) values
  ('dashboard',        'Dashboard',              'operacao',   1),
  ('products_cmv',      'Produtos / CMV',         'operacao',   2),
  ('ingredients',      'Insumos',                'operacao',   3),
  ('inventory',        'Estoque',                'operacao',   4),
  ('sales',            'Vendas',                 'operacao',   5),
  ('ifood_dashboard',   'Dashboard iFood',        'operacao',   6),
  ('monthly_bonus',     'Bonificação Mensal',     'operacao',   7),
  ('distributors',     'Distribuidoras',         'operacao',   8),
  ('martin_brower',    'Martin Brower',          'integracao', 9),
  ('swfast',           'SWFast / PDV',           'integracao', 10),
  ('ifood',            'iFood',                  'integracao', 11),
  ('coca_cola',         'Coca-Cola',              'integracao', 12),
  ('hortifruti',       'Cláudia Hortifruti',     'integracao', 13)
on conflict (id) do update set nome = excluded.nome, categoria = excluded.categoria, ordem = excluded.ordem;

-- ---------------------------------------------------------------------
-- 2. MÓDULOS HABILITADOS POR EMPRESA
-- ---------------------------------------------------------------------
create table if not exists organizacao_modulos (
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  modulo_id text not null references modulos(id) on delete cascade,
  habilitado_em timestamptz not null default now(),
  habilitado_por uuid,          -- auth.users.id do superadmin; sem FK (sobrevive à exclusão da conta)
  primary key (organizacao_id, modulo_id)
);
create index if not exists idx_organizacao_modulos_org on organizacao_modulos(organizacao_id);

-- Backfill: toda empresa já existente recebe TODOS os módulos habilitados.
-- Sem isto, o deploy desta migration bloquearia, da noite pro dia, o acesso
-- de empresas já em produção (Subway Saci e demais) a tudo que já usam.
insert into organizacao_modulos (organizacao_id, modulo_id)
select o.id, m.id from organizacoes o cross join modulos m
on conflict (organizacao_id, modulo_id) do nothing;

-- ---------------------------------------------------------------------
-- 3. SNAPSHOT DE MÓDULOS NA SESSÃO — mesmo padrão de `permissoes`
-- ---------------------------------------------------------------------
alter table sessoes_contexto add column if not exists modulos jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------
-- 4. PREPARAÇÃO PARA "MODELO PADRÃO" (sem conteúdo ainda)
--    Um Modelo Padrão é uma `organizacoes` normal marcada `eh_modelo = true`
--    — reaproveita o schema de produtos/insumos/ficha_tecnica que já existe
--    e já é isolado por organizacao_id. `modelo_origem_id` registra de qual
--    modelo uma empresa foi provisionada (referência apenas; a clonagem em
--    si é uma funcionalidade futura, não implementada nesta migration).
-- ---------------------------------------------------------------------
alter table organizacoes add column if not exists eh_modelo boolean not null default false;
alter table organizacoes add column if not exists modelo_origem_id uuid references organizacoes(id) on delete set null;
create index if not exists idx_organizacoes_eh_modelo on organizacoes(eh_modelo) where eh_modelo;

-- ---------------------------------------------------------------------
-- 5. RLS — mesmo padrão da migration 020
-- ---------------------------------------------------------------------
alter table modulos enable row level security;
drop policy if exists rls_modulos_leitura on modulos;
create policy rls_modulos_leitura on modulos
  for select to authenticated using (ativo or is_platform_superadmin());
drop policy if exists rls_modulos_escrita on modulos;
create policy rls_modulos_escrita on modulos
  for all to authenticated
  using (is_platform_superadmin()) with check (is_platform_superadmin());

alter table organizacao_modulos enable row level security;
drop policy if exists rls_organizacao_modulos_tenant on organizacao_modulos;
create policy rls_organizacao_modulos_tenant on organizacao_modulos
  for select to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());
drop policy if exists rls_organizacao_modulos_escrita on organizacao_modulos;
create policy rls_organizacao_modulos_escrita on organizacao_modulos
  for insert to authenticated with check (is_platform_superadmin());
drop policy if exists rls_organizacao_modulos_delete on organizacao_modulos;
create policy rls_organizacao_modulos_delete on organizacao_modulos
  for delete to authenticated using (is_platform_superadmin());

-- ---------------------------------------------------------------------
-- 6. VERIFICAÇÃO (rode separadamente para conferir)
-- ---------------------------------------------------------------------
--   -- Toda organização deve ter os 13 módulos após o backfill:
--   select o.nome, count(om.modulo_id) as modulos
--     from organizacoes o left join organizacao_modulos om on om.organizacao_id = o.id
--    group by o.nome having count(om.modulo_id) <> 13;
--   -- Esperado: 0 linhas.
--
--   -- Catálogo:
--   select id, nome, categoria, ordem from modulos order by ordem;
-- =====================================================================
-- FIM
-- =====================================================================
