-- =====================================================================
-- MIGRATION 046 — Parser Food Delivery: classificação automática de
-- cancelamentos (recebe taxa / não recebe taxa / revisão)
-- =====================================================================
-- OBJETIVO
--   Até aqui, decidir se um pedido cancelado mantinha a taxa do entregador
--   dependia de alguém digitar manualmente os códigos "sem taxa" na
--   importação (`codigos_sem_taxa`). Esta migration guarda a TIMELINE
--   completa de cada pedido (despacho/aceite/coleta/chegada — já vinham no
--   relatório, mas nunca eram lidas) e o resultado da classificação
--   automática (ver backend/src/modules/parser-food-delivery/
--   parserFoodDelivery.classificacao.js), incluindo a trilha de quem
--   alterou manualmente uma decisão automática e por quê.
--
--   `codigos_sem_taxa`/`sem_taxa_informado` NÃO são removidos — continuam
--   valendo para importações antigas (feitas antes desta migration) e para
--   o endpoint de edição já existente (`editarCodigosSemTaxa`). O wizard de
--   importação novo simplesmente para de usar esse mecanismo como caminho
--   primário.
--
--   Pedido classificado como REVISAR mantém a taxa por padrão (mesmo
--   comportamento já existente para "cancelado sem código informado") —
--   por isso `cancelados_com_taxa`/`cancelados_sem_taxa` (já existentes)
--   continuam sendo a fonte da verdade financeira sem mudar de sentido:
--   com_taxa = recebe_taxa OU revisar; sem_taxa = nao_recebe_taxa. Os
--   3 contadores novos (`cancelados_recebem_taxa`/`_nao_recebem_taxa`/
--   `_revisao`) são só para a UI mostrar a análise separada da conciliação
--   financeira.
--
-- PRÉ-REQUISITO: migrations 037, 038, 039, 040 aplicadas.
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PEDIDOS — timeline completa do relatório (antes só existiam
--    data_entregue/data_finalizado/data_cancelado).
-- ---------------------------------------------------------------------
alter table parser_fd_pedidos add column if not exists data_pronto timestamptz;
alter table parser_fd_pedidos add column if not exists data_despachado timestamptz;
alter table parser_fd_pedidos add column if not exists data_aceito timestamptz;
alter table parser_fd_pedidos add column if not exists data_coletado timestamptz;
alter table parser_fd_pedidos add column if not exists data_chegada_entrega timestamptz;
alter table parser_fd_pedidos add column if not exists data_rejeitado timestamptz;
alter table parser_fd_pedidos add column if not exists razao_rejeicao text;
alter table parser_fd_pedidos add column if not exists justificativa_rejeicao text;

-- ---------------------------------------------------------------------
-- 2. PEDIDOS — resultado da classificação automática do cancelamento.
-- ---------------------------------------------------------------------
alter table parser_fd_pedidos add column if not exists classificacao_cancelamento text
  check (classificacao_cancelamento in ('recebe_taxa', 'nao_recebe_taxa', 'revisar'));
alter table parser_fd_pedidos add column if not exists classificacao_motivo text;
alter table parser_fd_pedidos add column if not exists classificacao_nivel_confianca text
  check (classificacao_nivel_confianca in ('muito_alta', 'alta', 'inconclusiva'));
alter table parser_fd_pedidos add column if not exists classificacao_regra text;

-- ---------------------------------------------------------------------
-- 3. PEDIDOS — override manual (item 29 do pedido original: sempre com
--    motivo, sempre preservando o que o motor decidiu originalmente).
-- ---------------------------------------------------------------------
alter table parser_fd_pedidos add column if not exists classificacao_original text;
alter table parser_fd_pedidos add column if not exists classificacao_override_usuario_id uuid references perfis(id) on delete set null;
alter table parser_fd_pedidos add column if not exists classificacao_override_usuario_nome text;
alter table parser_fd_pedidos add column if not exists classificacao_override_usuario_email text;
alter table parser_fd_pedidos add column if not exists classificacao_override_motivo text;
alter table parser_fd_pedidos add column if not exists classificacao_override_em timestamptz;

create index if not exists idx_pfdped_classificacao on parser_fd_pedidos(importacao_id, classificacao_cancelamento);

-- ---------------------------------------------------------------------
-- 4. IMPORTAÇÕES — contadores agregados da análise automática (só para
--    exibição — não substituem cancelados_com_taxa/cancelados_sem_taxa).
-- ---------------------------------------------------------------------
alter table parser_fd_importacoes add column if not exists cancelados_recebem_taxa int not null default 0;
alter table parser_fd_importacoes add column if not exists cancelados_nao_recebem_taxa int not null default 0;
alter table parser_fd_importacoes add column if not exists cancelados_revisao int not null default 0;

-- ---------------------------------------------------------------------
-- 5. AUDITORIA — nova ação "classificacao_alterada", reaproveitando a
--    tabela já existente (mesmo padrão de "codigos_alterados").
-- ---------------------------------------------------------------------
alter table parser_fd_auditoria drop constraint if exists parser_fd_auditoria_acao_check;
alter table parser_fd_auditoria add constraint parser_fd_auditoria_acao_check
  check (acao in ('importacao_criada', 'codigos_alterados', 'excluida', 'classificacao_alterada'));

alter table parser_fd_auditoria add column if not exists pedido_id uuid references parser_fd_pedidos(id) on delete set null;
alter table parser_fd_auditoria add column if not exists numero_pedido text;
alter table parser_fd_auditoria add column if not exists classificacao_antes text;
alter table parser_fd_auditoria add column if not exists classificacao_depois text;

create index if not exists idx_pfdaud_pedido on parser_fd_auditoria(pedido_id);
