-- =====================================================================
-- MIGRATION 049 — Agente Crescer: métricas de uso/custo (observabilidade)
-- =====================================================================
-- OBJETIVO
--   Uma linha por INTERAÇÃO (1 mensagem do usuário = 1 registro, mesmo que
--   internamente tenham ocorrido várias chamadas à Anthropic por causa de
--   tool use — agente.service.js já soma tudo antes de gravar). Existe para
--   responder, com dado real: quanto custa em média uma pergunta, quanto uma
--   unidade consome por mês, qual organização mais usa, qual modelo tem
--   melhor custo-benefício. Esta fase é SÓ MEDIÇÃO — nenhum bloqueio, nenhuma
--   cobrança, nenhum limite aplicado.
--
--   organizacao_id/unidade_id/usuario_id DENORMALIZADOS (mesmo padrão de
--   parser_fd_pedidos, migration 037): permite agregar por tenant sem join
--   através de agente_conversas a cada consulta do SuperAdmin.
--
--   NÃO duplica conteúdo de conversa — o texto das mensagens continua só em
--   agente_mensagens (migration 048). Esta tabela mede QUEM/QUANTO/QUANDO/
--   QUAL MODELO, nunca O QUÊ foi perguntado.
--
--   PREÇO MUTÁVEL, HISTÓRICO IMUTÁVEL: `estimated_cost_usd` é calculado com
--   a tabela de preços vigente NO MOMENTO da interação (agente.pricing.js) e
--   gravado congelado — mudar o preço de um modelo amanhã nunca recalcula
--   registros antigos. `pricing_version` identifica qual tabela gerou aquele
--   valor, para auditoria futura.
--
--   conversa_id/unidade_id usam ON DELETE SET NULL (não CASCADE, ao
--   contrário de agente_conversas): esta é uma tabela de MÉTRICA/CUSTO —
--   apagar uma conversa ou reorganizar uma unidade não deve apagar o
--   histórico de custo já incorrido, só perder aquela referência específica.
--
-- PRÉ-REQUISITOS: migrations 014, 015, 016, 020, 030, 048 aplicadas.
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

create table if not exists agente_uso (
  id uuid primary key default gen_random_uuid(),

  conversa_id uuid references agente_conversas(id) on delete set null,
  usuario_id uuid references perfis(id) on delete set null,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid references unidades(id) on delete set null,

  provider text not null default 'anthropic',
  model text not null,
  pricing_version text not null,

  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_creation_tokens int not null default 0,
  cache_read_tokens int not null default 0,

  -- Precisão de 6 casas decimais — nunca arredondar aqui (a UI arredonda pra
  -- exibir). null = modelo sem preço configurado em agente.pricing.js (nunca
  -- inventa 0, que pareceria "grátis de verdade").
  estimated_cost_usd numeric(12,6),

  tool_calls_count int not null default 0,
  tools_used jsonb not null default '[]'::jsonb,

  duration_ms int not null,
  success boolean not null,
  error_code text, -- código curto (ex.: status HTTP), nunca mensagem/stack

  created_at timestamptz not null default now()
);

-- organizacao_id + created_at é a combinação mais consultada (resumo mensal
-- por empresa); created_at sozinho cobre o resumo geral da plataforma.
create index if not exists idx_agente_uso_organizacao_data on agente_uso(organizacao_id, created_at);
create index if not exists idx_agente_uso_data on agente_uso(created_at);
create index if not exists idx_agente_uso_model on agente_uso(model, created_at);
create index if not exists idx_agente_uso_conversa on agente_uso(conversa_id);

-- ---------------------------------------------------------------------
-- RLS — mesmo padrão da migration 048 (backend usa service_role e ignora
-- RLS; só vale para eventual acesso direto autenticado).
-- ---------------------------------------------------------------------
alter table agente_uso enable row level security;
drop policy if exists rls_agente_uso_tenant on agente_uso;
create policy rls_agente_uso_tenant on agente_uso
  for all to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin())
  with check (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());

-- ---------------------------------------------------------------------
-- VERIFICAÇÃO (rode separadamente para conferir)
-- ---------------------------------------------------------------------
--   select table_name from information_schema.tables where table_name = 'agente_uso';
--   -- Esperado: 1 linha.
-- =====================================================================
-- FIM
-- =====================================================================
