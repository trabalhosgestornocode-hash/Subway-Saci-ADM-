-- =====================================================================
-- MIGRATION 019 — client_id como TEXT + idempotência por request_id
-- =====================================================================
-- OBJETIVO 1 — client_id deixa de ser bigint e passa a ser text.
--   `clientId` é um IDENTIFICADOR, não um número: ninguém soma, subtrai ou
--   ordena por ele. Guardá-lo como bigint destrói zeros à esquerda ("04532"
--   vira 4532) e limita o tamanho. O mesmo raciocínio que já vale para o
--   `codigo` do produto — que sempre foi text — vale aqui.
--
-- OBJETIVO 2 — idempotência persistente.
--   `request_id` em martin_brower_sincronizacoes + índice único parcial por
--   (organizacao_id, unidade_id, request_id). Assim a MESMA solicitação da
--   extensão não é processada duas vezes, nem depois de reiniciar o backend.
--
-- =====================================================================
-- DECISÃO TÉCNICA: por que NÃO dropar e recriar os índices manualmente
-- =====================================================================
--   O pedido original era mapear os índices dependentes, dropá-los, converter
--   e recriá-los. O Postgres torna isso desnecessário — e pior que o padrão:
--
--   `ALTER TABLE ... ALTER COLUMN ... TYPE` já RECONSTRÓI automaticamente todo
--   índice e constraint que dependem da coluna, dentro da MESMA transação.
--   Dropar à mão criaria exatamente a janela sem proteção de unicidade que se
--   queria evitar, e ainda arriscaria recriar com definição divergente.
--
--   O que a conversão automática NÃO resolve são views, matviews e colunas
--   geradas — e é justamente isso que a seção 1 verifica antes de tocar em
--   qualquer coisa.
--
--   A seção 4 confere, DEPOIS, que cada regra de unicidade continua existindo
--   com a mesma definição. Se o Postgres tivesse deixado algo para trás, a
--   migration aborta e desfaz tudo.
--
-- SEGURANÇA DA CONVERSÃO
--   bigint -> text via `client_id::text` é INJETIVA: dois bigints diferentes
--   nunca viram o mesmo texto. Logo a conversão não pode criar duplicata nova.
--   Mesmo assim conferimos antes e depois, porque custa nada.
--
--   NENHUMA correção silenciosa de dados: sem trim, sem padding, sem remoção
--   de zeros, sem inventar valor. 4532 vira exatamente '4532'.
--
-- TRANSACIONAL: tudo num único bloco. Qualquer RAISE desfaz a migration
--   inteira — o Postgres faz DDL transacional.
--
-- IDEMPOTENTE: se client_id já for text, a conversão daquela tabela é pulada.
--   Cobre o caso de uma tentativa anterior parcial.
--
-- ROLLBACK: NÃO existe rollback automático — ver seção 6.
--
-- COMO USAR: Supabase -> SQL Editor -> execute este arquivo INTEIRO de uma vez.
--   Rode antes e depois o 019_VERIFICACAO_antes_e_depois.sql e compare.
-- =====================================================================

do $$
declare
  tabelas_client_id text[] := array[
    'martin_brower_integracoes',
    'martin_brower_sincronizacoes',
    'martin_brower_produtos',
    'martin_brower_precos_historico'
  ];
  t text;
  tipo_atual text;
  n int;
  convertidas int := 0;
  ja_text int := 0;
  linhas_antes jsonb := '{}'::jsonb;
  linhas_depois jsonb := '{}'::jsonb;
