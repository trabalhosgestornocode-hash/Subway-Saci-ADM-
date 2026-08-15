-- =====================================================================
-- MIGRATION 044 — Corrige a faixa 3 da meta de Pesquisas (120 -> R$50)
-- =====================================================================
-- POR QUE ESTA MIGRATION EXISTE
--   A migration 028 semeou a faixa 3 de Pesquisas como "120 pesquisas: R$
--   100,00", com o comentário de que a planilha original da época tinha um
--   "bug" (dizia R$ 50) e por isso o valor foi "corrigido" para R$ 100 no
--   seed.
--
--   Auditoria feita em 15/08/2026 contra a planilha oficial de referência
--   (METAS LOJAS.xlsx, aba SUBWAY SACI) confirma "120 Pesquisas: R$ 50,00" —
--   IGUAL à faixa 2 (90 pesquisas também vale R$ 50). Ou seja: não era bug
--   nenhum, a correção da migration 028 é que estava errada. Esta migration
--   reverte para o valor real (idempotente — pode rodar de novo com
--   segurança, sempre convergindo pro mesmo estado).
--
--   Aplica na unidade REAL da Subway Saci e na unidade de TESTE (migration
--   041, que replica as metas da Saci para os testes automatizados) — as
--   duas precisam continuar espelhando o mesmo valor.
-- =====================================================================

update bonificacao_metas_faixas set bonus = 50.00
where ordem = 3 and bonus = 100.00 and meta_id in (
  select m.id from bonificacao_metas m
  where m.unidade_id in (
    '00000000-0000-0000-0000-0000000000a1', -- Subway Saci (real)
    '00000000-0000-0000-0000-0000000000b1'  -- unidade de teste (migration 041)
  )
  and m.indicador = 'pesquisas'
);
