-- =====================================================================
-- VERIFICAÇÃO da migration 019 — SOMENTE LEITURA
-- =====================================================================
-- Rode ANTES e DEPOIS de aplicar a 019 e compare as duas saídas.
-- Não altera absolutamente nada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TIPO DA COLUNA client_id nas 4 tabelas
--    antes: bigint | depois: text
-- ---------------------------------------------------------------------
select table_name, column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and column_name in ('client_id', 'request_id')
   and table_name like 'martin_brower%'
 order by table_name, column_name;

-- ---------------------------------------------------------------------
-- 2. CONTAGEM DE LINHAS — tem que ser IDÊNTICA antes e depois
-- ---------------------------------------------------------------------
select 'martin_brower_integracoes'      tabela, count(*) linhas from martin_brower_integracoes
union all select 'martin_brower_sincronizacoes',  count(*) from martin_brower_sincronizacoes
union all select 'martin_brower_produtos',        count(*) from martin_brower_produtos
union all select 'martin_brower_precos_historico',count(*) from martin_brower_precos_historico
union all select 'martin_brower_filtros',         count(*) from martin_brower_filtros
union all select 'martin_brower_vinculos',        count(*) from martin_brower_vinculos
 order by 1;

-- ---------------------------------------------------------------------
-- 3. CONSTRAINTS E ÍNDICES que envolvem client_id
--    As mesmas regras de unicidade têm que existir depois.
-- ---------------------------------------------------------------------
select conrelid::regclass::text tabela, conname, contype,
       pg_get_constraintdef(oid) definicao
  from pg_constraint
 where connamespace = 'public'::regnamespace
   and conrelid::regclass::text like 'martin_brower%'
   and contype in ('u', 'p', 'f')
 order by 1, 2;

select tablename, indexname, indexdef
  from pg_indexes
 where schemaname = 'public' and tablename like 'martin_brower%'
 order by tablename, indexname;

-- ---------------------------------------------------------------------
-- 4a. DUPLICIDADES em colunas que existem ANTES e DEPOIS da migration
--     Esperado: ZERO linhas.
-- ---------------------------------------------------------------------
select 'integracoes' origem, organizacao_id, unidade_id, client_id::text as chave, count(*)
  from martin_brower_integracoes
 group by 1,2,3,4 having count(*) > 1
union all
select 'produtos', organizacao_id, unidade_id, client_id::text || '|' || codigo, count(*)
  from martin_brower_produtos
 group by 1,2,3,4 having count(*) > 1;

-- ---------------------------------------------------------------------
-- 4b. DUPLICIDADES de request_id
--     A coluna SÓ existe DEPOIS da migration 019. Consultá-la diretamente
--     quebrava esta verificação quando rodada ANTES, com:
--         ERROR 42703: column "request_id" does not exist
--     O PL/pgSQL analisa SQL estático mesmo dentro de um IF que não seria
--     executado — por isso a consulta vai por EXECUTE, que só é analisada
--     no momento em que roda.
--     ANTES da migration: informa que a coluna ainda não existe (normal).
--     DEPOIS: informa a contagem de duplicatas (esperado ZERO).
--     O resultado sai em NOTICE, na aba "Messages"/"Logs" do SQL Editor.
-- ---------------------------------------------------------------------
do $$
declare
  n int;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'martin_brower_sincronizacoes'
       and column_name  = 'request_id')
  then
    raise notice '[4b] coluna request_id AINDA NAO EXISTE — esperado ANTES da migration 019.';
    return;
  end if;

  execute $q$
    select count(*) from (
      select organizacao_id, unidade_id, request_id
        from public.martin_brower_sincronizacoes
       where request_id is not null
       group by 1,2,3 having count(*) > 1) d
  $q$ into n;

  if n = 0 then
    raise notice '[4b] request_id: nenhuma duplicidade. OK.';
  else
    raise notice '[4b] request_id: % grupo(s) DUPLICADO(S) — resolva antes de recriar o indice.', n;
  end if;

  execute 'select count(*) from public.martin_brower_sincronizacoes where request_id is not null' into n;
  raise notice '[4b] sincronizacoes com request_id preenchido: %', n;

  execute 'select count(*) from public.martin_brower_sincronizacoes where request_id is null' into n;
  raise notice '[4b] sincronizacoes com request_id NULO (registros antigos, validos): %', n;
end $$;

-- ---------------------------------------------------------------------
-- 4c. O ÍNDICE de idempotência existe?
--     ANTES: zero linhas. DEPOIS: uma linha (uq_mb_sync_request).
-- ---------------------------------------------------------------------
select indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and tablename = 'martin_brower_sincronizacoes'
   and indexname = 'uq_mb_sync_request';

-- ---------------------------------------------------------------------
-- 5. NULOS INESPERADOS em colunas que são NOT NULL
--    Esperado: todos zero.
-- ---------------------------------------------------------------------
select 'integracoes.client_id nulo' item, count(*) qtd from martin_brower_integracoes where client_id is null
union all select 'produtos.client_id nulo',        count(*) from martin_brower_produtos where client_id is null
union all select 'historico.client_id nulo',       count(*) from martin_brower_precos_historico where client_id is null;

-- ---------------------------------------------------------------------
-- 6. DEPENDÊNCIAS que bloqueariam o ALTER TYPE
--    views, matviews e colunas geradas sobre as tabelas MB.
--    Esperado: ZERO linhas.
-- ---------------------------------------------------------------------
select distinct dependente.relname as objeto_dependente,
       dependente.relkind as tipo,
       origem.relname as tabela_origem
  from pg_depend d
  join pg_rewrite r  on r.oid = d.objid
  join pg_class dependente on dependente.oid = r.ev_class
  join pg_class origem on origem.oid = d.refobjid
 where d.refclassid = 'pg_class'::regclass
   and origem.relname like 'martin_brower%'
   and dependente.relkind in ('v', 'm')
   and dependente.relname <> origem.relname;

select table_name, column_name, generation_expression
  from information_schema.columns
 where table_schema = 'public' and table_name like 'martin_brower%'
   and is_generated <> 'NEVER';

-- ---------------------------------------------------------------------
-- 7. FUNÇÕES/POLICIES que citam client_id
--    As policies da 017 usam só organizacao_id/unidade_id — esperado ZERO.
-- ---------------------------------------------------------------------
select tablename, policyname
  from pg_policies
 where schemaname = 'public' and tablename like 'martin_brower%'
   and (coalesce(qual, '') like '%client_id%' or coalesce(with_check, '') like '%client_id%');

select p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and pg_get_functiondef(p.oid) like '%client_id%';

-- ---------------------------------------------------------------------
-- 8. AMOSTRA dos valores — confirme que nada mudou de conteúdo
-- ---------------------------------------------------------------------
select client_id::text as client_id_texto, count(*) linhas
  from martin_brower_produtos group by 1 order by 1 limit 20;
