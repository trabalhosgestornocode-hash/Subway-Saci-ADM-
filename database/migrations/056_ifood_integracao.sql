-- =====================================================================
-- MIGRATION 056 — Integração oficial iFood (Fase 1: conexão + OAuth + merchant)
-- =====================================================================
-- OBJETIVO
--   Fundação da integração oficial com o iFood. Esta fase trata SOMENTE de:
--     1. conexão da UNIDADE (não do usuário) com uma loja do iFood;
--     2. fluxo OAuth distribuído (Authorization Code com userCode/verifier);
--     3. descoberta das lojas autorizadas via Merchant API (read-only);
--     4. vínculo seguro merchant do iFood -> unidade do Crescer;
--     5. armazenamento CIFRADO das credenciais/tokens (backend-only);
--     6. status visual da integração.
--
--   NÃO cobre (fases futuras): Analytics, Financial Events, Sales,
--   Settlement, Reconciliation, sincronização de dados, escrita no Merchant.
--
-- DOIS APLICATIVOS DISTRIBUÍDOS (Portal do Desenvolvedor iFood):
--   * analytics — categoria BI / módulo Analytics (uso futuro);
--   * financial — categoria FINANCIAL / módulos Financial + Merchant.
--   Nesta fase só o módulo MERCHANT do app financial é consumido (listar/
--   detalhar lojas). Os dois apps PODEM ser autorizados; nenhum dado de
--   Analytics/Financial é lido ainda.
--
-- HIERARQUIA DO TENANT (reutiliza o modelo existente — nada novo):
--   organizacao_id (organizacoes) -> empresa no SaaS
--     -> unidade_id (unidades)    -> loja física do Crescer
--       -> merchant_id            -> a MESMA loja no iFood (Merchant API)
--         -> ifood_credenciais    -> tokens por app (analytics | financial)
--
-- SEGREDOS — política desta integração:
--   * clientId/clientSecret dos apps vêm SÓ de variável de ambiente
--     (IFOOD_ANALYTICS_* / IFOOD_FINANCIAL_*). NUNCA são gravados aqui.
--   * access_token / refresh_token / authorization_code_verifier são
--     gravados CIFRADOS (AES-256-GCM, chave IFOOD_TOKEN_SECRET) pela camada
--     backend/src/shared/cripto.js. O banco nunca vê o valor em claro.
--   * As colunas de token/verifier terminam em `_cifrado` para deixar
--     explícito que o conteúdo NÃO é texto plano.
--
-- MODELO DE MÓDULO: o módulo `ifood` JÁ existe no catálogo (`modulos`,
--   migration 030) e no menu do frontend — esta migration não cria módulo
--   novo nem concede acesso a ninguém. O SuperAdmin libera pela tela de
--   Acessos já existente.
--
-- PRÉ-REQUISITOS: schema.sql (organizacoes, unidades, perfis) e, para as
--   policies de RLS, os helpers das migrations 015/016
--   (auth_organizacao_ids, auth_unidade_ids, is_platform_superadmin). Se
--   015/016 ainda não rodaram, o bloco de policies é PULADO com aviso e as
--   tabelas ficam com RLS habilitado em deny-all — seguro por padrão. O
--   backend usa service_role (ignora RLS); o isolamento efetivo é imposto
--   na camada de aplicação (repository), filtrando organizacao_id +
--   unidade_id em TODA query.
--
-- IMPACTO NO APP: nenhum no que já existe. Três tabelas novas, um módulo já
--   catalogado. Nenhum dado existente é tocado.
--
-- IDEMPOTENTE: create table if not exists / create or replace / drop policy
--   if exists. Reexecutável com segurança.
--
-- ROLLBACK (lógico — rode no SQL Editor se precisar reverter TUDO):
--   drop table if exists ifood_credenciais    cascade;
--   drop table if exists ifood_oauth_sessoes  cascade;
--   drop table if exists ifood_conexoes       cascade;
--   drop function if exists ifood_touch_atualizado_em() cascade;
--   -- (o módulo `ifood` em `modulos` NÃO foi criado aqui — não remover)
--   Nenhum dado de outra tabela é afetado. Reverter é seguro enquanto a
--   Fase 2 (que passa a ler tokens) não estiver no ar.
--
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. TRIGGER de atualizado_em (compartilhado pelas tabelas desta migration)
--    Mesmo espírito de mb_touch_atualizado_em / parser_fd_set_atualizado_em:
--    schema em pt-BR, colunas criado_em / atualizado_em.
-- ---------------------------------------------------------------------
create or replace function ifood_touch_atualizado_em()
returns trigger language plpgsql as $$
begin
  new.atualizado_em = now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 1. CONEXÃO — o vínculo UNIDADE <-> loja do iFood (uma viva por unidade)
