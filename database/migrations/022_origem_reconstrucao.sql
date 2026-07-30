-- =====================================================================
-- MIGRATION 022 — Origem/versionamento da base de insumos e fichas
-- Marca a procedência dos dados reconstruídos a partir da ficha técnica
-- oficial da Crescer com Delivery. Colunas nullable → sem impacto no legado.
-- Rode no SQL Editor do Supabase ANTES de aplicar a reconstrução.
-- =====================================================================
alter table insumos       add column if not exists origem text;
alter table ficha_tecnica add column if not exists origem text;

comment on column insumos.origem is 'Procedência do registro, ex: "Reconstrução a partir da nova ficha técnica da Crescer com Delivery"';
comment on column ficha_tecnica.origem is 'Procedência da linha de ficha (mesma convenção de insumos.origem)';

-- Verificação:
--   select origem, count(*) from insumos group by origem;
