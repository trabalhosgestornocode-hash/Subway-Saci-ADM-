-- =====================================================================
-- MIGRATION 034 — Gerenciamento completo de Unidades no SuperAdmin
-- =====================================================================
-- OBJETIVO
--   1. Campos de localização que a área de Unidades do SuperAdmin usa
--      (cidade/estado) — hoje `unidades` só tem `endereco` livre.
--   2. Módulos POR UNIDADE — mesma arquitetura de `organizacao_modulos`
--      (migration 030), mas para unidade. O acesso EFETIVO de uma unidade
--      é sempre a INTERSEÇÃO entre os módulos da empresa e os módulos da
--      própria unidade (nunca a unidade sozinha) — calculado centralmente
--      em backend/src/shared/modulos.js#modulosEfetivosDaUnidade, nunca
--      duplicado em rota nenhuma.
--
-- ESCOPO DELIBERADAMENTE FORA DESTA MIGRATION (decisão registrada em
-- conversa com o cliente): "Modelo Inicial" por unidade e catálogo
-- (produtos/insumos/ficha técnica) isolado por unidade. Hoje todo esse
-- catálogo é só por organizacao_id (ver database/schema.sql) — compartilhado
-- entre todas as unidades da mesma empresa. Tornar isso por unidade exige
-- adicionar unidade_id a 7 tabelas centrais e reescrever os módulos
-- Produtos/Insumos/CMV; é um projeto separado, não incluído aqui.
--
-- NÃO DESTRUTIVO / IDEMPOTENTE.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. LOCALIZAÇÃO DA UNIDADE
-- ---------------------------------------------------------------------
alter table unidades add column if not exists cidade text;
alter table unidades add column if not exists estado text; -- UF, 2 letras (ex: 'MA')

-- ---------------------------------------------------------------------
-- 2. MÓDULOS HABILITADOS POR UNIDADE
--    Presença de linha = a unidade PODE ter esse módulo — mas o acesso
--    efetivo ainda depende da empresa também tê-lo (interseção, nunca só
--    a unidade). `definirModulosUnidade` recusa gravar um módulo que a
--    empresa não possui — a herança é imposta na ESCRITA, não só na leitura.
-- ---------------------------------------------------------------------
create table if not exists unidade_modulos (
  unidade_id uuid not null references unidades(id) on delete cascade,
  modulo_id text not null references modulos(id) on delete cascade,
  habilitado_em timestamptz not null default now(),
  habilitado_por uuid,          -- auth.users.id do superadmin; sem FK (sobrevive à exclusão da conta)
  primary key (unidade_id, modulo_id)
);
create index if not exists idx_unidade_modulos_unidade on unidade_modulos(unidade_id);

-- Backfill: toda unidade já existente recebe os módulos que a PRÓPRIA
-- EMPRESA já tem hoje — sem isto, o deploy desta migration derrubaria, da
-- noite pro dia, o acesso de toda unidade em produção (mesmo raciocínio já
-- documentado na migration 030 para organizacao_modulos). Depois do deploy,
-- o efetivo continua sendo exatamente o que a empresa já liberava — o
-- SuperAdmin só passa a poder ESTREITAR por unidade quando quiser.
insert into unidade_modulos (unidade_id, modulo_id)
select u.id, om.modulo_id
from unidades u
join organizacao_modulos om on om.organizacao_id = u.organizacao_id
on conflict (unidade_id, modulo_id) do nothing;

-- ---------------------------------------------------------------------
-- 3. RLS — mesmo padrão da migration 030 (organizacao_modulos)
-- ---------------------------------------------------------------------
alter table unidade_modulos enable row level security;
drop policy if exists rls_unidade_modulos_tenant on unidade_modulos;
create policy rls_unidade_modulos_tenant on unidade_modulos
  for select to authenticated
  using (
    unidade_id in (
      select u.id from unidades u where u.organizacao_id in (select auth_organizacao_ids())
    ) or is_platform_superadmin()
  );
drop policy if exists rls_unidade_modulos_escrita on unidade_modulos;
create policy rls_unidade_modulos_escrita on unidade_modulos
  for insert to authenticated with check (is_platform_superadmin());
drop policy if exists rls_unidade_modulos_delete on unidade_modulos;
create policy rls_unidade_modulos_delete on unidade_modulos
  for delete to authenticated using (is_platform_superadmin());

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente):
--   -- Toda unidade deve ter exatamente os módulos da própria empresa logo
--   -- após o backfill:
--   select u.nome, count(um.modulo_id) as modulos_unidade,
--          (select count(*) from organizacao_modulos om where om.organizacao_id = u.organizacao_id) as modulos_empresa
--     from unidades u left join unidade_modulos um on um.unidade_id = u.id
--    group by u.id, u.nome
--   having count(um.modulo_id) <> (select count(*) from organizacao_modulos om where om.organizacao_id = u.organizacao_id);
--   -- Esperado: 0 linhas.
--
--   select column_name from information_schema.columns
--   where table_name = 'unidades' and column_name in ('cidade','estado');
-- =====================================================================
-- FIM
-- =====================================================================
