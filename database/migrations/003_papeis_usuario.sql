-- =====================================================================
-- MIGRATION 003 — Novos papéis de usuário
-- Amplia o enum papel_usuario com:
--   * 'desenvolvedor' — acesso total (todas as permissões de admin)
--   * 'leitura'       — "Somente leitura"
-- Necessária para criar/editar usuários com esses perfis pela tela de
-- Configurações → Usuários. Rode no SQL Editor do Supabase.
-- Obs.: ADD VALUE não pode rodar dentro de transação; execute as linhas
-- soltas (o SQL Editor do Supabase já faz isso).
-- =====================================================================

alter type papel_usuario add value if not exists 'desenvolvedor';
alter type papel_usuario add value if not exists 'leitura';

-- Mapa de perfis da UI -> enum:
--   Desenvolvedor    -> desenvolvedor
--   Administrador    -> admin
--   Gestor           -> gerente
--   Financeiro       -> financeiro
--   Operacional      -> operador
--   Somente leitura  -> leitura

-- (Opcional) tornar-se Desenvolvedor após rodar as linhas acima:
-- update perfis set papel = 'desenvolvedor' where email = 'SEU_EMAIL_AQUI';