-- ---------------------------------------------------------------------
-- Nasce quando a PRIMEIRA autorização de app é concluída (status 'pendente',
-- ainda sem merchant). O passo "vincular merchant" preenche merchant_* e
-- promove para 'ativa'. Substituir a conexão de uma unidade não apaga a
-- linha antiga — marca status 'revogada' e cria outra (preserva histórico).
create table if not exists ifood_conexoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,

  -- Identificação da loja no iFood. NULL até o passo de vínculo do merchant.
  -- SEMPRE validado contra GET /merchants/{id} antes de gravar — nunca aceito
  -- cru do frontend.
  merchant_id text,
  merchant_nome text,
  merchant_razao_social text,

  -- 'pendente'   -> autorização de pelo menos um app concluída, sem merchant
  -- 'ativa'      -> merchant vinculado e validado
  -- 'revogada'   -> desconectada localmente (tokens descartados)
  -- 'reauth_required' -> algum refresh falhou; precisa reconectar
  status text not null default 'pendente'
    check (status in ('pendente', 'ativa', 'revogada', 'reauth_required')),

  conectada_em timestamptz,               -- quando o merchant foi vinculado
  ultima_sincronizacao_em timestamptz,    -- só coluna; nenhuma sync nesta fase
  ultimo_erro text,                       -- mensagem sanitizada do último problema

  criado_por uuid references perfis(id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- No máximo UMA conexão não-revogada por unidade (cobre os dois apps: as
-- credenciais analytics e financial penduram na MESMA conexão).
create unique index if not exists uq_ifood_conexao_unidade_viva
  on ifood_conexoes(unidade_id) where status <> 'revogada';

-- Um merchant do iFood não pode estar vinculado a duas unidades ao mesmo
-- tempo (impede vínculo duplicado incorreto).
create unique index if not exists uq_ifood_conexao_merchant_vivo
  on ifood_conexoes(merchant_id) where merchant_id is not null and status <> 'revogada';

create index if not exists idx_ifood_conexoes_org on ifood_conexoes(organizacao_id);
create index if not exists idx_ifood_conexoes_unidade on ifood_conexoes(unidade_id, status);

drop trigger if exists trg_ifood_conexoes_upd on ifood_conexoes;
create trigger trg_ifood_conexoes_upd before update on ifood_conexoes
  for each row execute function ifood_touch_atualizado_em();

-- ---------------------------------------------------------------------
-- 2. CREDENCIAIS — tokens por app, SEMPRE CIFRADOS, backend-only
-- ---------------------------------------------------------------------
-- clientSecret NUNCA entra aqui (vem de ENV). access/refresh token são
-- gravados já cifrados (AES-256-GCM) por shared/cripto.js.
create table if not exists ifood_credenciais (
  id uuid primary key default gen_random_uuid(),
  conexao_id uuid not null references ifood_conexoes(id) on delete cascade,

  app_type text not null check (app_type in ('analytics', 'financial')),

  access_token_cifrado text not null,
  refresh_token_cifrado text,             -- pode não vir na resposta do iFood
  expira_em timestamptz not null,         -- accessToken normalmente ~6h
  token_type text,                        -- geralmente 'bearer'

  -- 'ativa'           -> utilizável (renova sozinho quando perto de expirar)
  -- 'reauth_required' -> refresh falhou; o usuário precisa reconectar o app
  status text not null default 'ativa'
    check (status in ('ativa', 'reauth_required')),

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  unique (conexao_id, app_type)           -- 1 credencial por app por conexão
);

create index if not exists idx_ifood_cred_conexao on ifood_credenciais(conexao_id);

drop trigger if exists trg_ifood_cred_upd on ifood_credenciais;
create trigger trg_ifood_cred_upd before update on ifood_credenciais
  for each row execute function ifood_touch_atualizado_em();

-- ---------------------------------------------------------------------
-- 3. SESSÕES OAUTH — estado TEMPORÁRIO do fluxo de autorização distribuído
-- ---------------------------------------------------------------------
-- Guarda o par (userCode, authorizationCodeVerifier) enquanto o usuário
-- autoriza o app no Portal do Parceiro iFood. O verifier é gravado CIFRADO
-- e nunca volta ao frontend. Ao concluir (ou expirar/falhar) o fluxo, o
-- verifier é anulado (verifier_consumido_em) e a linha vira só histórico.
create table if not exists ifood_oauth_sessoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,

  app_type text not null check (app_type in ('analytics', 'financial')),

  user_code text not null,                              -- ex: 'HJLX-LPSQ' (exibido ao usuário)
  authorization_code_verifier_cifrado text,             -- anulado após o uso
  verification_url text,
  verification_url_complete text,

  expira_em timestamptz not null,                       -- ~10 min (userCode)
  -- 'pending'    -> aguardando o usuário concluir no portal do iFood
  -- 'authorized' -> troca por token concluída com sucesso
  -- 'expired'    -> userCode expirou antes de concluir
  -- 'failed'     -> a troca por token falhou
  status text not null default 'pending'
    check (status in ('pending', 'authorized', 'expired', 'failed')),
  verifier_consumido_em timestamptz,                    -- quando o verifier foi anulado

  criado_por uuid references perfis(id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create index if not exists idx_ifood_oauth_unidade on ifood_oauth_sessoes(unidade_id, status);
create index if not exists idx_ifood_oauth_expira on ifood_oauth_sessoes(expira_em) where status = 'pending';

drop trigger if exists trg_ifood_oauth_upd on ifood_oauth_sessoes;
create trigger trg_ifood_oauth_upd before update on ifood_oauth_sessoes
  for each row execute function ifood_touch_atualizado_em();

-- ---------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------
-- Habilita RLS SEMPRE nas três. Sem policy, o papel `authenticated` fica em
-- deny-all (seguro por padrão) e o backend segue funcionando via service_role.
alter table ifood_conexoes        enable row level security;
alter table ifood_credenciais     enable row level security;
alter table ifood_oauth_sessoes   enable row level security;

-- ifood_credenciais e ifood_oauth_sessoes: BACKEND-ONLY, sem exceção.
-- Guardam material sensível (tokens/verifier cifrados). NENHUMA policy para
-- `authenticated` é criada — deny-all é o comportamento desejado. O frontend
-- só recebe status sanitizado, servido pelo backend.

-- ifood_conexoes: só dados sanitizados (nome/razão do merchant, status).
-- Ganha policy de tenant no MESMO padrão da migration 017 — mas só se os
-- helpers 015/016 existirem.
do $$
begin
  if to_regproc('public.auth_unidade_ids') is null
     or to_regproc('public.auth_organizacao_ids') is null
     or to_regproc('public.is_platform_superadmin') is null then
    raise notice 'iFood 056: helpers das migrations 015/016 ausentes — policy de ifood_conexoes NAO criada. A tabela fica em deny-all para authenticated (backend usa service_role e segue normal). Rode 015 e 016 e reexecute esta migration.';
    return;
  end if;

  drop policy if exists rls_ifood_conexoes_tenant on public.ifood_conexoes;
  -- Exige AMBOS: vínculo com a organização E com a unidade (impede acesso
  -- cruzado entre unidades da mesma organização — regra do projeto).
  create policy rls_ifood_conexoes_tenant on public.ifood_conexoes
    for all to authenticated
    using (is_platform_superadmin() or (
      organizacao_id in (select auth_organizacao_ids())
      and unidade_id in (select auth_unidade_ids())))
    with check (is_platform_superadmin() or (
      organizacao_id in (select auth_organizacao_ids())
      and unidade_id in (select auth_unidade_ids())));
end $$;

-- ---------------------------------------------------------------------
-- 5. VERIFICAÇÃO (rode separadamente)
--   -- Tabelas e RLS:
--   select tablename, rowsecurity from pg_tables
--   where schemaname='public' and tablename like 'ifood_%';
--   -- Esperado: 3 tabelas, rowsecurity = true nas três.
--
--   -- Policies:
--   select tablename, policyname from pg_policies
--   where schemaname='public' and tablename like 'ifood_%';
--   -- Esperado: só rls_ifood_conexoes_tenant (as outras duas: deny-all).
-- =====================================================================
-- FIM
-- =====================================================================
