-- =====================================================================
-- MIGRATION 028 — Bonificação Mensal
-- =====================================================================
-- OBJETIVO
--   Nova área "Bonificação Mensal" (menu, logo abaixo do Dashboard iFood).
--   Substitui a planilha manual de metas/bonificação por um módulo com:
--     1. bonificacao_importacoes        — 1 linha por arquivo PDF da Visio
--        importado (Geral OU Loja), com hash p/ evitar reimportação.
--     2. bonificacao_lancamentos_diarios — 1 linha por unidade + dia, com
--        os valores BRUTOS (nunca só percentual — ver dashboardBonificacao
--        no backend, que deriva tudo em tempo real).
--     3. bonificacao_metas               — um indicador (faturamento,
--        bebidas...) com vigência (valid_from/valid_until), por unidade.
--     4. bonificacao_metas_faixas        — as faixas de bônus de cada meta
--        (suporta limite_minimo, limite_maximo e intervalo — cobre tanto
--        metas ascendentes normais quanto o CMV, que na planilha de origem
--        usa faixas descendentes/intervalos, não um "maior é melhor" simples).
--
--   Percentuais (Bebidas/Adicionais/Diversos) NÃO são colunas de cálculo:
--   são sempre derivados das quantidades brutas pelo backend. As colunas
--   `percentual_*_pdf` abaixo são só um SNAPSHOT do que a Visio informou,
--   para a validação cruzada do item 11 das instruções — nunca lidas pelo
--   motor de metas.
--
--   Seed: metas de agosto/2026 da Subway Saci (única unidade REAL hoje —
--   "Subway North Shopping" existe só na planilha de referência, não é
--   uma unidade cadastrada; a arquitetura já suporta adicioná-la quando
--   existir, sem mudança de schema). Unidade fixa (mesma da migration 024):
--     '00000000-0000-0000-0000-0000000000a1' (Subway Saci)
--     '00000000-0000-0000-0000-000000000001' (organização)
--
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'bonificacao_direcao_enum') then
    create type bonificacao_direcao_enum as enum ('higher_is_better', 'lower_is_better');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'bonificacao_faixa_tipo_enum') then
    -- limite_minimo: valor >= valor_min       (metas "maior é melhor" normais)
    -- limite_maximo: valor <= valor_max       (ex.: "até 28% de CMV")
    -- intervalo:     valor_min <= valor <= valor_max (ex.: "29% a 30% de CMV")
    create type bonificacao_faixa_tipo_enum as enum ('limite_minimo', 'limite_maximo', 'intervalo');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'bonificacao_tipo_relatorio_enum') then
    create type bonificacao_tipo_relatorio_enum as enum ('geral', 'loja');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1b. TRIGGER de atualização — este schema usa nomes em pt-BR
--     (criado_em/atualizado_em), diferente do set_updated_at() genérico do
--     projeto (que espera created_at/updated_at, usado por outros módulos
--     como o Dashboard iFood). Função própria, escopada só às tabelas
--     abaixo, pra não colidir com a convenção de nenhum dos dois lados.
-- ---------------------------------------------------------------------
create or replace function bonificacao_set_atualizado_em() returns trigger as $f$
begin
  new.atualizado_em = now();
  return new;
end;
$f$ language plpgsql;

-- ---------------------------------------------------------------------
-- 2. IMPORTAÇÕES (trilha de auditoria de cada PDF da Visio recebido)
-- ---------------------------------------------------------------------
create table if not exists bonificacao_importacoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  data_lancamento date,                        -- null só é possível em erro (ver status)
  tipo_relatorio bonificacao_tipo_relatorio_enum not null,
  nome_arquivo text,
  hash_arquivo text,
  arquivo_storage text,                        -- caminho no Storage (bucket bonificacao-visio)
  estabelecimento_detectado text,               -- nome extraído do PDF (validação de unidade)
  status text not null default 'concluida' check (status in ('concluida', 'erro')),
  mensagem_erro text,
  substituiu_importacao_id uuid references bonificacao_importacoes(id) on delete set null,
  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,
  criado_em timestamptz not null default now()
);
create index if not exists idx_bimp_unidade_data on bonificacao_importacoes(unidade_id, data_lancamento desc);
create index if not exists idx_bimp_org on bonificacao_importacoes(organizacao_id);
-- Mesmo arquivo (mesmo hash) não entra 2x para o mesmo tipo de relatório na mesma unidade.
create unique index if not exists uq_bimp_hash on bonificacao_importacoes(unidade_id, tipo_relatorio, hash_arquivo)
  where hash_arquivo is not null and status = 'concluida';

