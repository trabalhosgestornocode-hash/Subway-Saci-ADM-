-- =====================================================================
-- MIGRATION 063 — usuarios_organizacoes/unidades: perfil_id NOT NULL + UNIQUE
-- =====================================================================
-- ⚠️  NÃO APLICAR AINDA. Segura SOMENTE depois de:
--       1. migration 060 aplicada;
--       2. backend das Fases C+D+E deployado — TODA criação/edição de vínculo
--          já grava `perfil_id` (ver usuarios/usuarios.service.js e
--          plataforma/plataforma.usuarios.service.js na Fase E);
--       3. PRÉ-CHECK abaixo = 0.
--     Aplicar antes disso quebra a criação de vínculo pelo backend antigo
--     (que insere sem `perfil_id`).
--
-- OBJETIVO (Fase E — desenho; ver docs/multi-perfil-fase-e-autorizacao-perfil.md)
--   Tornar `perfil_id` a chave CANÔNICA dos vínculos:
--     * `perfil_id` NOT NULL;
--     * UNIQUE(perfil_id, organizacao_id)  — substitui UNIQUE(usuario_id, org);
--     * UNIQUE(perfil_id, unidade_id)       — substitui UNIQUE(usuario_id, unidade).
--   Sem isto, uma CONTA só pode ter 1 vínculo por empresa — o que impede
--   Fulana 1 (Empresa A) + Fulana 2 (Empresa A, outro cargo) na MESMA conta.
--   Pré-requisito para a Fase G (criação do 2º perfil).
--
--   `usuario_id` PERMANECE (LEGACY/TRANSIÇÃO) — não é removido aqui.
--
-- IDEMPOTENTE. TRANSACIONAL. Sem migração de dados além do backfill defensivo.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PRÉ-CHECK  (rode ANTES; tudo tem de dar 0)
-- ---------------------------------------------------------------------
-- 1) vínculos de empresa sem perfil_id  >>> 0 depois da Fase E
--    select count(*) from usuarios_organizacoes where perfil_id is null;
-- 2) vínculos de unidade sem perfil_id  >>> 0
--    select count(*) from usuarios_unidades where perfil_id is null;
-- 3) vínculos cujo perfil_id não existe em perfis_operacionais  >>> 0
--    select count(*) from usuarios_organizacoes uo
--      left join perfis_operacionais po on po.id = uo.perfil_id
--     where uo.perfil_id is not null and po.id is null;
--    select count(*) from usuarios_unidades uu
--      left join perfis_operacionais po on po.id = uu.perfil_id
--     where uu.perfil_id is not null and po.id is null;
-- 4) duplicatas que a UNIQUE(perfil_id, org) recusaria  >>> 0
--    select perfil_id, organizacao_id, count(*) from usuarios_organizacoes
--     group by perfil_id, organizacao_id having count(*) > 1;
--    select perfil_id, unidade_id, count(*) from usuarios_unidades
--     group by perfil_id, unidade_id having count(*) > 1;
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 1. BACKFILL DEFENSIVO (linhas criadas pós-060 por código antigo)
-- ---------------------------------------------------------------------
update usuarios_organizacoes set perfil_id = usuario_id where perfil_id is null;
update usuarios_unidades     set perfil_id = usuario_id where perfil_id is null;

-- ---------------------------------------------------------------------
-- 2. NOT NULL
-- ---------------------------------------------------------------------
alter table usuarios_organizacoes alter column perfil_id set not null;
alter table usuarios_unidades     alter column perfil_id set not null;

-- ---------------------------------------------------------------------
-- 3. UNIQUE — troca (usuario_id, X) por (perfil_id, X)
--    Nome da constraint antiga: o default do Postgres para
--    `unique (usuario_id, organizacao_id)` da migration 015.
-- ---------------------------------------------------------------------
alter table usuarios_organizacoes
  drop constraint if exists usuarios_organizacoes_usuario_id_organizacao_id_key;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'uo_perfil_org_unico') then
    alter table usuarios_organizacoes add constraint uo_perfil_org_unico unique (perfil_id, organizacao_id);
  end if;
end $$;

alter table usuarios_unidades
  drop constraint if exists usuarios_unidades_usuario_id_unidade_id_key;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'uu_perfil_uni_unico') then
    alter table usuarios_unidades add constraint uu_perfil_uni_unico unique (perfil_id, unidade_id);
  end if;
end $$;

comment on column usuarios_organizacoes.perfil_id is
  'CANÔNICA. NOT NULL desde a 063. UNIQUE(perfil_id, organizacao_id). usuario_id = LEGACY.';
comment on column usuarios_unidades.perfil_id is
  'CANÔNICA. NOT NULL desde a 063. UNIQUE(perfil_id, unidade_id). usuario_id = LEGACY.';


-- ---------------------------------------------------------------------
-- PÓS-CHECK
-- ---------------------------------------------------------------------
--   select conname from pg_constraint
--    where conname in ('uo_perfil_org_unico','uu_perfil_uni_unico');   -- 2 linhas
--   select is_nullable from information_schema.columns
--    where table_name='usuarios_organizacoes' and column_name='perfil_id';  -- NO


-- ---------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------
--   alter table usuarios_organizacoes drop constraint if exists uo_perfil_org_unico;
--   alter table usuarios_unidades     drop constraint if exists uu_perfil_uni_unico;
--   alter table usuarios_organizacoes alter column perfil_id drop not null;
--   alter table usuarios_unidades     alter column perfil_id drop not null;
--   alter table usuarios_organizacoes add constraint usuarios_organizacoes_usuario_id_organizacao_id_key unique (usuario_id, organizacao_id);
--   alter table usuarios_unidades     add constraint usuarios_unidades_usuario_id_unidade_id_key       unique (usuario_id, unidade_id);
-- =====================================================================
-- FIM
-- =====================================================================
