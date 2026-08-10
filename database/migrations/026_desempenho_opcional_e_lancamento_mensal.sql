-- =====================================================================
-- MIGRATION 026 — Desempenho opcional + Lançamento de Faturamento Mensal
-- =====================================================================
-- OBJETIVO
--   1. Os campos da etapa "Desempenho" (qtd_vendas, valor_vendas_bruto,
--      novos_clientes) deixam de ser obrigatórios — viram NULLABLE, sem
--      default. NULL passa a significar "não informado", nunca 0.
--   2. Os campos de detalhamento do "Financeiro" (taxas_comissoes,
--      servicos_promocoes, taxas_entregadores, outras_deducoes) também
--      viram NULLABLE — necessário para o lançamento mensal (item 3), que
--      só conhece o faturamento total do mês, não o detalhamento por dia.
--      `valor_vendas_ifood` (o faturamento em si) permanece NOT NULL: é o
--      único dado que uma situação "normal" sempre precisa ter, seja ela
--      um lançamento diário real ou uma fatia de distribuição mensal.
--   3. Nova coluna `origem_lancamento` — distingue um dia com dado real
--      (`diario`) de um dia com valor estimado por distribuição mensal
--      (`distribuicao_mensal`). Equivalente ao "entrySource" pedido,
--      nomeado em pt-BR para seguir o padrão do restante do schema.
--   4. Nova tabela `lancamentos_financeiros_distribuicao_mensal` — 1 linha
--      por lançamento mensal confirmado (o "lote"), para rastreabilidade:
--      de onde veio aquele valor, quem lançou, quantos dias, quando.
--
-- NÃO DESTRUTIVO
--   * Nenhuma coluna é removida, nenhum dado existente é apagado ou
--     reinterpretado. Linhas antigas mantêm os valores que já tinham
--     (inclusive os `0` que foram de fato digitados como zero).
--   * DROP DEFAULT / DROP NOT NULL não altera valores já gravados.
--   * `origem_lancamento` nasce com default 'diario' — todo o histórico
--     existente é (corretamente) classificado como lançamento diário real.
--
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. DESEMPENHO — NULLABLE, sem default (NULL = "não informado")
-- ---------------------------------------------------------------------
alter table lancamentos_financeiros_diarios alter column qtd_vendas drop not null;
alter table lancamentos_financeiros_diarios alter column qtd_vendas drop default;
alter table lancamentos_financeiros_diarios alter column valor_vendas_bruto drop not null;
alter table lancamentos_financeiros_diarios alter column valor_vendas_bruto drop default;
alter table lancamentos_financeiros_diarios alter column novos_clientes drop not null;
alter table lancamentos_financeiros_diarios alter column novos_clientes drop default;

-- Recria os checks para aceitar NULL (a versão >= 0 continua valendo quando
-- o valor É informado). Os nomes abaixo são os que o Postgres gera
-- automaticamente para `check (...)` inline sem nome — `drop ... if exists`
-- é seguro mesmo se o nome real divergir (não derruba nada por engano).
alter table lancamentos_financeiros_diarios drop constraint if exists lancamentos_financeiros_diarios_qtd_vendas_check;
alter table lancamentos_financeiros_diarios add constraint lfd_qtd_vendas_check check (qtd_vendas is null or qtd_vendas >= 0);

alter table lancamentos_financeiros_diarios drop constraint if exists lancamentos_financeiros_diarios_valor_vendas_bruto_check;
alter table lancamentos_financeiros_diarios add constraint lfd_valor_vendas_bruto_check check (valor_vendas_bruto is null or valor_vendas_bruto >= 0);

alter table lancamentos_financeiros_diarios drop constraint if exists lancamentos_financeiros_diarios_novos_clientes_check;
alter table lancamentos_financeiros_diarios add constraint lfd_novos_clientes_check check (novos_clientes is null or novos_clientes >= 0);

