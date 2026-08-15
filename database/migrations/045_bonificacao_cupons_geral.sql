-- =====================================================================
-- MIGRATION 045 — Cupons válidos/de vendas do novo Relatório de Vendas
-- =====================================================================
-- POR QUE ESTA MIGRATION EXISTE
--   O relatório "Geral" da Bonificação Mensal passou a ser o "Relatório de
--   Vendas" da Visio (layout novo — ver visio-parser.js#parseVisioSalesReport),
--   que não traz mais PPD, mas traz Ticket Médio (já existia coluna,
--   `ticket_medio`, agora passa a ser preenchida automaticamente) e a
--   quantidade de cupons válidos/de vendas do dia.
--
--   `cupons_validos_geral` é usado para computar o Ticket Médio MENSAL
--   ponderado (faturamento acumulado ÷ cupons acumulados — nunca a média
--   simples dos tickets diários, ver bonificacaoMensal.calc.js#ticketMedioPonderado).
--   `cupons_vendas_geral` é guardado só para auditoria/conferência (item 3
--   das instruções: "eventualmente cupons para auditoria/validação") — hoje
--   nenhum cálculo de bonificação depende dele.
--
--   `ppd_geral` NÃO é removida — o relatório antigo já gravou dado real
--   nela e apagar schema é sempre mais arriscado de reverter que manter uma
--   coluna que simplesmente para de ser preenchida em importações novas.
--
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- =====================================================================

alter table bonificacao_lancamentos_diarios
  add column if not exists cupons_validos_geral int,
  add column if not exists cupons_vendas_geral int;
