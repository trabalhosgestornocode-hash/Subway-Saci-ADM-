-- =====================================================================
-- MIGRATION 038 — Parser Food Delivery: identificação de operação
-- =====================================================================
-- OBJETIVO
--   O relatório de food delivery mistura pedidos de mais de uma operação
--   no mesmo arquivo (mesma conta de entrega) — ex.: Subway Saci e Açaí no
--   Grau. Esta migration adiciona a cada pedido a operação identificada
--   (ver backend/src/modules/parser-food-delivery/parserFoodDelivery.operacao.js,
--   a camada centralizada de classificação) para que SOMENTE pedidos da
--   Subway entrem nos valores financeiros e no desempenho dos entregadores.
--
--   `status_conciliacao` deixa de ser NOT NULL: só faz sentido para pedidos
--   'subway' (a conciliação — incluído/excluído/cancelado com taxa — é um
--   conceito da Subway). Pedidos de outra operação ficam com o valor NULL,
--   nunca um dos 3 status (evita "cancelado_com_taxa" de um pedido que nem
--   é da Subway aparecer misturado nos totais).
--
--   `parser_fd_importacoes` ganha o resumo da filtragem (Subway/Açaí/
--   indefinido) e se a coluna "Detalhes do pedido" foi encontrada no
--   arquivo — sem essa coluna não dá pra separar por operação, e o
--   histórico precisa deixar isso visível, não fingir certeza que não existe.
--
-- PRÉ-REQUISITO: migration 037 aplicada.
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PEDIDOS — operação identificada + motivo (auditoria dos ignorados).
-- ---------------------------------------------------------------------
alter table parser_fd_pedidos add column if not exists operacao text not null default 'subway'
  check (operacao in ('subway', 'acai_no_grau', 'revisao_necessaria'));
alter table parser_fd_pedidos add column if not exists operacao_motivo text;
alter table parser_fd_pedidos add column if not exists detalhes_pedido text;

-- status_conciliacao só existe para pedidos 'subway' — os demais ficam NULL.
alter table parser_fd_pedidos alter column status_conciliacao drop not null;

create index if not exists idx_pfdped_operacao on parser_fd_pedidos(importacao_id, operacao);

-- ---------------------------------------------------------------------
-- 2. IMPORTAÇÕES — resumo da filtragem por operação.
-- ---------------------------------------------------------------------
alter table parser_fd_importacoes add column if not exists pedidos_subway int not null default 0;
alter table parser_fd_importacoes add column if not exists pedidos_acai int not null default 0;
alter table parser_fd_importacoes add column if not exists pedidos_revisao int not null default 0;
alter table parser_fd_importacoes add column if not exists coluna_detalhes_encontrada boolean not null default true;

-- Backfill de importações feitas ANTES desta migration (se houver): eram
-- todas tratadas como uma operação só, sem filtragem — pedidos_subway
-- assume o total já gravado, pra não deixar a coluna nova zerada num
-- histórico que já existia.
update parser_fd_importacoes set pedidos_subway = total_pedidos where pedidos_subway = 0 and total_pedidos > 0;
