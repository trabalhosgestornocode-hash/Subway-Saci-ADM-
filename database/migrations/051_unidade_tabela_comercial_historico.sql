-- =====================================================================
-- MIGRATION 051 — Histórico de troca da tabela comercial da unidade
-- =====================================================================
-- OBJETIVO
--   `unidades.tabela_balcao`/`tabela_ifood` (já existentes desde o schema
--   base, ver database/schema.sql) são a identidade comercial oficial da
--   unidade — a tabela que o Dashboard comum e Produtos/CMV usam por padrão,
--   independente do "modo de comparação" da tela (estado só de frontend,
--   nunca grava aqui). Até esta migration, uma troca real (ex.: E -> F)
--   sobrescrevia a coluna sem deixar rastro de QUAL era a tabela anterior —
--   só `plataforma_auditoria` registrava QUE algo mudou (UNIDADE_EDITADA),
--   nunca o valor de/para.
--
--   Mesmo desenho de `unidade_modelo_logistico_historico` (migration 024):
--   tabela de histórico dedicada, nunca sobrescreve, só acumula. Cada troca
--   real (SuperAdmin via /plataforma OU tenant via /unidade, ver
--   backend/src/modules/unidade) grava uma linha aqui, além da linha em
--   `plataforma_auditoria`.
--
--   DELIBERADAMENTE SEM VIGÊNCIA FUTURA (ver pedido original): registra
--   apenas QUANDO a troca aconteceu (`created_at`), não uma janela de
--   vigência agendada — implementar agendamento exigiria um scheduler novo,
--   fora de escopo desta fase. Se isso virar necessidade real, esta tabela é
--   o ponto de partida (adicionar vigencia_inicio/vigencia_fim depois é
--   aditivo, não quebra o que já existe).
--
-- PRÉ-REQUISITO: schema base (unidades.tabela_balcao/tabela_ifood).
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

create table if not exists unidade_tabela_comercial_historico (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  canal text not null check (canal in ('balcao', 'ifood')),
  tabela_anterior text,
  tabela_nova text not null,
  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,
  usuario_email text,
  -- 'tenant' = organization_admin com configuracoes.gerenciar, pela tela
  -- Configurações da própria unidade; 'superadmin' = painel /plataforma.
  origem text not null default 'tenant' check (origem in ('tenant', 'superadmin')),
  motivo text,
  created_at timestamptz not null default now()
);
create index if not exists idx_utch_unidade on unidade_tabela_comercial_historico(unidade_id, canal, created_at desc);
create index if not exists idx_utch_org on unidade_tabela_comercial_historico(organizacao_id);

alter table unidade_tabela_comercial_historico enable row level security;
drop policy if exists rls_utch_tenant on unidade_tabela_comercial_historico;
create policy rls_utch_tenant on unidade_tabela_comercial_historico
  for select to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente):
--   select table_name from information_schema.tables where table_name = 'unidade_tabela_comercial_historico';
--   -- Esperado: 1 linha.
-- =====================================================================
-- FIM
-- =====================================================================
