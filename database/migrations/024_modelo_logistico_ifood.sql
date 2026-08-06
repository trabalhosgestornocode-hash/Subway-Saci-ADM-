-- =====================================================================
-- MIGRATION 024 — Modelo logístico do iFood por unidade (Marketplace x Full
-- Service) + correção da Subway Saci
-- =====================================================================
-- OBJETIVO
--   O Dashboard iFood (antigo "Dashboard Executivo") até aqui usava um único
--   conjunto de metas de rentabilidade para toda unidade. Na prática, o iFood
--   opera em dois modelos de logística, com metas BEM diferentes:
--
--     MARKETPLACE   — a unidade entrega com motoboy próprio.
--     FULL SERVICE  — o iFood entrega (entregador parceiro); não existe meta
--                     de "motoboy próprio" nesse modelo.
--
--   As 4 metas semeadas na migration 023 (20,50/20,50 · 10,00/14,50 ·
--   15,00/15,00 · 30,50/32,00) são, na verdade, as metas do FULL SERVICE —
--   ficam como estão, só ganham a etiqueta do modelo. Esta migration:
--     1. Cria o enum e a coluna que guardam o modelo logístico de cada
--        unidade (`unidades.modelo_logistico_ifood`), com histórico de troca.
--     2. Estende `metas_indicadores` (023) com a dimensão "modelo" e semeia
--        as 4 metas do Marketplace.
--     3. Corrige a Subway Saci (matriz), que hoje é avaliada com as metas do
--        Full Service mas na realidade é Marketplace.
--
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- PRÉ-REQUISITO: migration 023 aplicada.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ENUM + COLUNA EM `unidades`
--    Default 'full_service': é o comportamento implícito que o sistema
--    inteiro já tinha antes desta migration (as únicas metas que existiam
--    eram as do Full Service) — nenhuma unidade muda de avaliação "por
--    baixo" com esta migration, exceto a Subway Saci, corrigida abaixo.
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'modelo_logistico_ifood_enum') then
    create type modelo_logistico_ifood_enum as enum ('marketplace', 'full_service');
  end if;
end $$;

alter table unidades add column if not exists modelo_logistico_ifood modelo_logistico_ifood_enum not null default 'full_service';

-- ---------------------------------------------------------------------
-- 2. HISTÓRICO DE TROCA DO MODELO — nunca sobrescreve, só acumula.
--    Mesmo padrão de lancamentos_financeiros_auditoria (migration 023).
-- ---------------------------------------------------------------------
create table if not exists unidade_modelo_logistico_historico (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  modelo_anterior modelo_logistico_ifood_enum,
  modelo_novo modelo_logistico_ifood_enum not null,
  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,
  usuario_email text,
  motivo text,
  observacao text,
  created_at timestamptz not null default now()
);
create index if not exists idx_umlh_unidade on unidade_modelo_logistico_historico(unidade_id, created_at desc);
create index if not exists idx_umlh_org on unidade_modelo_logistico_historico(organizacao_id);

alter table unidade_modelo_logistico_historico enable row level security;
drop policy if exists rls_umlh_tenant on unidade_modelo_logistico_historico;
create policy rls_umlh_tenant on unidade_modelo_logistico_historico
  for select to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());

-- ---------------------------------------------------------------------
-- 3. METAS POR MODELO — `metas_indicadores` (023) ganha a dimensão modelo.
-- ---------------------------------------------------------------------
alter table metas_indicadores add column if not exists modelo_logistico modelo_logistico_ifood_enum not null default 'full_service';
-- As 4 linhas seedadas na 023 herdam 'full_service' pelo default acima —
-- é exatamente o que elas sempre representaram, nenhum UPDATE necessário.

-- A unique constraint e o índice parcial global da 023 não incluíam modelo;
-- agora que duas linhas globais podem existir por indicador (uma por
-- modelo), eles precisam da coluna nova na chave. Busca o nome real da
-- constraint em vez de supor o nome gerado pelo Postgres — mais seguro:
-- se o nome estivesse errado, um "drop ... if exists" silenciosamente não
-- faria nada e a constraint antiga (sem modelo) bloquearia o INSERT abaixo.
do $$
declare
  v_nome_constraint text;
