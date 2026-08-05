-- =====================================================================
-- MIGRATION 023 — Dashboard Executivo
-- =====================================================================
-- OBJETIVO
--   Lançamento financeiro diário por unidade (fechamento do iFood, hoje
--   preenchido manualmente numa planilha externa que guarda valores
--   ACUMULADOS). Aqui guardamos o valor REAL de cada dia — o acumulado e
--   todos os percentuais/projeções são sempre derivados em tempo real pelo
--   backend (ver backend/src/modules/dashboard-executivo/).
--
--   Três tabelas:
--     1. lancamentos_financeiros_diarios — 1 linha por unidade+dia.
--     2. lancamentos_financeiros_auditoria — trilha de correção de um
--        lançamento já finalizado (nunca se apaga/edita silenciosamente).
--     3. metas_indicadores — metas de rentabilidade centralizadas, com
--        resolução em cascata (unidade -> organização -> padrão global).
--        A planilha de origem mostra metas DIFERENTES por loja — prova de
--        que não pode ficar hardcoded no código.
--
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'situacao_operacao_enum') then
    create type situacao_operacao_enum as enum ('normal', 'sem_operacao', 'zero_vendas');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'status_lancamento_enum') then
    create type status_lancamento_enum as enum ('rascunho', 'finalizado');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. LANÇAMENTO FINANCEIRO DIÁRIO (1 linha por unidade + dia)
-- ---------------------------------------------------------------------
create table if not exists lancamentos_financeiros_diarios (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  data_lancamento date not null,

  -- Etapa 1 — situação da operação
  situacao situacao_operacao_enum not null default 'normal',
  motivo_sem_operacao text,   -- obrigatório (no backend) quando situacao = 'sem_operacao'
  observacao text,

  -- Etapa 2 — desempenho
  qtd_vendas int not null default 0 check (qtd_vendas >= 0),
  valor_vendas_bruto numeric(14,2) not null default 0 check (valor_vendas_bruto >= 0),
  novos_clientes int not null default 0 check (novos_clientes >= 0),

  -- Etapa 3 — financeiro (extrato do iFood)
  valor_vendas_ifood numeric(14,2) not null default 0 check (valor_vendas_ifood >= 0),
  taxas_comissoes numeric(14,2) not null default 0 check (taxas_comissoes >= 0),
  servicos_promocoes numeric(14,2) not null default 0 check (servicos_promocoes >= 0),
  taxas_entregadores numeric(14,2) not null default 0 check (taxas_entregadores >= 0),
  -- Negativo = ajuste A FAVOR da unidade. Só quem tem a permissão de correção
  -- pode gravar negativo, e sempre com `justificativa_ajuste` preenchida — a
  -- regra vive no service (backend/src/modules/dashboard-executivo), não aqui.
  outras_deducoes numeric(14,2) not null default 0,
  justificativa_ajuste text,

  status status_lancamento_enum not null default 'rascunho',

  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,
  usuario_email text,
  finalizado_em timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (unidade_id, data_lancamento)
);

create index if not exists idx_lfd_unidade_data on lancamentos_financeiros_diarios(unidade_id, data_lancamento desc);
create index if not exists idx_lfd_org on lancamentos_financeiros_diarios(organizacao_id);

drop trigger if exists trg_lfd_upd on lancamentos_financeiros_diarios;
create trigger trg_lfd_upd before update on lancamentos_financeiros_diarios
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- 3. AUDITORIA DE CORREÇÃO
--    Uma linha por CAMPO alterado. Cobre tanto a correção de um lançamento
--    já finalizado (motivo obrigatório) quanto o registro de uma dedução
--    negativa (ajuste a favor) já na criação/rascunho.
-- ---------------------------------------------------------------------
create table if not exists lancamentos_financeiros_auditoria (
  id uuid primary key default gen_random_uuid(),
  lancamento_id uuid not null references lancamentos_financeiros_diarios(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  campo text not null,
  valor_anterior text,
  valor_novo text,
  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,
  usuario_email text,
  motivo text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_lfa_lancamento on lancamentos_financeiros_auditoria(lancamento_id, created_at desc);
create index if not exists idx_lfa_org on lancamentos_financeiros_auditoria(organizacao_id);

-- ---------------------------------------------------------------------
-- 4. METAS CENTRALIZADAS (resolução em cascata: unidade > organização > global)
-- ---------------------------------------------------------------------
create table if not exists metas_indicadores (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid references organizacoes(id) on delete cascade,  -- null = padrão global
  unidade_id uuid references unidades(id) on delete cascade,          -- null = vale para toda a organização
  indicador text not null check (indicador in ('taxas_comissoes', 'servicos_promocoes', 'taxas_entregadores', 'total_deducoes')),
  meta_ideal numeric(6,4) not null,   -- fração: 0.2050 = 20,50%
  limite numeric(6,4) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organizacao_id, unidade_id, indicador)
);
-- unique() já trata (null, null, indicador) como um valor comparável em
-- Postgres (NULL = NULL não é usado por unique — cada combinação de nulls
-- conta como distinta), então garantimos a linha global única por indicador
-- com um índice parcial dedicado:
create unique index if not exists idx_metas_globais_unicas on metas_indicadores(indicador)
  where organizacao_id is null and unidade_id is null;

drop trigger if exists trg_metas_upd on metas_indicadores;
create trigger trg_metas_upd before update on metas_indicadores
  for each row execute function set_updated_at();

-- Seed: valores padrão globais (painel de referência). Cada unidade/empresa
-- pode sobrepor depois inserindo uma linha com organizacao_id/unidade_id
-- preenchidos — a tela de configuração fica para uma fase futura.
insert into metas_indicadores (organizacao_id, unidade_id, indicador, meta_ideal, limite) values
  (null, null, 'taxas_comissoes',    0.2050, 0.2050),
  (null, null, 'servicos_promocoes', 0.1000, 0.1450),
  (null, null, 'taxas_entregadores', 0.1500, 0.1500),
  (null, null, 'total_deducoes',     0.3050, 0.3200)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 5. RLS — padrão do projeto (backend usa service_role e ignora RLS; estas
--    policies só valem para o eventual acesso direto autenticado).
-- ---------------------------------------------------------------------
alter table lancamentos_financeiros_diarios enable row level security;
drop policy if exists rls_lfd_tenant on lancamentos_financeiros_diarios;
create policy rls_lfd_tenant on lancamentos_financeiros_diarios
  for select to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());

alter table lancamentos_financeiros_auditoria enable row level security;
drop policy if exists rls_lfa_tenant on lancamentos_financeiros_auditoria;
create policy rls_lfa_tenant on lancamentos_financeiros_auditoria
  for select to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());

alter table metas_indicadores enable row level security;
drop policy if exists rls_metas_leitura on metas_indicadores;
create policy rls_metas_leitura on metas_indicadores
  for select to authenticated
  using (
    (organizacao_id is null and unidade_id is null)
    or organizacao_id in (select auth_organizacao_ids())
    or is_platform_superadmin()
  );

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente):
--   select column_name from information_schema.columns
--   where table_name = 'lancamentos_financeiros_diarios' order by ordinal_position;
--   select * from metas_indicadores order by indicador;
-- =====================================================================
