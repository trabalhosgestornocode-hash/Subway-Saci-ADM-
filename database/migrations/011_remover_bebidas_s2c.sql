-- =====================================================================
-- MIGRATION 011 — Remover as bebidas S2C (redundantes)
-- Copo 300 ml, Copo 500 ml e Suco MB foram criados na migration 005, mas não
-- têm correspondente no cardápio de balcão (Out.25) e são redundantes com as
-- bebidas já existentes (Refrigerante Lata/PET, Suco 290ml, Água).
-- Excluir o produto remove os preços (produto_precos) em cascata.
-- Idempotente. Rode no SQL Editor do Supabase.
-- =====================================================================
begin;

delete from produtos
 where organizacao_id = '00000000-0000-0000-0000-000000000001'
   and sku in ('S2C-BEB-C300','S2C-BEB-C500','S2C-BEB-SUCOMB');

commit;

-- Depois de 010 + 011, todas as tabelas de balcão ficam com o mesmo total:
--   48 (base) + 10 (dobro de recheio) = 58 produtos por tabela.