-- ---------------------------------------------------------------------
-- 2. FINANCEIRO — detalhamento NULLABLE (faturamento em si continua exigido)
--    `valor_vendas_ifood` permanece NOT NULL de propósito: é o dado que a
--    Visão Geral usa como fonte de verdade financeira (ver service).
-- ---------------------------------------------------------------------
alter table lancamentos_financeiros_diarios alter column taxas_comissoes drop not null;
alter table lancamentos_financeiros_diarios alter column taxas_comissoes drop default;
alter table lancamentos_financeiros_diarios drop constraint if exists lancamentos_financeiros_diarios_taxas_comissoes_check;
alter table lancamentos_financeiros_diarios add constraint lfd_taxas_comissoes_check check (taxas_comissoes is null or taxas_comissoes >= 0);

alter table lancamentos_financeiros_diarios alter column servicos_promocoes drop not null;
alter table lancamentos_financeiros_diarios alter column servicos_promocoes drop default;
alter table lancamentos_financeiros_diarios drop constraint if exists lancamentos_financeiros_diarios_servicos_promocoes_check;
alter table lancamentos_financeiros_diarios add constraint lfd_servicos_promocoes_check check (servicos_promocoes is null or servicos_promocoes >= 0);

alter table lancamentos_financeiros_diarios alter column taxas_entregadores drop not null;
alter table lancamentos_financeiros_diarios alter column taxas_entregadores drop default;
alter table lancamentos_financeiros_diarios drop constraint if exists lancamentos_financeiros_diarios_taxas_entregadores_check;
alter table lancamentos_financeiros_diarios add constraint lfd_taxas_entregadores_check check (taxas_entregadores is null or taxas_entregadores >= 0);

alter table lancamentos_financeiros_diarios alter column outras_deducoes drop not null;
alter table lancamentos_financeiros_diarios alter column outras_deducoes drop default;

-- ---------------------------------------------------------------------
-- 3. ORIGEM DO LANÇAMENTO — diario (dado real) x distribuicao_mensal (estimado)
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'origem_lancamento_enum') then
    create type origem_lancamento_enum as enum ('diario', 'distribuicao_mensal');
  end if;
end $$;

alter table lancamentos_financeiros_diarios
  add column if not exists origem_lancamento origem_lancamento_enum not null default 'diario';

-- ---------------------------------------------------------------------
-- 4. LOTE DE DISTRIBUIÇÃO MENSAL — rastreabilidade do "faturamento total
--    do mês" informado, e de quantos dias/quais dias ele gerou.
-- ---------------------------------------------------------------------
create table if not exists lancamentos_financeiros_distribuicao_mensal (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  ano int not null check (ano between 2000 and 2100),
  mes int not null check (mes between 1 and 12),
  valor_total_centavos bigint not null check (valor_total_centavos > 0),
  dias_distribuidos int not null check (dias_distribuidos > 0),
  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,
  usuario_email text,
  created_at timestamptz not null default now()
);
create index if not exists idx_lfdm_unidade on lancamentos_financeiros_distribuicao_mensal(unidade_id, ano, mes);
create index if not exists idx_lfdm_org on lancamentos_financeiros_distribuicao_mensal(organizacao_id);

alter table lancamentos_financeiros_diarios
  add column if not exists distribuicao_mensal_id uuid references lancamentos_financeiros_distribuicao_mensal(id) on delete set null;
create index if not exists idx_lfd_distribuicao on lancamentos_financeiros_diarios(distribuicao_mensal_id) where distribuicao_mensal_id is not null;

alter table lancamentos_financeiros_distribuicao_mensal enable row level security;
drop policy if exists rls_lfdm_tenant on lancamentos_financeiros_distribuicao_mensal;
create policy rls_lfdm_tenant on lancamentos_financeiros_distribuicao_mensal
  for select to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente):
--   select column_name, is_nullable, column_default
--   from information_schema.columns
--   where table_name = 'lancamentos_financeiros_diarios'
--     and column_name in ('qtd_vendas','valor_vendas_bruto','novos_clientes',
--       'taxas_comissoes','servicos_promocoes','taxas_entregadores',
--       'outras_deducoes','origem_lancamento','distribuicao_mensal_id');
--   -- todas devem ter is_nullable = 'YES' (exceto origem_lancamento, que é
--   -- NOT NULL com default 'diario').
-- =====================================================================