begin
  -- kcu.column_name é do tipo information_schema.sql_identifier, não text —
  -- precisa do cast explícito, senão o "=" contra o array literal (text[])
  -- não tem operador definido (erro 42883).
  select tc.constraint_name into v_nome_constraint
  from information_schema.table_constraints tc
  where tc.table_name = 'metas_indicadores' and tc.constraint_type = 'UNIQUE'
    and (
      select array_agg(kcu.column_name::text order by kcu.column_name::text)
      from information_schema.key_column_usage kcu
      where kcu.constraint_name = tc.constraint_name and kcu.table_name = 'metas_indicadores'
    ) = array['indicador', 'organizacao_id', 'unidade_id']
  limit 1;

  if v_nome_constraint is not null then
    execute format('alter table metas_indicadores drop constraint %I', v_nome_constraint);
  end if;
end $$;

alter table metas_indicadores drop constraint if exists metas_indicadores_org_uni_ind_modelo_key;
alter table metas_indicadores add constraint metas_indicadores_org_uni_ind_modelo_key
  unique (organizacao_id, unidade_id, indicador, modelo_logistico);

drop index if exists idx_metas_globais_unicas;
create unique index if not exists idx_metas_globais_unicas on metas_indicadores(indicador, modelo_logistico)
  where organizacao_id is null and unidade_id is null;

-- Metas globais do MARKETPLACE. "Taxas de entregadores" (motoboy próprio)
-- não tem meta equivalente para Full Service — a ausência é regra de
-- negócio, modelada explicitamente no backend (INDICADORES_POR_MODELO em
-- dashboardExecutivo.calc.js), não inferida daqui.
insert into metas_indicadores (organizacao_id, unidade_id, indicador, modelo_logistico, meta_ideal, limite) values
  (null, null, 'taxas_comissoes',    'marketplace', 0.1300, 0.1300),
  (null, null, 'servicos_promocoes', 'marketplace', 0.0500, 0.0700),
  (null, null, 'taxas_entregadores', 'marketplace', 0.1200, 0.1500),
  (null, null, 'total_deducoes',     'marketplace', 0.3000, 0.3200)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 4. CORREÇÃO DA SUBWAY SACI — hoje avaliada como Full Service, é Marketplace.
--    Bloco de execução única (idempotente): só corrige e só audita se ainda
--    não estiver correta.
-- ---------------------------------------------------------------------
do $$
declare
  v_unidade_id uuid := '00000000-0000-0000-0000-0000000000a1';
  v_organizacao_id uuid;
  v_modelo_atual modelo_logistico_ifood_enum;
begin
  select organizacao_id, modelo_logistico_ifood into v_organizacao_id, v_modelo_atual
  from unidades where id = v_unidade_id;

  if v_organizacao_id is not null and v_modelo_atual <> 'marketplace' then
    update unidades set modelo_logistico_ifood = 'marketplace' where id = v_unidade_id;

    insert into unidade_modelo_logistico_historico
      (unidade_id, organizacao_id, modelo_anterior, modelo_novo, usuario_nome, motivo)
    values (
      v_unidade_id, v_organizacao_id, v_modelo_atual, 'marketplace',
      'Migration 024 (correção de dados)',
      'Configuração inicial estava incorreta: a Subway Saci opera em modelo Marketplace (motoboy próprio), não Full Service. Corrigido na criação do Dashboard iFood.'
    );
  end if;
end $$;

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente):
--   select id, nome, modelo_logistico_ifood from unidades;
--   select indicador, modelo_logistico, meta_ideal, limite from metas_indicadores order by modelo_logistico, indicador;
--   select * from unidade_modelo_logistico_historico order by created_at desc;
-- =====================================================================