-- ---------------------------------------------------------------------
-- 3. LANÇAMENTO DIÁRIO (1 linha por unidade + dia)
-- ---------------------------------------------------------------------
create table if not exists bonificacao_lancamentos_diarios (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  data date not null,

  -- Loja marcou explicitamente que não operou neste dia (item 21/22 —
  -- ausência de operação NUNCA vira 0 sozinha; precisa ser um `true` explícito).
  sem_operacao boolean not null default false,
  motivo_sem_operacao text,

  -- ---- Fonte: PDF GERAL (todos os canais) ----
  faturamento_geral numeric(14,2),
  ppd_geral int,
  estabelecimento_geral text,                  -- nome extraído do PDF Geral

  -- ---- Fonte: PDF LOJA (balcão/presencial) ----
  faturamento_loja numeric(14,2),
  ppd_loja int,
  qtd_sanduiches_loja int,
  qtd_bebidas_loja int,
  qtd_adicionais_loja int,
  qtd_diversos_loja int,
  estabelecimento_loja text,                   -- nome extraído do PDF Loja

  -- Snapshot dos percentuais que o PRÓPRIO PDF informou — só para a
  -- validação cruzada (item 11). O cálculo real usa sempre as quantidades
  -- acima, nunca estas colunas (ver bonificacaoMensal.calc.js).
  percentual_bebidas_pdf numeric(6,3),
  percentual_adicionais_pdf numeric(6,3),
  percentual_diversos_pdf numeric(6,3),

  -- ---- Indicadores sem fonte automática nesta 1ª etapa (lançamento manual) ----
  cmv_pct numeric(6,3),
  ticket_medio numeric(10,2),
  avaliacao_ifood numeric(3,2),
  cancelamentos_pct numeric(6,3),
  pedidos_chamado_pct numeric(6,3),
  rev_nota numeric(6,2),
  pesquisas_qtd int,

  origem text not null default 'manual' check (origem in ('visio', 'manual', 'misto')),
  -- Quais campos foram corrigidos manualmente após a extração automática
  -- (ex.: {"faturamentoGeral": true}). Nunca silencioso — item 19.
  manual_override jsonb not null default '{}'::jsonb,

  importacao_geral_id uuid references bonificacao_importacoes(id) on delete set null,
  importacao_loja_id uuid references bonificacao_importacoes(id) on delete set null,

  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  unique (unidade_id, data)
);
create index if not exists idx_bld_unidade_data on bonificacao_lancamentos_diarios(unidade_id, data desc);
create index if not exists idx_bld_org on bonificacao_lancamentos_diarios(organizacao_id);

drop trigger if exists trg_bld_upd on bonificacao_lancamentos_diarios;
create trigger trg_bld_upd before update on bonificacao_lancamentos_diarios
  for each row execute function bonificacao_set_atualizado_em();

