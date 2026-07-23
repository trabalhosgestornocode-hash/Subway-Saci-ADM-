-- =====================================================================
-- MIGRATION 018 — Unicidade real das regras de filtro Martin Brower
-- =====================================================================
-- PROBLEMA
--   A migration 017 criou:
--       unique (organizacao_id, unidade_id, tipo, valor)
--   Só que `unidade_id` é NULLABLE (null = "regra vale para a organização
--   inteira"), e o Postgres trata NULL como DISTINTO de qualquer outro NULL
--   numa constraint UNIQUE. Resultado: a mesma regra de organização pode ser
--   inserida infinitas vezes sem violar a constraint.
--
--       insert ... (org1, null, 'palavra_chave', 'uniforme')   -- ok
--       insert ... (org1, null, 'palavra_chave', 'uniforme')   -- ok TAMBÉM (bug)
--
--   Impacto real: BAIXO — regra duplicada só é avaliada duas vezes pelo
--   filtro, sem alterar o resultado. Mas a constraint não cumpre o que
--   promete, e isso vira armadilha quando a tela de configuração existir.
--
-- COLUNAS DA REGRA (confirmado no schema da 017):
--   organizacao_id  NOT NULL
--   unidade_id      NULLABLE  <- a única opcional; é a causa do problema
--   tipo            NOT NULL
--   valor           NOT NULL
--   (`acao` NÃO participa: 'ignorar' e 'incluir' para a mesma regra seriam
--    contraditórias, então devem mesmo colidir.)
--
-- SOLUÇÃO ESCOLHIDA: DOIS ÍNDICES ÚNICOS PARCIAIS.
--   * um para regras de unidade   (where unidade_id is not null)
--   * um para regras de organização (where unidade_id is null)
--
--   POR QUE NÃO coalesce(unidade_id, '00000000-...-0000'):
--   a abordagem com sentinela funciona, mas exige cravar um UUID "mágico"
--   que, por contrato, nunca pode existir em `unidades`. Nada no banco impede
--   alguém de criar uma unidade com esse id — e o dia em que isso acontecer,
--   uma regra de unidade colidiria silenciosamente com uma regra de
--   organização. Índice parcial não tem valor mágico nenhum e expressa
--   exatamente a intenção: são DUAS regras de unicidade diferentes, para dois
--   escopos diferentes.
--
-- ADITIVA E NÃO DESTRUTIVA
--   * não recria nem altera a tabela;
--   * não apaga linha nenhuma;
--   * mantém a constraint original da 017 (ela continua correta para linhas
--     com unidade_id preenchido; removê-la seria destrutivo sem ganho).
--
-- IDEMPOTENTE: create index if not exists. Pode ser reexecutada.
--
-- SEGURA EM BANCO JÁ PREENCHIDO
--   Se já existirem duplicatas, a criação do índice falharia com um erro
--   críptico do Postgres. O bloco 1 detecta ANTES e aborta com mensagem
--   explicando exatamente o que fazer. NADA é apagado automaticamente.
--
-- COMO USAR: Supabase -> SQL Editor -> execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PRÉ-CHECAGEM — aborta com mensagem clara se houver duplicatas.
--    Não apaga nada: a decisão de qual linha manter é do administrador.
-- ---------------------------------------------------------------------
do $$
declare
  dup_org int;
  dup_uni int;
begin
  if to_regclass('public.martin_brower_filtros') is null then
    raise exception using
      errcode = 'undefined_table',
      message = 'MB 018: tabela martin_brower_filtros nao existe.',
      hint    = 'Aplique antes a migration 017_martin_brower.sql.';
  end if;

  -- Duplicatas entre regras de ORGANIZAÇÃO (unidade_id null) — o bug real.
  select count(*) into dup_org from (
    select organizacao_id, tipo, valor
      from public.martin_brower_filtros
     where unidade_id is null
     group by organizacao_id, tipo, valor
    having count(*) > 1
  ) d;

  -- Duplicatas entre regras de UNIDADE — não deveriam existir (a constraint
  -- da 017 já as impedia), mas conferimos para o índice não falhar.
  select count(*) into dup_uni from (
    select organizacao_id, unidade_id, tipo, valor
      from public.martin_brower_filtros
     where unidade_id is not null
     group by organizacao_id, unidade_id, tipo, valor
    having count(*) > 1
  ) d;

  if dup_org > 0 or dup_uni > 0 then
    raise exception using
      errcode = 'unique_violation',
      message = format('MB 018 ABORTADA: existem %s grupo(s) de regra de ORGANIZACAO e %s de UNIDADE duplicados.',
                       dup_org, dup_uni),
      hint    = 'NADA foi alterado. Rode a query de diagnostico da secao 3 deste arquivo, '
                'decida quais linhas manter, remova as demais MANUALMENTE e execute esta migration de novo.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. ÍNDICES ÚNICOS PARCIAIS
-- ---------------------------------------------------------------------

-- Regras de UNIDADE: uma regra por (organização, unidade, tipo, valor).
create unique index if not exists uq_mb_filtros_regra_unidade
  on public.martin_brower_filtros (organizacao_id, unidade_id, tipo, valor)
  where unidade_id is not null;

-- Regras de ORGANIZAÇÃO: uma regra por (organização, tipo, valor).
-- `unidade_id` fica FORA da chave — para estas linhas ele é sempre NULL, e
-- incluí-lo é justamente o que reintroduziria o bug.
create unique index if not exists uq_mb_filtros_regra_org
  on public.martin_brower_filtros (organizacao_id, tipo, valor)
  where unidade_id is null;

-- OBSERVAÇÃO SOBRE ISOLAMENTO: `organizacao_id` é a primeira coluna dos DOIS
-- índices, então organizações diferentes nunca colidem entre si. O mesmo vale
-- para unidades no primeiro índice. A unicidade é sempre DENTRO do tenant.

-- ---------------------------------------------------------------------
-- 3. DIAGNÓSTICO E SANEAMENTO (rode separadamente, se a seção 1 abortar)
-- ---------------------------------------------------------------------
-- (a) Quais regras estão duplicadas?
--   select organizacao_id, unidade_id, tipo, valor, count(*) as vezes,
--          array_agg(id order by criado_em) as ids
--     from martin_brower_filtros
--    group by organizacao_id, unidade_id, tipo, valor
--   having count(*) > 1
--    order by vezes desc;
--
-- (b) Conferir o que será removido ANTES de remover (mantém a mais antiga):
--   with ranqueadas as (
--     select id, organizacao_id, unidade_id, tipo, valor, acao, criado_em,
--            row_number() over (
--              partition by organizacao_id, coalesce(unidade_id::text,'ORG'), tipo, valor
--              order by criado_em, id) as posicao
--       from martin_brower_filtros)
--   select * from ranqueadas where posicao > 1 order by organizacao_id, tipo, valor;
--
-- (c) Só depois de conferir (b), e se concordar com a escolha:
--   with ranqueadas as ( ...mesmo CTE de (b)... )
--   delete from martin_brower_filtros
--    where id in (select id from ranqueadas where posicao > 1);
--
--   ATENÇÃO: se as duplicatas tiverem `acao` ou `motivo` diferentes, a mais
--   antiga pode não ser a que você quer manter. Confira (b) antes.

-- ---------------------------------------------------------------------
-- 4. VERIFICAÇÃO (rode separadamente)
--   select indexname, indexdef from pg_indexes
--    where schemaname='public' and tablename='martin_brower_filtros'
--      and indexname like 'uq_mb_filtros%';
--   -- Esperado: 2 linhas (uq_mb_filtros_regra_org e uq_mb_filtros_regra_unidade).
-- =====================================================================
-- FIM
-- =====================================================================
