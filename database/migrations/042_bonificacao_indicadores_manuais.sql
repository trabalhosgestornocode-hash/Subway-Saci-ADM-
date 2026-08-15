-- =====================================================================
-- MIGRATION 042 — Indicadores manuais mensais da Bonificação Mensal
-- =====================================================================
-- POR QUE ESTA MIGRATION EXISTE
--   4 indicadores (REV, Pesquisas, Avaliação/Nota iFood, Pedidos com
--   Chamado) não têm fonte automática confiável — precisam de lançamento
--   manual. Eles já existiam como colunas em bonificacao_lancamentos_diarios
--   (rev_nota, pesquisas_qtd, avaliacao_ifood, pedidos_chamado_pct), mas são
--   indicadores MENSAIS por natureza (ex.: "104 pesquisas no mês"), não
--   diários — encaixá-los na tabela diária forçava escolher um dia
--   arbitrário pra pendurar um valor que é do mês inteiro.
--
--   Esta migration cria uma tabela própria, granularidade MÊS (unidade +
--   indicador + ano + mês = 1 linha), no mesmo espírito de
--   bonificacao_metas (indicador text + check constraint). As colunas
--   antigas na tabela diária NÃO são removidas (não há dado real hoje —
--   nenhuma UI jamais as preencheu — mas remover schema é sempre a ação
--   mais fácil de reverter no sentido contrário: manter é mais seguro).
--
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- =====================================================================

create table if not exists bonificacao_indicadores_manuais (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  indicador text not null check (indicador in ('rev', 'pesquisas', 'avaliacao_ifood', 'pedidos_chamado')),
  ano int not null check (ano between 2000 and 2100),
  mes int not null check (mes between 1 and 12),
  valor numeric(12,4) not null,

  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  unique (unidade_id, indicador, ano, mes)
);
create index if not exists idx_bim_unidade_indicador on bonificacao_indicadores_manuais(unidade_id, indicador, ano desc, mes desc);
create index if not exists idx_bim_org on bonificacao_indicadores_manuais(organizacao_id);

-- Reaproveita a function já criada pela migration 028 (não foi dropada —
-- só o helper de seed _bonificacao_seed_meta foi).
drop trigger if exists trg_bim_upd on bonificacao_indicadores_manuais;
create trigger trg_bim_upd before update on bonificacao_indicadores_manuais
  for each row execute function bonificacao_set_atualizado_em();

-- RLS — mesmo padrão do resto do módulo (migration 028): backend usa
-- service_role e ignora RLS; esta policy só vale para acesso direto autenticado.
alter table bonificacao_indicadores_manuais enable row level security;
drop policy if exists rls_bonificacao_indicadores_manuais_tenant on bonificacao_indicadores_manuais;
create policy rls_bonificacao_indicadores_manuais_tenant on bonificacao_indicadores_manuais
  for all to authenticated
  using (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());
