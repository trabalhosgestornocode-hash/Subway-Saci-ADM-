-- =====================================================================
-- MIGRATION 035 — Financeiro do lançamento diário vira opcional
-- =====================================================================
-- OBJETIVO
--   O iFood só consolida o financeiro do dia com 1 dia de atraso — no dia
--   D, só dá pra saber o financeiro fechado até D-1. A etapa "Financeiro"
--   do lançamento diário passa a só ser pedida quando a data lançada é
--   exatamente "ontem"; nos demais dias, só Situação + Desempenho, e o
--   lançamento fica como RASCUNHO até o financeiro chegar (ver
--   dashboardExecutivo.service.js#normalizarDadosLancamento).
--
--   `valor_vendas_ifood` era o ÚLTIMO campo financeiro ainda NOT NULL — os
--   outros 4 (taxas_comissoes, servicos_promocoes, taxas_entregadores,
--   outras_deducoes) já viraram nuláveis na migration 026. Mesmo padrão
--   aplicado aqui.
--
--   O invariante "um dia FINALIZADO com situacao='normal' sempre tem
--   valor_vendas_ifood" continua valendo — só não é mais garantido pela
--   coluna em si (que agora aceita null pra sustentar o rascunho), e sim
--   por uma CHECK de tabela + pela validação do service (dupla camada,
--   igual o resto do projeto já faz).
--
-- NÃO DESTRUTIVO / IDEMPOTENTE. Nenhuma linha existente muda de valor —
-- todo lançamento já finalizado já tem valor_vendas_ifood preenchido, então
-- a nova CHECK passa de primeira.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

alter table lancamentos_financeiros_diarios alter column valor_vendas_ifood drop not null;
alter table lancamentos_financeiros_diarios alter column valor_vendas_ifood drop default;

alter table lancamentos_financeiros_diarios drop constraint if exists lancamentos_financeiros_diarios_valor_vendas_ifood_check;
alter table lancamentos_financeiros_diarios add constraint lfd_valor_vendas_ifood_check
  check (valor_vendas_ifood is null or valor_vendas_ifood >= 0);

-- Reforço de tabela: um dia finalizado com situação normal nunca fica sem
-- o financeiro — mesmo que algum caminho novo no backend esqueça de
-- validar isso, o banco recusa.
alter table lancamentos_financeiros_diarios drop constraint if exists lfd_financeiro_exigido_ao_finalizar;
alter table lancamentos_financeiros_diarios add constraint lfd_financeiro_exigido_ao_finalizar
  check (status <> 'finalizado' or situacao <> 'normal' or valor_vendas_ifood is not null);

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente):
--   select column_name, is_nullable, column_default from information_schema.columns
--   where table_name = 'lancamentos_financeiros_diarios' and column_name = 'valor_vendas_ifood';
--   -- is_nullable deve ser 'YES'.
--
--   -- Não deve haver NENHUM finalizado+normal sem financeiro (confirma que
--   -- a CHECK nova não quebra dado existente):
--   select count(*) from lancamentos_financeiros_diarios
--   where status = 'finalizado' and situacao = 'normal' and valor_vendas_ifood is null;
--   -- Esperado: 0.
-- =====================================================================
-- FIM
-- =====================================================================
