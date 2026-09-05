-- =====================================================================
-- MIGRATION 068 — Restringir as RPCs de PIN a service_role
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA.
--
-- PROBLEMA (achado na Fase P0.6, mesma classe de bug que a migration 067
-- já tinha antes de ser corrigida no P0.3)
--   A migration 064 criou perfil_pin_registrar_falha(uuid,integer,integer) e
--   perfil_pin_registrar_sucesso(uuid) como SECURITY DEFINER e revogou o
--   EXECUTE de `anon, authenticated` — mas Postgres concede EXECUTE a PUBLIC
--   por padrão em toda função nova, e revogar só de anon/authenticated NÃO
--   remove essa concessão herdada. Resultado: qualquer chamada autenticada
--   com a chave `anon` do PostgREST (pública, embutida no frontend) consegue
--   `rpc/perfil_pin_registrar_falha` ou `rpc/perfil_pin_registrar_sucesso`
--   passando QUALQUER perfil_id — arbitrário, sem checar organização/unidade/
--   vínculo, porque a função é SECURITY DEFINER. Um chamador que soubesse ou
--   enumerasse um perfil_id poderia:
--     * zerar pin_tentativas/pin_bloqueado_ate de um perfil que não é seu
--       (facilita brute-force do PIN de outra conta);
--     * incrementar pin_tentativas até bloquear o PIN de um perfil alheio
--       (negação de serviço direcionada).
--   O backend SEMPRE chama as duas via `service_role`
--   (backend/src/modules/sessao/perfil.service.js) — não há nenhum caminho
--   legítimo que precise de PUBLIC, anon ou authenticated aqui.
--
-- COMO RESOLVE
--   Revoga explicitamente de PUBLIC (além de anon/authenticated, mantendo a
--   revogação já existente por clareza) e concede EXECUTE só a service_role
--   — mesmo padrão já usado pela migration 067 para agente_reservar_quota.
--
-- NADA MUDA NO COMPORTAMENTO DO BACKEND: ele já chama via service_role.
-- IDEMPOTENTE: revoke/grant podem ser reexecutados sem efeito colateral.
-- =====================================================================

revoke all on function perfil_pin_registrar_falha(uuid, integer, integer) from public, anon, authenticated;
revoke all on function perfil_pin_registrar_sucesso(uuid) from public, anon, authenticated;

grant execute on function perfil_pin_registrar_falha(uuid, integer, integer) to service_role;
grant execute on function perfil_pin_registrar_sucesso(uuid) to service_role;
