-- =====================================================================
-- MIGRATION 048 — Agente Crescer: histórico conversacional (Fase 1.5)
-- =====================================================================
-- OBJETIVO
--   Contexto conversacional real do Agente Crescer: cada conversa é uma
--   linha em `agente_conversas`, e cada turno (usuário ou agente) uma linha
--   em `agente_mensagens`. Só o TEXTO FINAL de cada turno é persistido —
--   nunca os blocos brutos de tool_use/tool_result da Anthropic (ficam só
--   na memória da requisição, ver agente.service.js) — mantém o histórico
--   enxuto e barato de reenviar.
--
--   Memória CURTA e desta conversa só: nada de embeddings, vector DB, RAG,
--   resumo semântico ou memória entre empresas — é literalmente "as últimas
--   N mensagens desta conversa", igual ao pedido da Fase 1.5.
--
-- ISOLAMENTO (crítico)
--   Uma conversa pertence a usuario_id + organizacao_id + unidade_id
--   JUNTOS. Nenhuma leitura busca só pelo id — sempre os 3 campos batendo
--   (ver agente.conversas.service.js#buscarConversa). Um conversationId de
--   outro tenant, mesmo que descoberto/adivinhado, nunca é reutilizável: a
--   consulta simplesmente não encontra nada, sem distinguir "não existe" de
--   "existe mas é de outro tenant" (nenhuma pista pro cliente).
--
-- PRÉ-REQUISITOS: migrations 014, 015, 016, 020, 030 aplicadas
--   (auth_organizacao_ids(), is_platform_superadmin()).
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. CONVERSAS
-- ---------------------------------------------------------------------
create table if not exists agente_conversas (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references perfis(id) on delete set null,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid references unidades(id) on delete cascade, -- null = visão "todas as unidades"
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
-- Índice composto pela MESMA combinação que toda leitura usa para validar
-- tenant (ver ISOLAMENTO acima) — cobre o caso unidade_id is null também
-- (índice parcial não é necessário: null participa normalmente do índice).
create index if not exists idx_agente_conversas_escopo on agente_conversas(usuario_id, organizacao_id, unidade_id);
create index if not exists idx_agente_conversas_org on agente_conversas(organizacao_id);

create or replace function agente_conversas_set_atualizado_em() returns trigger as $f$
begin
  new.atualizado_em = now();
  return new;
end;
$f$ language plpgsql;

drop trigger if exists trg_agente_conversas_atualizado_em on agente_conversas;
create trigger trg_agente_conversas_atualizado_em before update on agente_conversas
  for each row execute function agente_conversas_set_atualizado_em();

-- ---------------------------------------------------------------------
-- 2. MENSAGENS — só o texto final de cada turno (nunca tool_use/tool_result brutos).
-- ---------------------------------------------------------------------
create table if not exists agente_mensagens (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid not null references agente_conversas(id) on delete cascade,
  papel text not null check (papel in ('user', 'assistant')), -- mesmo vocabulário da Messages API (sem tradução na hora de montar o contexto)
  conteudo text not null,
  tools_utilizadas jsonb not null default '[]'::jsonb,        -- só em mensagens 'assistant' — alimenta o "Consultou: ..." no frontend, mesmo após reload
  criado_em timestamptz not null default now()
);
create index if not exists idx_agente_mensagens_conversa on agente_mensagens(conversa_id, criado_em);

-- ---------------------------------------------------------------------
-- 3. RLS — mesmo padrão da migration 037 (backend usa service_role e
--    ignora RLS; estas policies só valem para eventual acesso direto
--    autenticado). Escopo por ORGANIZAÇÃO (não por unidade): unidade_id
--    pode ser null (visão agregada), e auth_organizacao_ids() já cobre
--    isso sem precisar de um helper "auth_unidade_ids() ou null" à parte.
-- ---------------------------------------------------------------------
alter table agente_conversas enable row level security;
drop policy if exists rls_agente_conversas_tenant on agente_conversas;
create policy rls_agente_conversas_tenant on agente_conversas
  for all to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin())
  with check (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());

alter table agente_mensagens enable row level security;
drop policy if exists rls_agente_mensagens_tenant on agente_mensagens;
create policy rls_agente_mensagens_tenant on agente_mensagens
  for all to authenticated
  using (
    conversa_id in (
      select id from agente_conversas
      where organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin()
    )
  )
  with check (
    conversa_id in (
      select id from agente_conversas
      where organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin()
    )
  );

-- ---------------------------------------------------------------------
-- 4. VERIFICAÇÃO (rode separadamente para conferir)
-- ---------------------------------------------------------------------
--   select table_name from information_schema.tables
--    where table_name in ('agente_conversas', 'agente_mensagens');
--   -- Esperado: 2 linhas.
-- =====================================================================
-- FIM
-- =====================================================================
