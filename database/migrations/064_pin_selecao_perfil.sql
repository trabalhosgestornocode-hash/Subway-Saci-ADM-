-- =====================================================================
-- MIGRATION 064 — PIN do perfil: prova de seleção de uso único + RPCs de lockout
-- =====================================================================
-- ⚠️  NÃO APLICAR AINDA. Depende de:
--       1. migration 060 aplicada (perfis_operacionais + sessoes_contexto);
--       2. backend da Fase H deployado.
--     Nada aqui QUEBRA o backend anterior: as colunas/funções são aditivas e o
--     backend da Fase H degrada graciosamente se elas não existirem (a prova
--     de seleção vira "reutilizável dentro de 5 min" e o contador de PIN cai
--     num compare-and-swap). Ver docs/multi-perfil-fase-h-pin.md, seções E/J.
--
-- OBJETIVO (Fase H — ver docs/multi-perfil-fase-h-pin.md)
--   1. `sessoes_contexto.selecao_nonce` (text, UNIQUE parcial) — consome o
--      `jti` do Profile Selection Token no MESMO insert que cria a sessão.
--      Uma prova só cria UMA sessão: reusar o mesmo token -> violação de
--      unicidade -> `criarSessao` rejeita. (Fase H, ponto 6 — uso único.)
--   2. `perfis_operacionais.pin_atualizado_em` — quando o PIN foi definido/
--      trocado pela última vez. Usado pelo workflow da Fase G ("o perfil
--      existente precisa receber PIN antes de criar o 2º") e pela auditoria.
--   3. RPCs ATÔMICAS de lockout (Fase H, ponto 17 — concorrência):
--      * `perfil_pin_registrar_falha(perfil_id, max_tentativas, lock_minutos)`
--        -> incrementa `pin_tentativas` e, ao atingir o limite, grava
--           `pin_bloqueado_ate`, tudo em UM statement (sem SELECT-then-UPDATE).
--      * `perfil_pin_registrar_sucesso(perfil_id)` -> zera tentativas e limpa
--           o bloqueio, atômico.
--      Duas tentativas simultâneas nunca perdem incremento.
--
--   O QUE **NÃO** FAZ:
--     * não cria 2º perfil, não cria endpoint de criação de perfil;
--     * não adiciona regra SQL "conta 2+ perfis exige PIN" (é da aplicação —
--       perfil.service.js#resolverPerfilParaContexto / selecionarPerfil);
--     * não altera a 060, a CHECK XOR da 062, nem o Context Token;
--     * não toca `pin_hash` de nenhuma linha (o backend faz isso).
--
-- IDEMPOTENTE (if not exists / create or replace). TRANSACIONAL.
-- COMO USAR: Supabase -> SQL Editor -> cole o arquivo inteiro.
--   NÃO executar em produção sem aprovação explícita.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Prova de seleção de uso único
-- ---------------------------------------------------------------------
alter table sessoes_contexto
  add column if not exists selecao_nonce text;

comment on column sessoes_contexto.selecao_nonce is
  'jti do Profile Selection Token que autorizou esta sessão (Fase H). NULL em '
  'impersonação e em sessão de conta com 1 perfil (sem PIN). UNIQUE parcial: '
  'a mesma prova não cria duas sessões.';

-- UNIQUE parcial: só vale para nonce não-nulo (impersonação e conta-única
-- gravam NULL e podem repetir à vontade).
create unique index if not exists uq_sessoes_selecao_nonce
  on sessoes_contexto (selecao_nonce)
  where selecao_nonce is not null;

-- ---------------------------------------------------------------------
-- 2. Quando o PIN foi definido/trocado
-- ---------------------------------------------------------------------
alter table perfis_operacionais
  add column if not exists pin_atualizado_em timestamptz;

comment on column perfis_operacionais.pin_atualizado_em is
  'Última vez que pin_hash foi definido/trocado/resetado (Fase H). NULL = '
  'perfil nunca teve PIN.';

-- ---------------------------------------------------------------------
-- 3. RPCs atômicas de lockout
-- ---------------------------------------------------------------------
-- Falha de PIN: incrementa e, no limite, bloqueia — atômico. Devolve o estado
-- resultante para o backend montar a resposta (sem revelar detalhe sensível).
create or replace function perfil_pin_registrar_falha(
  p_perfil_id uuid,
  p_max_tentativas integer default 5,
  p_lock_minutos integer default 15
)
returns table (pin_tentativas integer, pin_bloqueado_ate timestamptz)
language sql
security definer
set search_path = public
as $$
  update perfis_operacionais
     set pin_tentativas = perfis_operacionais.pin_tentativas + 1,
         pin_bloqueado_ate = case
           when perfis_operacionais.pin_tentativas + 1 >= p_max_tentativas
             then now() + make_interval(mins => p_lock_minutos)
           else perfis_operacionais.pin_bloqueado_ate
         end
   where id = p_perfil_id
  returning perfis_operacionais.pin_tentativas, perfis_operacionais.pin_bloqueado_ate;
$$;

comment on function perfil_pin_registrar_falha(uuid, integer, integer) is
  'Fase H — incremento atômico de pin_tentativas + bloqueio ao atingir o limite. '
  'Um statement: duas tentativas simultâneas nunca perdem incremento.';

-- Sucesso de PIN: zera o contador e limpa o bloqueio — atômico.
create or replace function perfil_pin_registrar_sucesso(p_perfil_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update perfis_operacionais
     set pin_tentativas = 0,
         pin_bloqueado_ate = null
   where id = p_perfil_id;
$$;

comment on function perfil_pin_registrar_sucesso(uuid) is
  'Fase H — reset atômico de pin_tentativas/pin_bloqueado_ate após PIN correto.';

-- As funções rodam com o dono (service_role já é o dono no Supabase); o
-- backend chama via supabase.rpc(). Sem GRANT para anon/authenticated — nunca
-- devem ser chamadas fora do backend.
revoke all on function perfil_pin_registrar_falha(uuid, integer, integer) from anon, authenticated;
revoke all on function perfil_pin_registrar_sucesso(uuid) from anon, authenticated;

commit;

-- =====================================================================
-- PÓS-CHECK (rode depois; nada aqui escreve)
-- =====================================================================
--   select column_name from information_schema.columns
--    where table_name = 'sessoes_contexto' and column_name = 'selecao_nonce';
--   select column_name from information_schema.columns
--    where table_name = 'perfis_operacionais' and column_name = 'pin_atualizado_em';
--   select proname from pg_proc where proname like 'perfil_pin_%';
--
-- =====================================================================
-- ROLLBACK  (se precisar desfazer — nada aqui é destrutivo de dados de negócio)
-- =====================================================================
--   begin;
--   drop function if exists perfil_pin_registrar_falha(uuid, integer, integer);
--   drop function if exists perfil_pin_registrar_sucesso(uuid);
--   drop index if exists uq_sessoes_selecao_nonce;
--   alter table sessoes_contexto     drop column if exists selecao_nonce;
--   alter table perfis_operacionais  drop column if exists pin_atualizado_em;
--   commit;
-- =====================================================================
