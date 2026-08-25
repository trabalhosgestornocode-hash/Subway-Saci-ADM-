-- =====================================================================
-- MIGRATION 050 — Agente Crescer: ações de navegação sugeridas (Etapa F.1)
-- =====================================================================
-- OBJETIVO
--   Persistir as sugestões de navegação (`{ type: "navigate", target,
--   label, params }`) de cada mensagem 'assistant', pro mesmo motivo de
--   `tools_utilizadas` (migration 048): reaparecerem ao reidratar a
--   conversa (F5) — sem isso, um botão "Abrir Cancelamentos" sumiria assim
--   que a tela recarregasse, mesmo a conversa continuando visível.
--
--   NUNCA é fonte de autorização: uma action salva aqui é só o que foi
--   sugerido NAQUELE momento, com o acesso de NAQUELE momento. Clicar numa
--   action antiga sempre passa pelo router do frontend, que reconsulta o
--   contexto/módulos ATUAIS — uma action histórica nunca pula essa
--   revalidação (ver agente.acoes.js#resolverAcao, chamado só na hora de
--   SUGERIR, nunca na hora de navegar de fato).
--
--   Mesmo formato/filosofia de `tools_utilizadas`: um array jsonb, nunca
--   mais que poucas entradas (MAX_ACOES_SUGERIDAS = 3 em agente.service.js).
--
-- PRÉ-REQUISITOS: migration 048 aplicada (tabela agente_mensagens existe).
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

alter table agente_mensagens
  add column if not exists acoes jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------
-- VERIFICAÇÃO (rode separadamente para conferir)
-- ---------------------------------------------------------------------
--   select column_name from information_schema.columns
--    where table_name = 'agente_mensagens' and column_name = 'acoes';
--   -- Esperado: 1 linha.
-- =====================================================================
-- FIM
-- =====================================================================