-- ---------------------------------------------------------------------
-- 4. METAS (por unidade, com vigência — histórico não muda quando a meta
--    futura é editada, porque cada linha tem seu próprio valid_from/until)
-- ---------------------------------------------------------------------
create table if not exists bonificacao_metas (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  indicador text not null check (indicador in (
    'faturamento', 'bebidas', 'adicionais', 'diversos', 'cmv', 'ticket_medio',
    'avaliacao_ifood', 'cancelamentos', 'pedidos_chamado', 'rev', 'pesquisas'
  )),
  direcao bonificacao_direcao_enum not null,
  valid_from date not null,
  valid_until date,                             -- null = vigente até nova meta substituir
  observacao text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists idx_bmeta_unidade_indicador on bonificacao_metas(unidade_id, indicador, valid_from desc);

drop trigger if exists trg_bmeta_upd on bonificacao_metas;
create trigger trg_bmeta_upd before update on bonificacao_metas
  for each row execute function bonificacao_set_atualizado_em();

-- Impede duas metas do MESMO indicador com o MESMO valid_from na mesma
-- unidade (a edição de uma meta futura cria uma linha nova, não sobrescreve).
create unique index if not exists uq_bmeta_unidade_indicador_from on bonificacao_metas(unidade_id, indicador, valid_from);

-- ---------------------------------------------------------------------
-- 5. FAIXAS DE BÔNUS DE CADA META
-- ---------------------------------------------------------------------
create table if not exists bonificacao_metas_faixas (
  id uuid primary key default gen_random_uuid(),
  meta_id uuid not null references bonificacao_metas(id) on delete cascade,
  ordem int not null,                           -- 1 = pior faixa premiada, crescente
  tipo bonificacao_faixa_tipo_enum not null,
  valor_min numeric(14,4),                      -- obrigatório p/ limite_minimo e intervalo
  valor_max numeric(14,4),                      -- obrigatório p/ limite_maximo e intervalo
  -- Nullable de propósito: null = "sem valor de bonificação definido ainda"
  -- (ex.: Avaliação iFood/Cancelamentos/Pedidos com chamado na planilha de
  -- origem têm limite mas nenhum R$ associado). 0 = bônus real de zero reais
  -- (ex.: 1ª faixa de REV/Pesquisas). NÃO confundir os dois — item 60/22.
  bonus numeric(10,2),
  unique (meta_id, ordem)
);
create index if not exists idx_bfaixa_meta on bonificacao_metas_faixas(meta_id, ordem);

-- ---------------------------------------------------------------------
-- 5b. BUCKET privado para os PDFs originais da Visio (mesmo padrão do
--     bucket vendas-relatorios da migration 013 — backend usa service_role,
--     nenhuma policy pública).
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('bonificacao-visio', 'bonificacao-visio', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 6. RLS — mesmo padrão do projeto (backend usa service_role e ignora RLS;
--    estas policies só valem para o eventual acesso direto autenticado).
-- ---------------------------------------------------------------------
alter table bonificacao_importacoes enable row level security;
drop policy if exists rls_bonificacao_importacoes_tenant on bonificacao_importacoes;
create policy rls_bonificacao_importacoes_tenant on bonificacao_importacoes
  for all to authenticated
  using (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());

alter table bonificacao_lancamentos_diarios enable row level security;
drop policy if exists rls_bonificacao_lancamentos_tenant on bonificacao_lancamentos_diarios;
create policy rls_bonificacao_lancamentos_tenant on bonificacao_lancamentos_diarios
  for all to authenticated
  using (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());

alter table bonificacao_metas enable row level security;
drop policy if exists rls_bonificacao_metas_tenant on bonificacao_metas;
create policy rls_bonificacao_metas_tenant on bonificacao_metas
  for all to authenticated
  using (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());

alter table bonificacao_metas_faixas enable row level security;
drop policy if exists rls_bonificacao_metas_faixas_tenant on bonificacao_metas_faixas;
create policy rls_bonificacao_metas_faixas_tenant on bonificacao_metas_faixas
  for all to authenticated
  using (is_platform_superadmin() or exists (
    select 1 from bonificacao_metas m
    where m.id = bonificacao_metas_faixas.meta_id and m.unidade_id in (select auth_unidade_ids())
  ))
  with check (is_platform_superadmin() or exists (
    select 1 from bonificacao_metas m
    where m.id = bonificacao_metas_faixas.meta_id and m.unidade_id in (select auth_unidade_ids())
  ));

-- ---------------------------------------------------------------------
-- 7. SEED — metas de agosto/2026 da Subway Saci, extraídas de METAS
--    LOJAS.xlsx. Bloco idempotente: só semeia se a unidade existir e ainda
--    não houver meta cadastrada para o indicador com este valid_from.
--    Percentuais em escala 0-100 (40 = 40%); Faturamento/Ticket em R$.
--    Pesquisas usa a regra CORRIGIDA do item 34 (a planilha original tinha
--    um bug na 3ª faixa: "120 pesquisas: R$ 50" — deveria ser R$ 100, e a
--    1ª faixa era "60 pesquisas: R$ 0", corrigida para o corte de 90).
-- ---------------------------------------------------------------------
-- Helper temporário (removido no fim deste arquivo): PL/pgSQL não permite
-- declarar uma sub-rotina dentro de um bloco DO, então isto vira uma
-- function de verdade só para não repetir o mesmo "insere se não existe"
-- 11 vezes.
create or replace function _bonificacao_seed_meta(
  p_unidade_id uuid, p_organizacao_id uuid, p_indicador text,
  p_direcao bonificacao_direcao_enum, p_valid_from date
) returns uuid as $f$
declare v_id uuid;
begin
  select id into v_id from bonificacao_metas
    where unidade_id = p_unidade_id and indicador = p_indicador and valid_from = p_valid_from;
  if v_id is null then
    insert into bonificacao_metas (organizacao_id, unidade_id, indicador, direcao, valid_from, observacao)
      values (p_organizacao_id, p_unidade_id, p_indicador, p_direcao, p_valid_from,
              'Seed migration 028 — METAS LOJAS.xlsx (Subway Saci, ago/2026)')
      returning id into v_id;
  end if;
  return v_id;
end;
$f$ language plpgsql;

do $$
declare
  v_unidade_id uuid := '00000000-0000-0000-0000-0000000000a1';
  v_organizacao_id uuid;
  v_meta_id uuid;
  v_valid_from date := '2026-08-01';
begin
  select organizacao_id into v_organizacao_id from unidades where id = v_unidade_id;
  if v_organizacao_id is null then
    raise notice 'Migration 028: unidade Subway Saci (%) não encontrada — seed de metas pulado.', v_unidade_id;
    return;
  end if;

  -- Faturamento (R$, acumulado do mês — fonte: PDF Geral)
  v_meta_id := _bonificacao_seed_meta(v_unidade_id, v_organizacao_id, 'faturamento', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, bonus) values
    (v_meta_id, 1, 'limite_minimo', 334193.85, 100.00),
    (v_meta_id, 2, 'limite_minimo', 350903.54, 150.00),
    (v_meta_id, 3, 'limite_minimo', 367613.24, 200.00)
  on conflict (meta_id, ordem) do nothing;

  -- Bebidas (%, mix mensal ponderado — fonte: PDF Loja)
  v_meta_id := _bonificacao_seed_meta(v_unidade_id, v_organizacao_id, 'bebidas', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, bonus) values
    (v_meta_id, 1, 'limite_minimo', 40, 25.00),
    (v_meta_id, 2, 'limite_minimo', 45, 50.00),
    (v_meta_id, 3, 'limite_minimo', 52, 75.00)
  on conflict (meta_id, ordem) do nothing;

  -- Adicionais (%, mix mensal ponderado — fonte: PDF Loja)
  v_meta_id := _bonificacao_seed_meta(v_unidade_id, v_organizacao_id, 'adicionais', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, bonus) values
    (v_meta_id, 1, 'limite_minimo', 20, 25.00),
    (v_meta_id, 2, 'limite_minimo', 25, 50.00),
    (v_meta_id, 3, 'limite_minimo', 30, 75.00)
  on conflict (meta_id, ordem) do nothing;

  -- Diversos (%, mix mensal ponderado — fonte: PDF Loja)
  v_meta_id := _bonificacao_seed_meta(v_unidade_id, v_organizacao_id, 'diversos', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, bonus) values
    (v_meta_id, 1, 'limite_minimo', 20, 25.00),
    (v_meta_id, 2, 'limite_minimo', 28, 50.00),
    (v_meta_id, 3, 'limite_minimo', 38, 75.00)
  on conflict (meta_id, ordem) do nothing;

  -- CMV (%, faixas descendentes/intervalos — reproduz literalmente a
  -- planilha, incluindo o intervalo 28,9%–29% que fica sem faixa)
  v_meta_id := _bonificacao_seed_meta(v_unidade_id, v_organizacao_id, 'cmv', 'lower_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, valor_max, bonus) values
    (v_meta_id, 1, 'intervalo', 29.0, 30.0, 100.00),
    (v_meta_id, 2, 'intervalo', 28.1, 28.9, 150.00),
    (v_meta_id, 3, 'limite_maximo', null, 28.0, 200.00)
  on conflict (meta_id, ordem) do nothing;

  -- Ticket médio (R$ — sem fonte automática nesta 1ª etapa, lançamento manual)
  v_meta_id := _bonificacao_seed_meta(v_unidade_id, v_organizacao_id, 'ticket_medio', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, bonus) values
    (v_meta_id, 1, 'limite_minimo', 48, 100.00),
    (v_meta_id, 2, 'limite_minimo', 50, 150.00),
    (v_meta_id, 3, 'limite_minimo', 53, 200.00)
  on conflict (meta_id, ordem) do nothing;

  -- REV (nota 0-100 — sem fonte automática nesta 1ª etapa, lançamento manual)
  v_meta_id := _bonificacao_seed_meta(v_unidade_id, v_organizacao_id, 'rev', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, bonus) values
    (v_meta_id, 1, 'limite_minimo', 80, 0.00),
    (v_meta_id, 2, 'limite_minimo', 90, 50.00),
    (v_meta_id, 3, 'limite_minimo', 100, 100.00)
  on conflict (meta_id, ordem) do nothing;

  -- Pesquisas/NPS (quantidade — regra CORRIGIDA do item 34)
  v_meta_id := _bonificacao_seed_meta(v_unidade_id, v_organizacao_id, 'pesquisas', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, valor_max, bonus) values
    (v_meta_id, 1, 'intervalo', 0, 89, 0.00),
    (v_meta_id, 2, 'limite_minimo', 90, null, 50.00),
    (v_meta_id, 3, 'limite_minimo', 120, null, 100.00)
  on conflict (meta_id, ordem) do nothing;

  -- Avaliação iFood, Cancelamentos e Pedidos com chamado — a planilha só
  -- define o LIMITE, sem nenhum valor de bonificação em R$ (nem para a
  -- única faixa). Cadastrados como indicador de acompanhamento (bonus =
  -- null = "sem valor definido"), pendente de decisão de negócio.
  v_meta_id := _bonificacao_seed_meta(v_unidade_id, v_organizacao_id, 'avaliacao_ifood', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, bonus) values
    (v_meta_id, 1, 'limite_minimo', 4.7, null)
  on conflict (meta_id, ordem) do nothing;

  v_meta_id := _bonificacao_seed_meta(v_unidade_id, v_organizacao_id, 'cancelamentos', 'lower_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_max, bonus) values
    (v_meta_id, 1, 'limite_maximo', 1.0, null)
  on conflict (meta_id, ordem) do nothing;

  v_meta_id := _bonificacao_seed_meta(v_unidade_id, v_organizacao_id, 'pedidos_chamado', 'lower_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_max, bonus) values
    (v_meta_id, 1, 'limite_maximo', 2.5, null)
  on conflict (meta_id, ordem) do nothing;
end $$;

drop function if exists _bonificacao_seed_meta(uuid, uuid, text, bonificacao_direcao_enum, date);

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente):
--   select m.indicador, m.direcao, f.ordem, f.tipo, f.valor_min, f.valor_max, f.bonus
--   from bonificacao_metas m join bonificacao_metas_faixas f on f.meta_id = m.id
--   where m.unidade_id = '00000000-0000-0000-0000-0000000000a1'
--   order by m.indicador, f.ordem;
-- =====================================================================
