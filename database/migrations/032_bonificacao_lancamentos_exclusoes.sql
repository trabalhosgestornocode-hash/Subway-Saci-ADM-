-- =====================================================================
-- MIGRATION 032 — Exclusão de lançamento da Bonificação Mensal
-- =====================================================================
-- OBJETIVO
--   Hoje um lançamento diário da Bonificação Mensal (importado errado, na
--   data errada, ou digitado errado) não tinha como ser removido — só
--   SUBSTITUÍDO reimportando o mesmo dia. Isso trava quando o problema é
--   justamente A DATA: o PDF foi importado no dia errado, e a unicidade de
--   arquivo (uq_bimp_hash, migration 028) bloqueia reimportar o MESMO PDF
--   numa data diferente enquanto a importação errada ainda existir.
--
--   Segue exatamente o padrão já usado no Dashboard iFood (migration 027,
--   `lancamentos_financeiros_exclusoes`): exclusão é de verdade (DELETE),
--   nunca silenciosa — sempre grava um SNAPSHOT completo do que existia,
--   com motivo e autor, ANTES de apagar.
--
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

create table if not exists bonificacao_lancamentos_exclusoes (
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
create index if not exists idx_ble_unidade on bonificacao_lancamentos_exclusoes(unidade_id, data_lancamento desc);
create index if not exists idx_ble_org on bonificacao_lancamentos_exclusoes(organizacao_id);

alter table bonificacao_lancamentos_exclusoes enable row level security;
drop policy if exists rls_ble_tenant on bonificacao_lancamentos_exclusoes;
create policy rls_ble_tenant on bonificacao_lancamentos_exclusoes
  for select to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente):
--   select column_name from information_schema.columns
--   where table_name = 'bonificacao_lancamentos_exclusoes' order by ordinal_position;
-- =====================================================================
