-- =====================================================================
-- MIGRATION 021 — Insumos manuais + Ficha técnica editável + Histórico
--
-- Dá ao franqueado controle manual sobre INSUMOS, PREÇOS e FICHAS TÉCNICAS,
-- com recálculo automático de custo e CMV dos produtos afetados.
--
-- PRINCÍPIOS (por que cada mudança é segura):
--   * Reutiliza as tabelas que já existem (insumos, ficha_tecnica, produtos).
--     NÃO cria estrutura duplicada.
--   * `ficha_tecnica.quantidade` continua sendo a quantidade na UNIDADE-BASE do
--     insumo (a mesma semântica que fn_custo_produto e a baixa de estoque já
--     usam). As novas colunas unidade_uso/quantidade_informada são só para
--     EXIBIR "76 g" quando a base é kg — o cálculo permanece intacto.
--   * Colunas novas são NULLABLE / com default → linhas existentes seguem
--     válidas e o backend trata a ausência das colunas (best-effort).
--
-- Rode no SQL Editor do Supabase.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. INSUMOS — campos descritivos que faltavam para o cadastro manual
-- ---------------------------------------------------------------------
alter table insumos add column if not exists descricao text;
alter table insumos add column if not exists forma_compra text;              -- "caixa", "pacote", "garrafa"... (descritivo)
alter table insumos add column if not exists preco_atualizado_em timestamptz; -- data da última atualização do preço
alter table insumos add column if not exists created_by uuid references perfis(id) on delete set null; -- quem cadastrou

-- Semente de coerência: para os insumos que já têm preço, marca a data de
-- atualização como a de criação (evita "—" na tela para dados legados).
update insumos set preco_atualizado_em = coalesce(preco_atualizado_em, created_at)
where preco_unitario is not null;

-- ---------------------------------------------------------------------
-- 2. FICHA TÉCNICA — quantidade "como o usuário digitou" + ordenação/ativo
--    `quantidade` (existente) permanece na unidade-base. As duas colunas
--    abaixo guardam a intenção original do usuário só para exibição.
-- ---------------------------------------------------------------------
alter table ficha_tecnica add column if not exists unidade_uso unidade_medida_enum;         -- unidade que o usuário digitou (ex: 'g')
alter table ficha_tecnica add column if not exists quantidade_informada numeric(14,5);       -- valor que o usuário digitou (ex: 76)
alter table ficha_tecnica add column if not exists ordem int not null default 0;
alter table ficha_tecnica add column if not exists ativo boolean not null default true;
alter table ficha_tecnica add column if not exists updated_at timestamptz not null default now();
alter table ficha_tecnica add column if not exists created_by uuid references perfis(id) on delete set null;

drop trigger if exists trg_ficha_upd on ficha_tecnica;
create trigger trg_ficha_upd before update on ficha_tecnica
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- 3. HISTÓRICO DE PREÇO DO INSUMO — nunca sobrescrever silenciosamente
--    Uma linha por alteração de preço/rendimento/unidade de um insumo.
-- ---------------------------------------------------------------------
create table if not exists insumo_historico (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  insumo_id uuid not null references insumos(id) on delete cascade,
  unidade_id uuid references unidades(id) on delete set null,   -- unidade ativa no momento (informativo)
  preco_anterior      numeric(12,4),   -- preço da embalagem antes
  preco_novo          numeric(12,4),   -- preço da embalagem depois
  custo_anterior      numeric(12,6),   -- custo por unidade-base antes
  custo_novo          numeric(12,6),   -- custo por unidade-base depois
  variacao_pct        numeric(10,4),   -- variação % do custo unitário
  unidade_medida_anterior unidade_medida_enum,
  unidade_medida_nova     unidade_medida_enum,
  usuario_id   uuid references perfis(id) on delete set null,
  usuario_nome text,
  usuario_email text,
  observacao text,
  created_at timestamptz not null default now()
);
create index if not exists idx_insumo_hist_insumo on insumo_historico(insumo_id, created_at desc);
create index if not exists idx_insumo_hist_org    on insumo_historico(organizacao_id);

-- Segue o padrão do projeto: RLS ligado (o backend usa service_role e ignora
-- o RLS; o acesso do frontend é 100% via API autenticada e escopada).
alter table insumo_historico enable row level security;

-- ---------------------------------------------------------------------
-- 4. CUSTO DO PRODUTO — respeitar linhas de ficha inativas
--    Reescreve fn_custo_produto para IGNORAR componentes ativo=false.
--    Como o default de `ativo` é true, o resultado para dados existentes é
--    idêntico ao anterior — nenhuma regressão de custo/CMV.
-- ---------------------------------------------------------------------
create or replace function fn_custo_produto(p_produto_id uuid)
returns numeric language sql stable as $$
  select coalesce(
    (select custo_manual from produtos where id = p_produto_id),
    (
      with recursive expl as (
        select ft.insumo_id, ft.subproduto_id, ft.quantidade::numeric as qtd
        from ficha_tecnica ft
        where ft.produto_id = p_produto_id and coalesce(ft.ativo, true)
        union all
        select ft.insumo_id, ft.subproduto_id, e.qtd * ft.quantidade
        from expl e
        join ficha_tecnica ft on ft.produto_id = e.subproduto_id and coalesce(ft.ativo, true)
        where e.subproduto_id is not null
      )
      select coalesce(sum(e.qtd * i.preco_unitario), 0)
      from expl e
      join insumos i on i.id = e.insumo_id
      where e.insumo_id is not null
    )
  );
$$;

-- =====================================================================
-- COMBOS (evolução futura — NÃO implementar agora):
--   A ficha_tecnica já é auto-referenciável (subproduto_id) e o custo é
--   recursivo, então um combo é apenas um produto cujas linhas apontam para
--   OUTROS produtos. Para grupos de escolha/opcionais bastará, no futuro,
--   uma tabela ficha_grupos (produto_id, nome, min, max) + uma FK opcional
--   grupo_id em ficha_tecnica — sem quebrar nada do que existe aqui.
-- =====================================================================

-- Verificação:
--   select column_name from information_schema.columns
--   where table_name = 'ficha_tecnica' order by ordinal_position;
--   select * from insumo_historico order by created_at desc limit 10;
