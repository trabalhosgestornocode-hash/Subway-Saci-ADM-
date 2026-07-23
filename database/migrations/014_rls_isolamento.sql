-- =====================================================================
-- MIGRATION 014 — RLS real por tenant (organização / unidade)
-- =====================================================================
-- OBJETIVO (Fase 1 — endurecer isolamento)
--   Criar policies de Row Level Security POR TENANT em todas as tabelas de
--   dados, para que o banco recuse acesso cruzado entre empresas/unidades
--   MESMO se a camada de aplicação falhar. É defesa em profundidade.
--
-- IMPACTO NO SISTEMA ATUAL: NENHUM.
--   * O backend usa a chave `service_role`, que IGNORA o RLS por design.
--     Portanto estas policies não mudam em nada o comportamento da API hoje.
--   * O frontend não acessa o banco direto (só via API), então o acesso
--     `authenticated` continua sem ser exercido — estas policies ficam como
--     camada latente, prontas para o dia em que o front usar a chave anon.
--   * `anon` (sem login) permanece em deny-all (nenhuma policy o contempla).
--
-- SEGURANÇA / MODELO
--   * Escopo de tenant vem do PERFIL do usuário (perfis), nunca do cliente.
--   * Modelo atual = 1 usuário -> 1 organização + 1 unidade. Quando vier o
--     vínculo usuário<->várias unidades (Fase 2), evoluir auth_unidade_id().
--   * Superadmin de plataforma (Crescer Com Delivery) ainda NÃO existe no
--     modelo; quando existir, estas policies ganharão um "OR is_superadmin()".
--   * Autorização fina por papel (o que cada papel pode ler/escrever direto)
--     é Fase 4 — aqui tratamos apenas ISOLAMENTO entre tenants.
--
-- IDEMPOTÊNCIA
--   * Recria funções com CREATE OR REPLACE.
--   * Cada tabela é tratada só se existir (to_regclass), então esta migration
--     roda com segurança independentemente de quais migrations anteriores
--     (002, 012, 013...) já foram aplicadas.
--   * DROP POLICY IF EXISTS antes de cada CREATE POLICY -> pode reexecutar.
--
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. HELPERS (security definer: rodam ignorando RLS, evitando recursão
--    quando a própria policy de `perfis` consulta `perfis`).
-- ---------------------------------------------------------------------
create or replace function auth_organizacao_id()
returns uuid language sql stable security definer set search_path = public as $$
  select organizacao_id from perfis where id = auth.uid();
$$;

create or replace function auth_unidade_id()
returns uuid language sql stable security definer set search_path = public as $$
  select unidade_id from perfis where id = auth.uid();
$$;

-- Remove as policies-EXEMPLO criadas no schema.sql (serão substituídas pelas
-- versões completas, com WITH CHECK, abaixo). Não falha se não existirem.
drop policy if exists org_isolada on organizacoes;
drop policy if exists produtos_por_org on produtos;

-- ---------------------------------------------------------------------
-- 1. TABELAS COM organizacao_id (escopo: organização)
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  org_tables text[] := array[
    'unidades','perfis','categorias','fornecedores','insumos','produtos',
    'canais_venda','produto_historico','sw_mapeamento_produtos','sw_combo_componentes'
  ];
begin
  foreach t in array org_tables loop
    if to_regclass(format('public.%I', t)) is null then
      continue;  -- tabela ainda não criada (migration anterior não rodada)
    end if;
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists rls_%s_tenant on public.%I;', t, t);
    execute format($f$
      create policy rls_%s_tenant on public.%I
        for all to authenticated
        using (organizacao_id = auth_organizacao_id())
        with check (organizacao_id = auth_organizacao_id());
    $f$, t, t);
  end loop;
end $$;

-- organizacoes: o tenant é a própria linha (id), não uma coluna organizacao_id.
alter table public.organizacoes enable row level security;
drop policy if exists rls_organizacoes_tenant on public.organizacoes;
create policy rls_organizacoes_tenant on public.organizacoes
  for all to authenticated
  using (id = auth_organizacao_id())
  with check (id = auth_organizacao_id());

-- ---------------------------------------------------------------------
-- 2. TABELAS COM unidade_id (escopo: unidade)
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  und_tables text[] := array[
    'estoque','movimentacoes_estoque','lotes','pedidos_compra','notas_fiscais',
    'vendas','alertas','notificacoes','insights_ia','parametros',
    'importacoes_vendas','sw_faturamento_diario','sw_produtos_vendidos','divergencias_vendas'
  ];
