-- =====================================================================
-- MIGRATION 005 — Saladas batendo com a planilha + itens faltantes
-- Fonte: "Custo Subway - Planilha de Custos de Produtos - CMV.xlsx"
--   (abas Salada, Recheio, Bebidas).
--
-- 1) SALADAS: a planilha só traz o TOTAL de cada salada (sem receita
--    detalhada), então fixamos o custo via custo_manual = valor da planilha.
-- 2) ADICIONAIS "dobro de recheio" que faltavam (cada um = a porção de
--    proteína do sanduíche; conferido item a item com a planilha).
-- 3) BEBIDAS que faltavam (Copo 300/500 ml e Suco MB).
--
-- ⚠️ Requer a MIGRATION 004 (coluna custo_manual + fn_custo_produto).
--    Rode 004 antes desta. Idempotente (pode rodar de novo).
-- Rode no SQL Editor do Supabase.
-- =====================================================================
begin;

alter table produtos add column if not exists custo_manual numeric(12,4); -- segurança

-- ---------- 1) SALADAS: custo = valor da planilha ----------
update produtos p set custo_manual = v.c
from (values
  ('Salada Frango Empanado', 6.0465),
  ('Salada Frango Steak',     7.0735),
  ('Salada Presunto',         6.7871),
  ('Salada Churrasco',        6.8258),
  ('Salada BMT',              8.4182),
  ('Salada Steack Cheddar',   8.0760),
  ('Salada Frango Defumado',  8.5647),
  ('Salada Supreme',          8.4572),
  ('Salada Vegetariano',      4.9688),
  ('Salada Carne Seca',       7.1546)
) as v(nome, c)
where p.organizacao_id = '00000000-0000-0000-0000-000000000001' and p.nome = v.nome;

-- ---------- 2 e 3) Adicionais "dobro de recheio" + bebidas faltantes ----------
delete from produtos where organizacao_id = '00000000-0000-0000-0000-000000000001' and sku like 'S2C-%';

insert into produtos (organizacao_id, nome, tipo, tamanho, vendavel, sku, custo_manual) values
  -- Adicionais (dobro de recheio) — custo = porção da proteína (bate com a planilha)
  ('00000000-0000-0000-0000-000000000001','Dobro Recheio Empanado',      'adicional','unico',true,'S2C-DR-EMP',2.1046),
  ('00000000-0000-0000-0000-000000000001','Dobro Recheio Frango',        'adicional','unico',true,'S2C-DR-FRA',1.8182),
  ('00000000-0000-0000-0000-000000000001','Dobro Recheio Churrasco',     'adicional','unico',true,'S2C-DR-CHU',2.1858),
  ('00000000-0000-0000-0000-000000000001','Dobro Recheio Carne Seca',    'adicional','unico',true,'S2C-DR-CSE',3.4493),
  ('00000000-0000-0000-0000-000000000001','Dobro Recheio BMT',           'adicional','unico',true,'S2C-DR-BMT',3.1072),
  ('00000000-0000-0000-0000-000000000001','Dobro Recheio Steack Cheddar','adicional','unico',true,'S2C-DR-STK',3.5959),
  ('00000000-0000-0000-0000-000000000001','Dobro Recheio Frango Defumado','adicional','unico',true,'S2C-DR-DEF',2.3455),
  ('00000000-0000-0000-0000-000000000001','Dobro Teriack',               'adicional','unico',true,'S2C-DR-TER',3.4884),
  ('00000000-0000-0000-0000-000000000001','Dobro Supreme',               'adicional','unico',true,'S2C-DR-SUP',6.8134),
  ('00000000-0000-0000-0000-000000000001','Dobro Mussarela',             'adicional','unico',true,'S2C-DR-MUS',0.6048),
  -- Bebidas faltantes
  ('00000000-0000-0000-0000-000000000001','Copo 300 ml','bebida','unico',true,'S2C-BEB-C300',1.2010),
  ('00000000-0000-0000-0000-000000000001','Copo 500 ml','bebida','unico',true,'S2C-BEB-C500',2.6821),
  ('00000000-0000-0000-0000-000000000001','Suco MB',    'bebida','unico',true,'S2C-BEB-SUCOMB',3.3323);

-- Preços (balcão, tabela A) = "Venda" da planilha
insert into produto_precos (produto_id, canal, tabela, preco, desatualizado)
select p.id, 'balcao'::canal, 'A', v.preco, false
from (values
  ('S2C-DR-EMP',6),('S2C-DR-FRA',6),('S2C-DR-CHU',6.5),('S2C-DR-CSE',9.5),('S2C-DR-BMT',9.5),
  ('S2C-DR-STK',7.5),('S2C-DR-DEF',7.5),('S2C-DR-TER',7.5),('S2C-DR-SUP',10.5),('S2C-DR-MUS',4),
  ('S2C-BEB-C300',5),('S2C-BEB-C500',8.5),('S2C-BEB-SUCOMB',8.5)
) as v(sku, preco)
join produtos p on p.sku = v.sku and p.organizacao_id = '00000000-0000-0000-0000-000000000001'
on conflict (produto_id, canal, tabela) do update set preco = excluded.preco;

-- Atualiza o cache de custo (fn_custo_produto já respeita custo_manual)
update produtos set custo_cache = fn_custo_produto(id)
where organizacao_id = '00000000-0000-0000-0000-000000000001'
  and (sku like 'S2C-%' or nome like 'Salada %');

commit;