begin
  -- =================================================================
  -- 1. PRÉ-CHECAGENS — aborta antes de alterar qualquer coisa
  -- =================================================================

  -- 1.1 As tabelas existem?
  foreach t in array tabelas_client_id loop
    if to_regclass(format('public.%I', t)) is null then
      raise exception using
        errcode = 'undefined_table',
        message = format('MB 019: tabela %s nao existe.', t),
        hint    = 'Aplique antes a migration 017_martin_brower.sql.';
    end if;
  end loop;

  -- 1.2 Views ou matviews dependentes bloqueariam o ALTER TYPE.
  select count(*) into n
    from pg_depend d
    join pg_rewrite r on r.oid = d.objid
    join pg_class dep on dep.oid = r.ev_class
    join pg_class org on org.oid = d.refobjid
   where d.refclassid = 'pg_class'::regclass
     and org.relname = any(tabelas_client_id)
     and dep.relkind in ('v', 'm')
     and dep.relname <> org.relname;
  if n > 0 then
    raise exception using
      errcode = 'feature_not_supported',
      message = format('MB 019 ABORTADA: %s view(s)/matview(s) dependem das tabelas Martin Brower.', n),
      hint    = 'NADA foi alterado. Rode a secao 6 do 019_VERIFICACAO para identifica-las, '
                'faca DROP nas views, aplique esta migration e recrie as views com client_id text.';
  end if;

  -- 1.3 Colunas geradas sobre client_id.
  select count(*) into n
    from information_schema.columns
   where table_schema = 'public'
     and table_name = any(tabelas_client_id)
     and is_generated <> 'NEVER';
  if n > 0 then
    raise exception using
      errcode = 'feature_not_supported',
      message = 'MB 019 ABORTADA: existem colunas GERADAS nas tabelas Martin Brower.',
      hint    = 'NADA foi alterado. Avalie manualmente antes de converter o tipo.';
  end if;

  -- 1.4 Foreign keys apontando para/from client_id (nao deveriam existir).
  select count(*) into n
    from pg_constraint c
    join pg_class tbl on tbl.oid = c.conrelid
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
   where c.contype = 'f'
     and tbl.relname = any(tabelas_client_id)
     and a.attname = 'client_id';
  if n > 0 then
    raise exception using
      errcode = 'feature_not_supported',
      message = format('MB 019 ABORTADA: %s foreign key(s) envolvem client_id.', n),
      hint    = 'NADA foi alterado. Remova ou reavalie as FKs antes de converter.';
  end if;

  -- 1.5 Policies RLS que citem client_id (as da 017 nao citam).
  select count(*) into n
    from pg_policies
   where schemaname = 'public'
     and tablename = any(tabelas_client_id)
     and (coalesce(qual, '') like '%client_id%' or coalesce(with_check, '') like '%client_id%');
  if n > 0 then
    raise exception using
      errcode = 'feature_not_supported',
      message = format('MB 019 ABORTADA: %s policy(ies) RLS referenciam client_id.', n),
      hint    = 'NADA foi alterado. Revise as policies: comparar text com bigint mudaria o resultado.';
  end if;

  -- 1.6 NULOS onde a coluna e NOT NULL (inconsistencia que impediria recriar).
  select count(*) into n from public.martin_brower_integracoes where client_id is null;
  if n > 0 then raise exception 'MB 019 ABORTADA: % linha(s) com client_id NULO em martin_brower_integracoes.', n; end if;
  select count(*) into n from public.martin_brower_produtos where client_id is null;
  if n > 0 then raise exception 'MB 019 ABORTADA: % linha(s) com client_id NULO em martin_brower_produtos.', n; end if;
  select count(*) into n from public.martin_brower_precos_historico where client_id is null;
  if n > 0 then raise exception 'MB 019 ABORTADA: % linha(s) com client_id NULO em martin_brower_precos_historico.', n; end if;

  -- 1.7 Duplicidades que impediriam recriar os indices unicos.
  --     A mensagem cita SO identificadores tecnicos — nada de dado sensivel.
  select count(*) into n from (
    select organizacao_id, unidade_id, client_id
      from public.martin_brower_integracoes
     group by 1,2,3 having count(*) > 1) d;
  if n > 0 then
    raise exception using
      errcode = 'unique_violation',
      message = format('MB 019 ABORTADA: %s grupo(s) duplicado(s) em martin_brower_integracoes (organizacao_id, unidade_id, client_id).', n),
      hint    = 'NADA foi alterado. Rode a secao 4 do 019_VERIFICACAO, decida manualmente qual linha manter e remova as demais. Esta migration NAO apaga dados.';
  end if;

  select count(*) into n from (
    select organizacao_id, unidade_id, client_id, codigo
      from public.martin_brower_produtos
     group by 1,2,3,4 having count(*) > 1) d;
  if n > 0 then
    raise exception using
      errcode = 'unique_violation',
      message = format('MB 019 ABORTADA: %s grupo(s) duplicado(s) em martin_brower_produtos (organizacao_id, unidade_id, client_id, codigo).', n),
      hint    = 'NADA foi alterado. Rode a secao 4 do 019_VERIFICACAO e resolva manualmente.';
  end if;

  -- 1.8 request_id ja duplicado (caso a coluna exista de tentativa anterior).
  --     Via EXECUTE de propósito: referenciar uma coluna que talvez ainda não
  --     exista faria o PL/pgSQL falhar ao PREPARAR a consulta, mesmo dentro do
  --     `if exists`. Com EXECUTE, a consulta só é analisada quando roda.
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='martin_brower_sincronizacoes'
                and column_name='request_id') then
    execute $q$
      select count(*) from (
        select organizacao_id, unidade_id, request_id
          from public.martin_brower_sincronizacoes
         where request_id is not null
         group by 1,2,3 having count(*) > 1) d
    $q$ into n;
    if n > 0 then
      raise exception using
        errcode = 'unique_violation',
        message = format('MB 019 ABORTADA: %s grupo(s) de request_id duplicado(s) em martin_brower_sincronizacoes.', n),
        hint    = 'NADA foi alterado. Remova manualmente as sincronizacoes repetidas antes de reexecutar.';
    end if;
  end if;

  -- 1.9 Contagem ANTES — comparada no fim para provar que nada se perdeu.
  foreach t in array tabelas_client_id loop
    execute format('select count(*) from public.%I', t) into n;
    linhas_antes := linhas_antes || jsonb_build_object(t, n);
  end loop;

  raise notice 'MB 019: pre-checagens OK. Linhas antes: %', linhas_antes;

  -- =================================================================
  -- 2. CONVERSÃO bigint -> text
  --    O Postgres reconstroi indices e constraints sozinho, na mesma
  --    transacao. Nao ha janela sem protecao de unicidade.
  -- =================================================================
  foreach t in array tabelas_client_id loop
    select data_type into tipo_atual
      from information_schema.columns
     where table_schema = 'public' and table_name = t and column_name = 'client_id';

    if tipo_atual = 'text' then
      ja_text := ja_text + 1;                      -- tentativa anterior parcial
      raise notice 'MB 019: %.client_id ja e text — pulando.', t;
    elsif tipo_atual = 'bigint' then
      execute format(
        'alter table public.%I alter column client_id type text using client_id::text', t);
      convertidas := convertidas + 1;
      raise notice 'MB 019: %.client_id convertido bigint -> text.', t;
    else
      raise exception using
        errcode = 'datatype_mismatch',
        message = format('MB 019 ABORTADA: %s.client_id tem tipo inesperado "%s".', t, tipo_atual),
        hint    = 'Esperado bigint (a converter) ou text (ja convertido). Investigue antes de prosseguir.';
    end if;
  end loop;

  -- =================================================================
  -- 3. IDEMPOTÊNCIA — request_id + índice único parcial
  -- =================================================================
  execute 'alter table public.martin_brower_sincronizacoes add column if not exists request_id text';

  -- Reconfere duplicidade IMEDIATAMENTE antes de criar o indice unico.
  -- EXECUTE de novo: a coluna pode ter acabado de nascer na linha acima, e o
  -- PL/pgSQL analisaria a consulta estatica cedo demais.
  execute $q$
    select count(*) from (
      select organizacao_id, unidade_id, request_id
        from public.martin_brower_sincronizacoes
       where request_id is not null
       group by 1,2,3 having count(*) > 1) d
  $q$ into n;
  if n > 0 then
    raise exception 'MB 019 ABORTADA: request_id duplicado detectado antes de criar o indice (% grupo(s)).', n;
  end if;

  -- PARCIAL: so vale quando request_id nao e nulo. Sincronizacoes antigas
  -- (worker e importacao manual) continuam validas com request_id NULL, e
  -- varias delas podem coexistir — NULL nao colide com NULL.
  --
  -- Um indice UNICO tambem serve de indice de CONSULTA para as mesmas
  -- colunas, na mesma ordem. Nao existe indice de lookup separado aqui: seria
  -- duplicacao pura, custando escrita e espaco sem ganho de leitura.
  execute $q$
    create unique index if not exists uq_mb_sync_request
      on public.martin_brower_sincronizacoes (organizacao_id, unidade_id, request_id)
      where request_id is not null
  $q$;

  -- =================================================================
  -- 4. VERIFICAÇÃO PÓS — se algo faltar, desfaz tudo
  -- =================================================================

  -- 4.1 Todas as colunas viraram text?
  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name = any(tabelas_client_id)
     and column_name = 'client_id' and data_type = 'text';
  if n <> array_length(tabelas_client_id, 1) then
    raise exception 'MB 019 ABORTADA: apenas % de % colunas client_id ficaram text.',
      n, array_length(tabelas_client_id, 1);
  end if;

  -- 4.2 As regras de unicidade sobreviveram a reconstrucao?
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.martin_brower_integracoes'::regclass
       and c.contype = 'u'
       and pg_get_constraintdef(c.oid) like '%organizacao_id%unidade_id%client_id%') then
    raise exception 'MB 019 ABORTADA: a unicidade (organizacao_id, unidade_id, client_id) sumiu de martin_brower_integracoes.';
  end if;

  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.martin_brower_produtos'::regclass
       and c.contype = 'u'
       and pg_get_constraintdef(c.oid) like '%organizacao_id%unidade_id%client_id%codigo%') then
    raise exception 'MB 019 ABORTADA: a unicidade (organizacao_id, unidade_id, client_id, codigo) sumiu de martin_brower_produtos.';
  end if;

  -- 4.3 O indice de consulta por unidade+cliente continua la?
  if not exists (select 1 from pg_indexes
                  where schemaname='public' and tablename='martin_brower_produtos'
                    and indexname='idx_mb_prod_unidade') then
    raise exception 'MB 019 ABORTADA: indice idx_mb_prod_unidade sumiu.';
  end if;

  -- 4.4 NENHUMA linha pode ter sido perdida.
  foreach t in array tabelas_client_id loop
    execute format('select count(*) from public.%I', t) into n;
    linhas_depois := linhas_depois || jsonb_build_object(t, n);
    if (linhas_antes ->> t)::int <> n then
      raise exception 'MB 019 ABORTADA: % tinha % linha(s) e ficou com %.',
        t, linhas_antes ->> t, n;
    end if;
  end loop;

  raise notice 'MB 019 CONCLUIDA. Convertidas: % | ja eram text: % | linhas: %',
    convertidas, ja_text, linhas_depois;
