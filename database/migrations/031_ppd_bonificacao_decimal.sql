-- =====================================================================
-- MIGRATION 031 — PPD da Bonificação Mensal aceita decimal
-- =====================================================================
-- OBJETIVO
--   `bonificacao_lancamentos_diarios.ppd_geral`/`ppd_loja` eram `int`. O
--   relatório GERAL da Visio (soma de todos os canais) traz PPD médio
--   FRACIONÁRIO (ex.: "180,5") — só o relatório de uma unidade/canal isolado
--   costuma fechar em número inteiro (ex.: "57"). Com a coluna em `int`, a
--   importação do relatório Geral falhava ao gravar (ou truncaria o valor
--   silenciosamente, dependendo do driver).
--
--   O parser (backend/src/modules/bonificacao-mensal/visio-parser.js) já foi
--   corrigido para RECONHECER o valor fracionário (antes a linha inteira da
--   tabela "Torque por estabelecimento" era rejeitada por causa disso, e o
--   erro que aparecia era "Não foi possível localizar o faturamento e o PPD"
--   — mensagem genérica, mas a causa real era só o PPD ter vírgula).
--
-- IDEMPOTENTE: ALTER COLUMN TYPE não falha se já for numeric (mesma
--   precisão) — mas para reexecuções seguras, ver a checagem opcional na
--   seção de verificação abaixo antes de aplicar em produção duas vezes.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'bonificacao_lancamentos_diarios' and column_name = 'ppd_geral' and data_type <> 'numeric'
  ) then
    alter table bonificacao_lancamentos_diarios alter column ppd_geral type numeric(8,1);
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_name = 'bonificacao_lancamentos_diarios' and column_name = 'ppd_loja' and data_type <> 'numeric'
  ) then
    alter table bonificacao_lancamentos_diarios alter column ppd_loja type numeric(8,1);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- VERIFICAÇÃO
-- ---------------------------------------------------------------------
--   select column_name, data_type, numeric_precision, numeric_scale
--     from information_schema.columns
--    where table_name = 'bonificacao_lancamentos_diarios' and column_name in ('ppd_geral', 'ppd_loja');
--   -- Esperado: data_type = 'numeric', numeric_scale = 1 nas duas linhas.
-- =====================================================================
-- FIM
-- =====================================================================
