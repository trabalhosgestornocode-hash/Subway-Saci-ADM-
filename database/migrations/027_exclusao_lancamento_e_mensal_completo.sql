-- =====================================================================
-- MIGRATION 027 — Exclusão universal de lançamento (admin) + campos
-- extras no lançamento mensal
-- =====================================================================
-- OBJETIVO
--   1. Log de exclusão de lançamentos financeiros diários. Diferente da
--      tabela `lancamentos_financeiros_auditoria` (que referencia
--      `lancamento_id` com ON DELETE CASCADE — se a usássemos para logar a
--      exclusão, o próprio registro da exclusão desapareceria junto com o
--      lançamento apagado). Esta tabela é independente: guarda um SNAPSHOT
--      completo do lançamento antes de apagar, para sempre.
--   2. Esta migration NÃO adiciona colunas novas — os campos extras do
--      lançamento mensal (quantidade de pedidos, taxas, serviços etc.) já
--      existem em `lancamentos_financeiros_diarios` desde a migration 026
--      (todos nuláveis); só o serviço passa a preenchê-los quando o
--      franqueado informar os totais do mês.
--
-- NÃO DESTRUTIVO / IDEMPOTENTE.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

create table if not exists lancamentos_financeiros_exclusoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  data_lancamento date not null,
  lancamento_snapshot jsonb not null,  -- o registro inteiro, como estava antes de apagar
  motivo text not null,
  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,
  usuario_email text,
  created_at timestamptz not null default now()
);
create index if not exists idx_lfe_unidade on lancamentos_financeiros_exclusoes(unidade_id, data_lancamento desc);
create index if not exists idx_lfe_org on lancamentos_financeiros_exclusoes(organizacao_id);

alter table lancamentos_financeiros_exclusoes enable row level security;
drop policy if exists rls_lfe_tenant on lancamentos_financeiros_exclusoes;
create policy rls_lfe_tenant on lancamentos_financeiros_exclusoes
  for select to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente):
--   select column_name from information_schema.columns
--   where table_name = 'lancamentos_financeiros_exclusoes' order by ordinal_position;
-- =====================================================================
