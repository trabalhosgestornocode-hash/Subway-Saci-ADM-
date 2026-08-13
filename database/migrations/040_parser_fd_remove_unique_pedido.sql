-- =====================================================================
-- MIGRATION 040 — Parser Food Delivery: remove a unicidade de N Pedido
-- =====================================================================
-- OBJETIVO
--   `uq_pfdped_importacao_pedido` (migration 037) assumia que "N Pedido" é
--   único dentro de uma importação. Na prática não é: um relatório real
--   (mesmo de um único dia) pode trazer o mesmo código de pedido em mais de
--   uma linha, e isso travava a confirmação inteira com um erro de banco
--   cru ("duplicate key value violates unique constraint") em vez de
--   simplesmente gravar o relatório como ele é.
--
--   O relatório é a fonte de verdade (item 14 do pedido original: "usar o
--   relatório real como fonte") — não cabe ao sistema inventar uma regra de
--   unicidade que a planilha não garante. A identidade real de cada linha
--   já é o `id` (uuid) da própria tabela; `numero_pedido` continua sendo só
--   um dado do pedido, não uma chave.
--
-- PRÉ-REQUISITO: migration 037 aplicada.
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

drop index if exists uq_pfdped_importacao_pedido;

-- índice comum (não único) continua útil pra buscar por código dentro de
-- uma importação, só perde a restrição de unicidade.
create index if not exists idx_pfdped_importacao_numero on parser_fd_pedidos(importacao_id, numero_pedido);
