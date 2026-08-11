-- =====================================================================
-- MIGRATION 033 — Gerenciamento do Lançamento de Faturamento Mensal
-- (visualizar / editar / excluir um lançamento mensal já existente)
-- =====================================================================
-- OBJETIVO
--   Hoje, uma vez que um mês tem TODOS os seus dias decorridos cobertos
--   por lançamento (manual ou por distribuição mensal), o endpoint de
--   lançamento mensal bloqueia com "este mês já foi lançado" — sem
--   nenhuma forma de ver, complementar ou desfazer o que foi lançado.
--   Esta migration dá suporte de dados para o novo fluxo de
--   gerenciamento (ver dashboardExecutivo.service.js):
--     1. Rastrear quem/quando EDITOU um lote (além de quem/quando criou,
--        já coberto desde a migration 026).
--     2. Guardar um histórico de auditoria por lote (criado/editado/
--        excluído + quais campos mudaram) — independente do lote em si,
--        pelo mesmo motivo já documentado na migration 027 para a
--        exclusão de dia: se a auditoria de exclusão dependesse de uma
--        FK CASCADE para o lote, o próprio registro da exclusão
--        desapareceria junto com o lote apagado.
--
-- NÃO DESTRUTIVO / IDEMPOTENTE.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. "ÚLTIMA ATUALIZAÇÃO" do lote — quem editou e quando (created_at /
--    usuario_* já existem desde a 026 e continuam sendo "quem criou").
-- ---------------------------------------------------------------------
alter table lancamentos_financeiros_distribuicao_mensal
  add column if not exists updated_at timestamptz not null default now();
alter table lancamentos_financeiros_distribuicao_mensal
  add column if not exists atualizado_por_id uuid references perfis(id) on delete set null;
alter table lancamentos_financeiros_distribuicao_mensal
  add column if not exists atualizado_por_nome text;
alter table lancamentos_financeiros_distribuicao_mensal
  add column if not exists atualizado_por_email text;

-- ---------------------------------------------------------------------
-- 2. AUDITORIA DO LOTE — criado / editado / excluído, com o diff dos
--    campos alterados. `distribuicao_mensal_id` é ON DELETE SET NULL (não
--    CASCADE) de propósito: o registro de "excluído" precisa sobreviver
--    à exclusão do próprio lote que ele descreve. `ano`/`mes`/
--    `unidade_id` ficam desnormalizados aqui por isso mesmo — para o
--    histórico continuar navegável mesmo depois que o lote sumiu.
-- ---------------------------------------------------------------------
create table if not exists lancamentos_financeiros_distribuicao_mensal_auditoria (
  id uuid primary key default gen_random_uuid(),
  distribuicao_mensal_id uuid references lancamentos_financeiros_distribuicao_mensal(id) on delete set null,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  ano int not null check (ano between 2000 and 2100),
  mes int not null check (mes between 1 and 12),
  acao text not null check (acao in ('criado', 'editado', 'excluido')),
  campos_alterados jsonb,
  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,
  usuario_email text,
  created_at timestamptz not null default now()
);
create index if not exists idx_lfdma_lote on lancamentos_financeiros_distribuicao_mensal_auditoria(distribuicao_mensal_id);
create index if not exists idx_lfdma_unidade on lancamentos_financeiros_distribuicao_mensal_auditoria(unidade_id, ano, mes);
create index if not exists idx_lfdma_org on lancamentos_financeiros_distribuicao_mensal_auditoria(organizacao_id);

alter table lancamentos_financeiros_distribuicao_mensal_auditoria enable row level security;
drop policy if exists rls_lfdma_tenant on lancamentos_financeiros_distribuicao_mensal_auditoria;
create policy rls_lfdma_tenant on lancamentos_financeiros_distribuicao_mensal_auditoria
  for select to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente):
--   select column_name from information_schema.columns
--   where table_name = 'lancamentos_financeiros_distribuicao_mensal'
--     and column_name in ('updated_at','atualizado_por_id','atualizado_por_nome','atualizado_por_email');
--   select count(*) from lancamentos_financeiros_distribuicao_mensal_auditoria; -- 0 logo após aplicar
-- =====================================================================
