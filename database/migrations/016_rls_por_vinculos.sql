-- =====================================================================
-- MIGRATION 016 — "Virada" do RLS: isolamento por VÍNCULOS + superadmin
-- =====================================================================
-- OBJETIVO
--   Substituir as policies da migration 014 (que usavam o vínculo ÚNICO de
--   `perfis`) por policies baseadas nos VÍNCULOS N:N criados na 015:
--     * usuário acessa as organizações/unidades às quais tem vínculo ATIVO
--       (usuarios_organizacoes / usuarios_unidades);
--     * `platform_superadmin` é exceção controlada com acesso global
--       (is_platform_superadmin()). O contexto explícito ("Acessar organização")
--       é imposto pela APLICAÇÃO, não pelo RLS — o RLS apenas PERMITE o acesso.
--
-- PRÉ-REQUISITOS: migrations 014 e 015 já aplicadas (helpers auth_organizacao_ids,
--   auth_unidade_ids, is_platform_superadmin e as tabelas de vínculo existem).
--
-- IMPACTO NO APP: NENHUM. O backend usa service_role (ignora RLS). Isto só
--   muda a regra do caminho autenticado direto (chave anon + JWT do usuário).
--
-- IDEMPOTENTE: reescreve as MESMAS policies `rls_<tabela>_tenant` da 014
--   (drop + create), então pode ser reexecutada. Cada tabela só é tratada se
--   existir (to_regclass).
--
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABELAS COM organizacao_id (escopo: organização, por vínculo)
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
      continue;
    end if;
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists rls_%s_tenant on public.%I;', t, t);
    execute format($f$
      create policy rls_%s_tenant on public.%I
        for all to authenticated
        using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin())
        with check (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());
    $f$, t, t);
  end loop;
end $$;

-- organizacoes: o tenant é a própria linha (id).
alter table public.organizacoes enable row level security;
drop policy if exists rls_organizacoes_tenant on public.organizacoes;
create policy rls_organizacoes_tenant on public.organizacoes
  for all to authenticated
  using (id in (select auth_organizacao_ids()) or is_platform_superadmin())
  with check (id in (select auth_organizacao_ids()) or is_platform_superadmin());

-- ---------------------------------------------------------------------
-- 2. TABELAS COM unidade_id (escopo: unidade, por vínculo)
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
        using (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
        with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());
    $f$, t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. TABELAS-FILHAS SEM COLUNA DE TENANT (herdam via pai)
-- ---------------------------------------------------------------------

-- ficha_tecnica -> produtos (organização, por vínculo)
do $$ begin
  if to_regclass('public.ficha_tecnica') is not null then
    alter table public.ficha_tecnica enable row level security;
    drop policy if exists rls_ficha_tecnica_tenant on public.ficha_tecnica;
    create policy rls_ficha_tecnica_tenant on public.ficha_tecnica
      for all to authenticated
      using (is_platform_superadmin() or exists (select 1 from public.produtos p
             where p.id = ficha_tecnica.produto_id and p.organizacao_id in (select auth_organizacao_ids())))
      with check (is_platform_superadmin() or exists (select 1 from public.produtos p
             where p.id = ficha_tecnica.produto_id and p.organizacao_id in (select auth_organizacao_ids())));
  end if;
end $$;

-- produto_precos -> produtos (organização, por vínculo)
do $$ begin
  if to_regclass('public.produto_precos') is not null then
    alter table public.produto_precos enable row level security;
    drop policy if exists rls_produto_precos_tenant on public.produto_precos;
    create policy rls_produto_precos_tenant on public.produto_precos
      for all to authenticated
      using (is_platform_superadmin() or exists (select 1 from public.produtos p
             where p.id = produto_precos.produto_id and p.organizacao_id in (select auth_organizacao_ids())))
      with check (is_platform_superadmin() or exists (select 1 from public.produtos p
             where p.id = produto_precos.produto_id and p.organizacao_id in (select auth_organizacao_ids())));
  end if;
end $$;

-- pedidos_compra_itens -> pedidos_compra (unidade, por vínculo)
do $$ begin
  if to_regclass('public.pedidos_compra_itens') is not null then
    alter table public.pedidos_compra_itens enable row level security;
    drop policy if exists rls_pedidos_compra_itens_tenant on public.pedidos_compra_itens;
    create policy rls_pedidos_compra_itens_tenant on public.pedidos_compra_itens
      for all to authenticated
      using (is_platform_superadmin() or exists (select 1 from public.pedidos_compra pc
             where pc.id = pedidos_compra_itens.pedido_compra_id and pc.unidade_id in (select auth_unidade_ids())))
      with check (is_platform_superadmin() or exists (select 1 from public.pedidos_compra pc
             where pc.id = pedidos_compra_itens.pedido_compra_id and pc.unidade_id in (select auth_unidade_ids())));
  end if;
end $$;

-- divergencias_compra -> pedidos_compra (unidade, por vínculo)
do $$ begin
  if to_regclass('public.divergencias_compra') is not null then
    alter table public.divergencias_compra enable row level security;
    drop policy if exists rls_divergencias_compra_tenant on public.divergencias_compra;
    create policy rls_divergencias_compra_tenant on public.divergencias_compra
      for all to authenticated
      using (is_platform_superadmin() or exists (select 1 from public.pedidos_compra pc
             where pc.id = divergencias_compra.pedido_compra_id and pc.unidade_id in (select auth_unidade_ids())))
      with check (is_platform_superadmin() or exists (select 1 from public.pedidos_compra pc
             where pc.id = divergencias_compra.pedido_compra_id and pc.unidade_id in (select auth_unidade_ids())));
  end if;
end $$;

-- vendas_itens -> vendas (unidade, por vínculo)
do $$ begin
  if to_regclass('public.vendas_itens') is not null then
    alter table public.vendas_itens enable row level security;
    drop policy if exists rls_vendas_itens_tenant on public.vendas_itens;
    create policy rls_vendas_itens_tenant on public.vendas_itens
      for all to authenticated
      using (is_platform_superadmin() or exists (select 1 from public.vendas v
             where v.id = vendas_itens.venda_id and v.unidade_id in (select auth_unidade_ids())))
      with check (is_platform_superadmin() or exists (select 1 from public.vendas v
             where v.id = vendas_itens.venda_id and v.unidade_id in (select auth_unidade_ids())));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- NOTA: as funções singulares auth_organizacao_id()/auth_unidade_id() (014)
-- deixam de ser usadas pelas policies, mas ficam preservadas (não removê-las
-- evita quebrar qualquer dependência). O modelo agora é multi-vínculo.
--
-- CONTEXTO EXPLÍCITO DO SUPERADMIN: o RLS concede acesso global ao superadmin;
-- limitar a visão à organização "selecionada" (ação "Acessar organização") é
-- responsabilidade da APLICAÇÃO/backend, que também deve gravar em
-- plataforma_acessos para auditoria.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 4. VERIFICAÇÃO (rode separadamente)
--   select tablename, count(*) as policies
--   from pg_policies where schemaname='public' and policyname like 'rls_%_tenant'
--   group by tablename order by tablename;
--   -- Confira que cada tabela de dados tem exatamente 1 policy rls_*_tenant.
-- =====================================================================
-- FIM
-- =====================================================================
