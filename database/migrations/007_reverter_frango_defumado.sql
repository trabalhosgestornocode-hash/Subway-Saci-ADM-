-- =====================================================================
-- MIGRATION 007 — Reverter a 006 (Frango Defumado volta ao original)
-- A 006 tinha trocado o recheio para 75g de frango cubos puro. O usuário
-- pediu para VOLTAR ao original: 30g de Frango Cubos + 45g de Cream Cheese
-- (custo R$2,35, batendo com a planilha).
-- Idempotente. Rode no SQL Editor do Supabase.
-- =====================================================================
begin;

-- 1) Frango Cubos volta para 30g (0,030)
update ficha_tecnica set quantidade = 0.030
 where produto_id = 'cd1cdfc7-e7dc-496b-8f42-4e6c71b93278'   -- Frango Defumado 15cm
   and insumo_id  = 'f4f00397-25c0-4eca-a472-f9b8836007ad';  -- FRANGO Cubos CX C/2X2KG BRF

-- 2) Recoloca o Cream Cheese 45g (0,045) — apaga antes p/ ser idempotente
delete from ficha_tecnica
 where produto_id = 'cd1cdfc7-e7dc-496b-8f42-4e6c71b93278'
   and insumo_id  = '9297540b-2d5c-4b16-9bb1-7ce1fe13e110';  -- CREAM CHEESE POLENGHI
insert into ficha_tecnica (produto_id, insumo_id, quantidade)
  values ('cd1cdfc7-e7dc-496b-8f42-4e6c71b93278','9297540b-2d5c-4b16-9bb1-7ce1fe13e110',0.045);

-- 3) Recalcula o custo (o 30cm é 2× o 15cm)
update produtos set custo_cache = fn_custo_produto(id)
 where organizacao_id = '00000000-0000-0000-0000-000000000001'
   and nome in ('Frango Defumado 15cm','Frango Defumado 30cm');

commit;

-- Conferência (opcional): deve voltar a bater com a planilha
-- select nome, custo_cache from produtos where nome in ('Frango Defumado 15cm','Frango Defumado 30cm');
--   Frango Defumado 15cm ~ 6,69   |   Frango Defumado 30cm ~ 13,39
