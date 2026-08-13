-- =====================================================================
-- MIGRATION 037 — Parser Food Delivery (importação + conciliação)
-- =====================================================================
-- OBJETIVO
--   Novo módulo "Parser Food Delivery": importa o relatório .xls/.xlsx de
--   pedidos do food delivery (iFood/anota.ai) e concilia quais taxas de
--   entregador são válidas. Pedidos cancelados MANTÊM a taxa por padrão —
--   só viram "sem taxa" quando o usuário informa explicitamente o código
--   do pedido na importação (nunca inferido automaticamente).
--
--   3 tabelas:
--     1. parser_fd_importacoes — 1 linha por arquivo importado (resumo +
--        trilha de auditoria: quem, quando, arquivo, período, valores).
--     2. parser_fd_pedidos     — 1 linha por pedido do relatório, com a
--        classificação da conciliação e a linha original completa em
--        `dados_brutos` (fidelidade total ao relatório — nada inventado,
--        e já prepara terreno para uma futura métrica de tempo médio de
--        entrega sem precisar de outra migration).
--     3. parser_fd_auditoria   — log de criação/edição/exclusão de uma
--        importação (ex.: códigos "sem taxa" alterados depois de salva).
--
--   Módulo novo no catálogo (`modulos`) SEM backfill em
--   `organizacao_modulos` — ao contrário da migration 030, este começa
--   fechado para todas as empresas; o SuperAdmin decide quem ganha acesso
--   pela tela de Acessos já existente (data-driven a partir do catálogo).
--
-- PRÉ-REQUISITOS: migrations 014, 015, 016, 020, 030 aplicadas
--   (auth_unidade_ids(), is_platform_superadmin(), tabela `modulos`).
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. CATÁLOGO DE MÓDULOS — nova entrada, sem conceder a ninguém.
-- ---------------------------------------------------------------------
insert into modulos (id, nome, categoria, ordem) values
  ('parser_food_delivery', 'Parser Food Delivery', 'operacao', 14)
on conflict (id) do update set nome = excluded.nome, categoria = excluded.categoria, ordem = excluded.ordem;

-- ---------------------------------------------------------------------
-- 1. TRIGGER de atualização — mesmo espírito de bonificacao_set_atualizado_em
--    (schema em pt-BR, criado_em/atualizado_em).
-- ---------------------------------------------------------------------
create or replace function parser_fd_set_atualizado_em() returns trigger as $f$
begin
  new.atualizado_em = now();
  return new;
end;
$f$ language plpgsql;

-- ---------------------------------------------------------------------
-- 2. IMPORTAÇÕES — 1 linha por arquivo, com o resumo financeiro calculado.
-- ---------------------------------------------------------------------
create table if not exists parser_fd_importacoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  periodo_inicio date not null,
  periodo_fim date not null,
  nome_arquivo text,
  hash_arquivo text not null,
  arquivo_storage text,                          -- caminho no Storage (bucket parser-food-delivery)
  total_pedidos int not null default 0,
  entregues int not null default 0,
  cancelados int not null default 0,
  cancelados_com_taxa int not null default 0,
  cancelados_sem_taxa int not null default 0,
  taxas_brutas numeric(14,2) not null default 0,     -- soma de "Taxa do entregador" de TODOS os pedidos
  taxas_descartadas numeric(14,2) not null default 0, -- soma só dos cancelados marcados "sem taxa"
  taxas_validas numeric(14,2) not null default 0,     -- brutas - descartadas
  codigos_sem_taxa jsonb not null default '[]'::jsonb, -- códigos informados pelo usuário nesta importação
  status text not null default 'concluida' check (status in ('concluida', 'erro')),
  mensagem_erro text,
  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,
  usuario_email text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists idx_pfdimp_unidade_periodo on parser_fd_importacoes(unidade_id, periodo_inicio desc);
create index if not exists idx_pfdimp_org on parser_fd_importacoes(organizacao_id);
-- Mesmo arquivo (mesmo hash) não entra 2x para a mesma unidade — reimportar
-- o arquivo idêntico é sempre engano do usuário (a correção certa é editar
-- os códigos "sem taxa" da importação já salva, não reenviar o arquivo).
create unique index if not exists uq_pfdimp_hash on parser_fd_importacoes(unidade_id, hash_arquivo)
  where status = 'concluida';

