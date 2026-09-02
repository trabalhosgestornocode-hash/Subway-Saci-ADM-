-- =====================================================================
-- MIGRATION 062 — CHECK de coerência perfil_id × impersonado_por
-- =====================================================================
-- ⚠️  NÃO APLICAR AINDA. Esta migration só é segura DEPOIS que:
--       1. a migration 060 estiver aplicada;
--       2. o backend da Fase D estiver deployado (o `criarSessao` novo já
--          grava `perfil_id` em TODA sessão normal e `null` só em impersonação);
--       3. o PRÉ-CHECK abaixo retornar 0 em todas as consultas.
--     Aplicar antes disso quebra o login (o backend antigo insere
--     `sessoes_contexto` sem `perfil_id`).
--
-- OBJETIVO (Fase D — desenho; ver docs/multi-perfil-fase-d-*.md §27)
--   Impor no BANCO a regra que a aplicação já garante:
--     * sessão NORMAL      -> perfil_id NOT NULL  E  impersonado_por NULL
--     * sessão IMPERSONAÇÃO -> perfil_id NULL      E  impersonado_por NOT NULL
--   (XOR). Isso fecha a porta para uma linha malformada mesmo que um bug
--   futuro no backend tente criá-la.
--
-- Por que XOR e não só "perfil_id IS NOT NULL OR impersonado_por IS NOT NULL":
--   auditado o código da Fase D — NENHUM fluxo legítimo produz os dois
--   setados ao mesmo tempo (`criarSessao` lança se `impersonadoPor && perfilId`).
--   E a 060 backfilla `perfil_id = usuario_id WHERE impersonado_por IS NULL`,
--   deixando as linhas de impersonação com `perfil_id` NULL. Então o XOR é
--   verdadeiro para 100% das linhas após 060 + Fase D.
--
-- IDEMPOTENTE. TRANSACIONAL. Só adiciona 1 constraint — nada de dados.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PRÉ-CHECK  (rode ANTES; tudo tem de dar 0)
-- ---------------------------------------------------------------------
-- 1) sessões NORMAIS (vivas ou não) sem perfil_id  >>> 0 depois da Fase D
--    select count(*) from sessoes_contexto
--     where impersonado_por is null and perfil_id is null;
-- 2) sessões de IMPERSONAÇÃO com perfil_id setado  >>> 0
--    select count(*) from sessoes_contexto
--     where impersonado_por is not null and perfil_id is not null;
-- 3) (opcional) sessões vivas que ainda seriam derrubadas pela constraint —
--    revogar antes é mais limpo que deixar o CHECK recusar um UPDATE futuro:
--    select count(*) from sessoes_contexto
--     where revogada_em is null
--       and not (
--         (perfil_id is not null and impersonado_por is null)
--         or (perfil_id is null and impersonado_por is not null)
--       );
--    -- se > 0: `update sessoes_contexto set revogada_em = now(),
--    --          motivo_revogacao = 'migracao_062_check' where <mesma condição>;`
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- CONSTRAINT
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'sessoes_contexto_perfil_xor_impersonacao'
  ) then
    alter table sessoes_contexto
      add constraint sessoes_contexto_perfil_xor_impersonacao
      check (
        (perfil_id is not null and impersonado_por is null)
        or
        (perfil_id is null and impersonado_por is not null)
      );
  end if;
end $$;

comment on constraint sessoes_contexto_perfil_xor_impersonacao on sessoes_contexto is
  'Fase D: sessão normal = perfil_id set + impersonado_por null; impersonação = o inverso. XOR.';


-- ---------------------------------------------------------------------
-- PÓS-CHECK
-- ---------------------------------------------------------------------
--   select conname from pg_constraint where conname = 'sessoes_contexto_perfil_xor_impersonacao';
--   -- e um insert malformado deve FALHAR:
--   -- insert into sessoes_contexto (usuario_id, organizacao_id, papel, expira_em)
--   --   values (gen_random_uuid(), gen_random_uuid(), 'operations', now() + interval '1h');
--   --   -- ERRO esperado: viola sessoes_contexto_perfil_xor_impersonacao


-- ---------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------
--   alter table sessoes_contexto drop constraint if exists sessoes_contexto_perfil_xor_impersonacao;
-- =====================================================================
-- FIM
-- =====================================================================
