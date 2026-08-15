-- =====================================================================
-- MIGRATION 043 — Reverte a migration 042 (desenho errado, corrigido no
-- mesmo dia antes de qualquer dado real existir)
-- =====================================================================
-- POR QUE ESTA MIGRATION EXISTE
--   A migration 042 criou `bonificacao_indicadores_manuais` com
--   granularidade MENSAL (1 valor por unidade+indicador+mês) para REV,
--   Pesquisas, Avaliação/Nota iFood e Pedidos com Chamado. O usuário
--   esclareceu, ainda no mesmo dia (antes de qualquer lançamento real
--   existir nessa tabela), que esses 4 indicadores precisam de
--   ACOMPANHAMENTO DIÁRIO — um calendário igual ao da Visio, não um valor
--   único por mês.
--
--   A tabela diária `bonificacao_lancamentos_diarios` já tinha as 4 colunas
--   certas pra isso desde a migration 028 (rev_nota, pesquisas_qtd,
--   avaliacao_ifood, pedidos_chamado_pct) — a 042 criou uma segunda fonte
--   de verdade paralela por engano. Como nenhuma UI publicada chegou a
--   escrever na tabela nova, a reversão é limpa: sem migração de dado.
--
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- =====================================================================

drop trigger if exists trg_bim_upd on bonificacao_indicadores_manuais;
drop table if exists bonificacao_indicadores_manuais;
