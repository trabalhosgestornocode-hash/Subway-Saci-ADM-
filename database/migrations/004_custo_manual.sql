-- =====================================================================
-- MIGRATION 004 — Custo manual do produto (override)
-- Permite ALTERAR o custo de um produto pela tela (Produtos/CMV → Editar).
-- Hoje o custo é calculado pela ficha técnica (BOM). Com esta migration,
-- se 'custo_manual' estiver preenchido, ele passa a valer no lugar do
-- cálculo — inclusive na tabela de CMV (que usa fn_custo_produto).
-- custo_manual = NULL -> volta a usar o custo calculado automaticamente.
-- Rode no SQL Editor do Supabase.
-- =====================================================================

alter table produtos add column if not exists custo_manual numeric(12,4);

-- Redefine o custo do produto: usa custo_manual quando definido; senão,
-- explode a ficha técnica até o insumo cru (comportamento original).
create or replace function fn_custo_produto(p_produto_id uuid)
returns numeric language sql stable as $$
  select coalesce(
    (select custo_manual from produtos where id = p_produto_id),
    (
      with recursive expl as (
        select ft.insumo_id, ft.subproduto_id, ft.quantidade::numeric as qtd
        from ficha_tecnica ft
        where ft.produto_id = p_produto_id
        union all
        select ft.insumo_id, ft.subproduto_id, e.qtd * ft.quantidade
        from expl e
        join ficha_tecnica ft on ft.produto_id = e.subproduto_id
        where e.subproduto_id is not null
      )
      select coalesce(sum(e.qtd * i.preco_unitario), 0)
      from expl e
      join insumos i on i.id = e.insumo_id
      where e.insumo_id is not null
    )
  );
$$;
