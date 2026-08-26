-- =====================================================================
-- MIGRATION 054 — Correção pontual: schema explícito no helper da 053
-- =====================================================================
-- ESCOPO DELIBERADAMENTE ESTREITO: só a função
-- remapear_organizacao_em_tabelas_de_unidade (nenhuma outra função da 053,
-- nenhum dado). `create or replace function` não apaga nem move nenhuma
-- linha — troca só a definição da função. Não promove/converte/transfere
-- nada sozinha.
--
-- O QUE MUDOU: o UPDATE dinâmico usava `%I` (nome da tabela só com quoting
-- de identificador). Trocado para `public.%I` — qualifica o schema
-- explicitamente, blindando contra um `search_path` diferente do padrão
-- resolver o identificador pra outro schema por engano. Não muda
-- comportamento sob o search_path padrão do Supabase (já resolve pra
-- public primeiro) — é um endurecimento defensivo, não uma correção de bug
-- observado.
--
-- ROLLBACK — definição ANTERIOR, exatamente como foi aplicada pela 053
-- original (cole isto de volta se precisar reverter):
--
--   create or replace function remapear_organizacao_em_tabelas_de_unidade(
--     p_unidade_id uuid, p_org_antiga_id uuid, p_org_nova_id uuid
--   ) returns jsonb
--   language plpgsql
--   as $$
--   declare
--     v_tabela text;
--     v_qtd int;
--     v_resultado jsonb := '{}'::jsonb;
--   begin
--     for v_tabela in
--       select c1.table_name
--       from information_schema.columns c1
--       join information_schema.columns c2
--         on c2.table_schema = c1.table_schema and c2.table_name = c1.table_name and c2.column_name = 'unidade_id'
--       join information_schema.tables t
--         on t.table_schema = c1.table_schema and t.table_name = c1.table_name and t.table_type = 'BASE TABLE'
--       where c1.table_schema = 'public' and c1.column_name = 'organizacao_id'
--         and c1.table_name not in ('martin_brower_vinculos', 'sessoes_contexto', 'insumo_historico')
--       order by c1.table_name
--     loop
--       execute format(
--         'update %I set organizacao_id = $1 where unidade_id = $2 and organizacao_id = $3',
--         v_tabela
--       ) using p_org_nova_id, p_unidade_id, p_org_antiga_id;
--       get diagnostics v_qtd = row_count;
--       if v_qtd > 0 then
--         v_resultado := v_resultado || jsonb_build_object(v_tabela, v_qtd);
--       end if;
--     end loop;
--     return v_resultado;
--   end;
--   $$;
--
-- COMO USAR: Supabase -> SQL Editor -> cole e execute só o bloco abaixo
-- (a definição corrigida) e depois a consulta de verificação, nessa ordem.
-- =====================================================================

create or replace function remapear_organizacao_em_tabelas_de_unidade(
  p_unidade_id uuid, p_org_antiga_id uuid, p_org_nova_id uuid
) returns jsonb
language plpgsql
as $$
declare
  v_tabela text;
  v_qtd int;
  v_resultado jsonb := '{}'::jsonb;
begin
  for v_tabela in
    select c1.table_name
    from information_schema.columns c1
    join information_schema.columns c2
      on c2.table_schema = c1.table_schema and c2.table_name = c1.table_name and c2.column_name = 'unidade_id'
    join information_schema.tables t
      on t.table_schema = c1.table_schema and t.table_name = c1.table_name and t.table_type = 'BASE TABLE'
    where c1.table_schema = 'public' and c1.column_name = 'organizacao_id'
      and c1.table_name not in ('martin_brower_vinculos', 'sessoes_contexto', 'insumo_historico')
    order by c1.table_name
  loop
    execute format(
      'update public.%I set organizacao_id = $1 where unidade_id = $2 and organizacao_id = $3',
      v_tabela
    ) using p_org_nova_id, p_unidade_id, p_org_antiga_id;
    get diagnostics v_qtd = row_count;
    if v_qtd > 0 then
      v_resultado := v_resultado || jsonb_build_object(v_tabela, v_qtd);
    end if;
  end loop;
  return v_resultado;
end;
$$;

-- =====================================================================
-- VERIFICAÇÃO — confirma que a versão instalada usa "public.%I".
-- Só LEITURA (pg_get_functiondef não altera nada). Rode depois do CREATE
-- OR REPLACE acima e confira que "usa_public_qualificado" volta `true`.
-- =====================================================================
select
  p.proname as funcao,
  pg_get_functiondef(p.oid) like '%update public.%I%' as usa_public_qualificado,
  pg_get_functiondef(p.oid) as definicao_completa
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'remapear_organizacao_em_tabelas_de_unidade';
