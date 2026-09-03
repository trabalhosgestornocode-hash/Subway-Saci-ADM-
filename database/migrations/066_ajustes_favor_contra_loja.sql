-- =====================================================================
-- MIGRATION 066 — Ajustes a favor / contra a loja (substitui "outras deduções")
-- =====================================================================
-- OBJETIVO
--   O campo único `outras_deducoes` era polissêmico: positivo reduzia a
--   receita e entrava no Total de Deduções; negativo (só com permissão de
--   correção + justificativa) era um "ajuste a favor" que aumentava a
--   receita. Passa a existir DOIS campos explícitos, ambos SEMPRE positivos:
--
--     ajustes_favor_loja  — crédito/reembolso  -> AUMENTA a receita líquida,
--                           NÃO entra no Total de Deduções.
--     ajustes_contra_loja — débito/desconto    -> REDUZ a receita líquida,
--                           ENTRA no Total de Deduções.
--
--   Fórmulas (vivem no backend, dashboardExecutivo.calc.js):
--     total_deducoes  = taxas_comissoes + servicos_promocoes
--                       + taxas_entregadores + ajustes_contra_loja
--     receita_liquida = valor_vendas_ifood - total_deducoes + ajustes_favor_loja
--
-- NULLABLE, sem default — "não informado" != 0 (mesmo espírito da 026).
--
-- BACKFILL (determinístico a partir de `outras_deducoes`, que NÃO é alterada):
--     outras_deducoes IS NULL  -> ajustes_favor_loja = NULL, ajustes_contra_loja = NULL
--     outras_deducoes = 0      -> ambos = 0 (preserva "informado como zero")
--     outras_deducoes > 0      -> ajustes_contra_loja = valor,  ajustes_favor_loja = 0
--     outras_deducoes < 0      -> ajustes_favor_loja = |valor|, ajustes_contra_loja = 0
--
--   Auditoria em produção (backend/scripts/audit-outras-deducoes.mjs) no
--   momento desta migration: 1494 linhas — 312 NULL, 346 zero, 835 positivas
--   (128 diário + 707 distribuição mensal), 1 negativa (-34,98, unidade
--   beab2fc2-f082-45ee-a5dc-8e32c2f848d7, 2026-09-01, justificativa
--   "Reembolso" — a prova esperada da conversão para ajuste a favor).
--
-- NÃO DESTRUTIVO: `outras_deducoes` NÃO é removida — fica dormente para
--   segurança/rollback. A remoção física poderá ocorrer numa migration 067
--   futura, após confirmação em produção de que nenhum código ativo mais a
--   lê/grava.
-- IDEMPOTENTE: `add column if not exists` + backfill guardado por
--   `ajustes_favor_loja is null and ajustes_contra_loja is null` (só toca
--   linha ainda não convertida). Pode ser reexecutada com segurança.
-- ORDEM DE DEPLOY: esta migration DEVE ser aplicada ANTES do deploy do
--   código novo — o backend passa a ler/gravar as colunas novas.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. COLUNAS NOVAS (NULLABLE, sem default)
-- ---------------------------------------------------------------------
alter table lancamentos_financeiros_diarios
  add column if not exists ajustes_favor_loja  numeric(14,2),
  add column if not exists ajustes_contra_loja numeric(14,2);

alter table lancamentos_financeiros_diarios drop constraint if exists lfd_ajustes_favor_loja_check;
alter table lancamentos_financeiros_diarios add constraint lfd_ajustes_favor_loja_check
  check (ajustes_favor_loja is null or ajustes_favor_loja >= 0);

alter table lancamentos_financeiros_diarios drop constraint if exists lfd_ajustes_contra_loja_check;
alter table lancamentos_financeiros_diarios add constraint lfd_ajustes_contra_loja_check
  check (ajustes_contra_loja is null or ajustes_contra_loja >= 0);

-- ---------------------------------------------------------------------
-- 2. BACKFILL a partir de `outras_deducoes` (idempotente)
-- ---------------------------------------------------------------------
update lancamentos_financeiros_diarios
   set ajustes_contra_loja = case when outras_deducoes >= 0 then outras_deducoes else 0 end,
       ajustes_favor_loja  = case when outras_deducoes <  0 then -outras_deducoes else 0 end
 where outras_deducoes is not null
   and ajustes_favor_loja is null
   and ajustes_contra_loja is null;

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente; nada aqui escreve):
--
--   -- colunas nuláveis, sem default:
--   select column_name, is_nullable, column_default
--   from information_schema.columns
--   where table_name = 'lancamentos_financeiros_diarios'
--     and column_name in ('ajustes_favor_loja','ajustes_contra_loja');
--
--   -- backfill: cada caso bate com a auditoria pré-migration:
--   select
--     count(*) filter (where outras_deducoes is null)                                as nulos,
--     count(*) filter (where outras_deducoes = 0)                                    as zeros,
--     count(*) filter (where outras_deducoes > 0)                                    as positivos,
--     count(*) filter (where outras_deducoes < 0)                                    as negativos,
--     count(*) filter (where outras_deducoes is null
--                        and (ajustes_favor_loja is not null or ajustes_contra_loja is not null)) as erro_nulos,
--     count(*) filter (where outras_deducoes > 0 and ajustes_contra_loja is distinct from outras_deducoes) as erro_pos,
--     count(*) filter (where outras_deducoes < 0 and ajustes_favor_loja is distinct from -outras_deducoes) as erro_neg
--   from lancamentos_financeiros_diarios;
--   -- erro_nulos / erro_pos / erro_neg devem ser 0.
--
--   -- a prova esperada (o único negativo vira ajuste a favor):
--   select data_lancamento, outras_deducoes, ajustes_favor_loja, ajustes_contra_loja, justificativa_ajuste
--   from lancamentos_financeiros_diarios
--   where unidade_id = 'beab2fc2-f082-45ee-a5dc-8e32c2f848d7' and data_lancamento = '2026-09-01';
--   -- esperado: outras_deducoes = -34.98, ajustes_favor_loja = 34.98, ajustes_contra_loja = 0.
-- =====================================================================
-- FIM
-- =====================================================================