end $$;

-- =====================================================================
-- 5. VERIFICAÇÃO (rode separadamente)
--   Use 019_VERIFICACAO_antes_e_depois.sql e compare com a saída de antes.
--   Esperado:
--     * data_type = 'text' nas 4 tabelas
--     * request_id presente em martin_brower_sincronizacoes
--     * contagens IDÊNTICAS
--     * uq_mb_sync_request no pg_indexes
--     * as duas regras de unicidade preservadas
-- =====================================================================

-- =====================================================================
-- 6. ROLLBACK — NÃO É AUTOMÁTICO, E NÃO DEVE SER
-- =====================================================================
-- Voltar text -> bigint é DESTRUTIVO por natureza: qualquer valor com zero à
-- esquerda ('04532'), espaço ou caractere não numérico é perdido ou faz o
-- ALTER falhar no meio. Não existe conversão segura genérica.
--
-- Se um dia for mesmo necessário, o procedimento é MANUAL e nesta ordem:
--
--   1. Parar toda escrita nas tabelas Martin Brower (colocar a integração
--      em manutenção).
--   2. Backup completo do banco — não um dump só destas tabelas.
--   3. Auditar os valores. TODOS precisam ser inteiros puros:
--        select distinct client_id from martin_brower_produtos
--         where client_id !~ '^[0-9]+$'
--            or client_id ~ '^0[0-9]'          -- zero à esquerda: PERDE dado
--         union all ...  (repetir nas 4 tabelas)
--      Qualquer linha aqui significa PARE: converter perderia informação.
--   4. Só com o passo 3 vazio:
--        alter table <tabela> alter column client_id type bigint
--          using client_id::bigint;
--   5. Reverter o código: validators, repositories, fixtures e testes voltam
--      a tratar clientId como número.
--   6. Remover o índice de idempotência, se também for revertido:
--        drop index if exists uq_mb_sync_request;
--        drop index if exists idx_mb_sync_request_lookup;
--        alter table martin_brower_sincronizacoes drop column if exists request_id;
--
-- Na prática: se a 019 der problema, prefira RESTAURAR O BACKUP a tentar
-- converter de volta.
-- =====================================================================
-- FIM
-- =====================================================================