begin
  foreach t in array und_tables loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists rls_%s_tenant on public.%I;', t, t);
    execute format($f$
      create policy rls_%s_tenant on public.%I
        for all to authenticated
        using (unidade_id = auth_unidade_id())
        with check (unidade_id = auth_unidade_id());
    $f$, t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. TABELAS-FILHAS SEM COLUNA DE TENANT (herdam via pai)
-- ---------------------------------------------------------------------

-- ficha_tecnica -> produtos (organização)
do $$ begin
  if to_regclass('public.ficha_tecnica') is not null then
    alter table public.ficha_tecnica enable row level security;
    drop policy if exists rls_ficha_tecnica_tenant on public.ficha_tecnica;
    create policy rls_ficha_tecnica_tenant on public.ficha_tecnica
      for all to authenticated
      using (exists (select 1 from public.produtos p
             where p.id = ficha_tecnica.produto_id and p.organizacao_id = auth_organizacao_id()))
      with check (exists (select 1 from public.produtos p
             where p.id = ficha_tecnica.produto_id and p.organizacao_id = auth_organizacao_id()));
  end if;
end $$;

-- produto_precos -> produtos (organização)
do $$ begin
  if to_regclass('public.produto_precos') is not null then
    alter table public.produto_precos enable row level security;
    drop policy if exists rls_produto_precos_tenant on public.produto_precos;
    create policy rls_produto_precos_tenant on public.produto_precos
      for all to authenticated
      using (exists (select 1 from public.produtos p
             where p.id = produto_precos.produto_id and p.organizacao_id = auth_organizacao_id()))
      with check (exists (select 1 from public.produtos p
             where p.id = produto_precos.produto_id and p.organizacao_id = auth_organizacao_id()));
  end if;
end $$;

-- pedidos_compra_itens -> pedidos_compra (unidade)
do $$ begin
  if to_regclass('public.pedidos_compra_itens') is not null then
    alter table public.pedidos_compra_itens enable row level security;
    drop policy if exists rls_pedidos_compra_itens_tenant on public.pedidos_compra_itens;
    create policy rls_pedidos_compra_itens_tenant on public.pedidos_compra_itens
      for all to authenticated
      using (exists (select 1 from public.pedidos_compra pc
             where pc.id = pedidos_compra_itens.pedido_compra_id and pc.unidade_id = auth_unidade_id()))
      with check (exists (select 1 from public.pedidos_compra pc
             where pc.id = pedidos_compra_itens.pedido_compra_id and pc.unidade_id = auth_unidade_id()));
  end if;
end $$;

-- divergencias_compra -> pedidos_compra (unidade)
do $$ begin
  if to_regclass('public.divergencias_compra') is not null then
    alter table public.divergencias_compra enable row level security;
    drop policy if exists rls_divergencias_compra_tenant on public.divergencias_compra;
    create policy rls_divergencias_compra_tenant on public.divergencias_compra
      for all to authenticated
      using (exists (select 1 from public.pedidos_compra pc
             where pc.id = divergencias_compra.pedido_compra_id and pc.unidade_id = auth_unidade_id()))
      with check (exists (select 1 from public.pedidos_compra pc
             where pc.id = divergencias_compra.pedido_compra_id and pc.unidade_id = auth_unidade_id()));
  end if;
end $$;

-- vendas_itens -> vendas (unidade)
do $$ begin
  if to_regclass('public.vendas_itens') is not null then
    alter table public.vendas_itens enable row level security;
    drop policy if exists rls_vendas_itens_tenant on public.vendas_itens;
    create policy rls_vendas_itens_tenant on public.vendas_itens
      for all to authenticated
      using (exists (select 1 from public.vendas v
             where v.id = vendas_itens.venda_id and v.unidade_id = auth_unidade_id()))
      with check (exists (select 1 from public.vendas v
             where v.id = vendas_itens.venda_id and v.unidade_id = auth_unidade_id()));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. VERIFICAÇÃO (rode separadamente para conferir)
-- ---------------------------------------------------------------------
-- Tabelas do schema public: RLS ligado? Quantas policies?
--   select t.tablename,
--          t.rowsecurity as rls_on,
--          count(p.policyname) as policies
--   from pg_tables t
--   left join pg_policies p on p.schemaname = t.schemaname and p.tablename = t.tablename
--   where t.schemaname = 'public'
--   group by t.tablename, t.rowsecurity
--   order by t.tablename;
--
-- Esperado: rls_on = true em todas; policies >= 1 nas tabelas de dados.
-- (views não aparecem aqui — herdam a segurança das tabelas base.)
-- =====================================================================
-- FIM
-- =====================================================================