drop trigger if exists trg_pfdimp_atualizado_em on parser_fd_importacoes;
create trigger trg_pfdimp_atualizado_em before update on parser_fd_importacoes
  for each row execute function parser_fd_set_atualizado_em();

-- ---------------------------------------------------------------------
-- 3. PEDIDOS — 1 linha por pedido do relatório importado.
-- ---------------------------------------------------------------------
create table if not exists parser_fd_pedidos (
  id uuid primary key default gen_random_uuid(),
  importacao_id uuid not null references parser_fd_importacoes(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  numero_pedido text not null,                   -- texto de propósito: preserva zeros à esquerda/formatos
  data_hora timestamptz,
  situacao text,
  entregador text,
  taxa_entregador numeric(14,2),
  valor_total_pedido numeric(14,2),
  forma_pagamento text,
  razao_cancelamento text,
  justificativa_cancelamento text,
  data_entregue timestamptz,
  data_finalizado timestamptz,
  data_cancelado timestamptz,
  origem text,
  sem_taxa_informado boolean not null default false,
  status_conciliacao text not null check (status_conciliacao in ('incluido', 'excluido', 'cancelado_com_taxa')),
  dados_brutos jsonb not null,                   -- linha original completa (todas as colunas), fonte de auditoria
  criado_em timestamptz not null default now()
);
create unique index if not exists uq_pfdped_importacao_pedido on parser_fd_pedidos(importacao_id, numero_pedido);
create index if not exists idx_pfdped_unidade on parser_fd_pedidos(unidade_id, data_hora desc);
create index if not exists idx_pfdped_entregador on parser_fd_pedidos(importacao_id, entregador);
create index if not exists idx_pfdped_status on parser_fd_pedidos(importacao_id, status_conciliacao);

-- ---------------------------------------------------------------------
-- 4. AUDITORIA — trilha de criação/edição/exclusão de uma importação.
--    Sem FK para parser_fd_importacoes: o log de uma exclusão não pode
--    sumir junto com a linha que acabou de ser apagada (mesmo motivo de
--    bonificacao_lancamentos_exclusoes, migration 032).
-- ---------------------------------------------------------------------
create table if not exists parser_fd_auditoria (
  id uuid primary key default gen_random_uuid(),
  importacao_id uuid not null,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  acao text not null check (acao in ('importacao_criada', 'codigos_alterados', 'excluida')),
  codigos_antes jsonb,
  codigos_depois jsonb,
  taxas_validas_antes numeric(14,2),
  taxas_validas_depois numeric(14,2),
  motivo text,
  snapshot jsonb,                                -- usado na exclusão: cópia da importação + pedidos antes de apagar
  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,
  usuario_email text,
  criado_em timestamptz not null default now()
);
create index if not exists idx_pfdaud_importacao on parser_fd_auditoria(importacao_id, criado_em desc);
create index if not exists idx_pfdaud_unidade on parser_fd_auditoria(unidade_id, criado_em desc);

-- ---------------------------------------------------------------------
-- 5. BUCKET privado para os arquivos originais (mesmo padrão do bucket
--    bonificacao-visio da migration 028 — backend usa service_role,
--    nenhuma policy pública).
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('parser-food-delivery', 'parser-food-delivery', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 6. RLS — mesmo padrão do projeto (backend usa service_role e ignora RLS;
--    estas policies só valem para o eventual acesso direto autenticado).
-- ---------------------------------------------------------------------
alter table parser_fd_importacoes enable row level security;
drop policy if exists rls_parser_fd_importacoes_tenant on parser_fd_importacoes;
create policy rls_parser_fd_importacoes_tenant on parser_fd_importacoes
  for all to authenticated
  using (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());

alter table parser_fd_pedidos enable row level security;
drop policy if exists rls_parser_fd_pedidos_tenant on parser_fd_pedidos;
create policy rls_parser_fd_pedidos_tenant on parser_fd_pedidos
  for all to authenticated
  using (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());

alter table parser_fd_auditoria enable row level security;
drop policy if exists rls_parser_fd_auditoria_tenant on parser_fd_auditoria;
create policy rls_parser_fd_auditoria_tenant on parser_fd_auditoria
  for all to authenticated
  using (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());
