-- =====================================================================
-- MIGRATION 020 — Painel SuperAdmin + arquitetura de acesso multiempresa
-- =====================================================================
-- OBJETIVO (Fase 3 — o sistema passa a ser um SaaS de fato)
--   1. Dar às ORGANIZAÇÕES os atributos comerciais de uma "empresa cliente"
--      (logo, responsável, contato, plano, status, período de teste).
--   2. Criar a estrutura FINANCEIRA do SaaS (planos, assinaturas, cobranças) —
--      já modelada, mesmo que a cobrança automática venha depois.
--   3. Criar AUDITORIA imutável da plataforma (append-only de verdade: um
--      trigger recusa UPDATE/DELETE, inclusive para o service_role).
--   4. Criar CONFIGURAÇÕES GLOBAIS do SaaS (chave/valor, com marcação de
--      segredo para nunca devolver o valor ao frontend).
--   5. Criar SESSÕES DE CONTEXTO — a tabela que dá lastro ao Context Token
--      assinado: sem uma linha viva aqui, o token não vale nada. É o que
--      permite "trocar unidade" (invalida e reemite), "forçar logout" e
--      "usuários online".
--   6. Desacoplar o LOGIN da empresa: `perfis` passa a ser apenas IDENTIDADE
--      (nome/email/ativo/senha_provisoria); o acesso vem exclusivamente de
--      usuarios_organizacoes.
--
-- ESCOPO: ESTA MIGRATION É SÓ SCHEMA. Ela não concede papéis, não cria contas
--   e não apaga vínculo nenhum.
--
--   Por quê: criar uma conta de login exige o Supabase Auth (hash de senha,
--   tabela de identidades), o que SQL puro não faz de forma segura — inserir
--   direto em auth.users é frágil e desencorajado. Então a "virada de acessos"
--   (criar o SuperAdmin, ajustar e-mails e zerar os vínculos antigos) vive em
--   `backend/scripts/virada-superadmin.js`, que usa a Admin API.
--
--   O ganho colateral é importante: esta migration passa a ser 100% reexecutável
--   sem qualquer risco de apagar dado.
--
-- PRÉ-REQUISITOS: migrations 014, 015 e 016 aplicadas.
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
--            Depois rode, no terminal: npm --prefix backend run virada:superadmin
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'status_organizacao') then
    create type status_organizacao as enum (
      'ativa',      -- operando normalmente
      'teste',      -- período de avaliação (trial_expira_em)
      'bloqueada',  -- acesso negado (ex: inadimplência)
      'suspensa',   -- pausada temporariamente a pedido do cliente
      'cancelada'   -- encerrada; dados preservados para eventual retomada
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'status_assinatura') then
    create type status_assinatura as enum ('trial', 'ativa', 'inadimplente', 'cancelada');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'ciclo_cobranca') then
    create type ciclo_cobranca as enum ('mensal', 'anual');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'status_cobranca') then
    create type status_cobranca as enum ('pendente', 'paga', 'vencida', 'cancelada', 'estornada');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. PLANOS DO SAAS
--    Criados antes de organizacoes.plano_id por causa da FK.
-- ---------------------------------------------------------------------
create table if not exists planos (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique,              -- 'free', 'essencial', 'pro'...
  nome text not null,
  descricao text,
  preco_mensal numeric(12,2) not null default 0,
  preco_anual numeric(12,2) not null default 0,
  limite_unidades int,                      -- null = ilimitado
  limite_usuarios int,                      -- null = ilimitado
  recursos jsonb not null default '{}'::jsonb,  -- flags de features do plano
  ativo boolean not null default true,
  ordem int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_planos_upd on planos;
create trigger trg_planos_upd before update on planos
  for each row execute function set_updated_at();

-- Catálogo inicial. ON CONFLICT DO NOTHING preserva qualquer ajuste de preço
-- feito depois no painel — a migration não sobrescreve o que você editou.
insert into planos (codigo, nome, descricao, preco_mensal, preco_anual, limite_unidades, limite_usuarios, ordem)
values
  ('teste',     'Teste',     'Avaliação por tempo limitado.',                0.00,    0.00,    1, 3,    0),
  ('essencial', 'Essencial', 'Uma unidade, CMV e vendas.',                 197.00, 1970.00,   1, 5,    1),
  ('pro',       'Pro',       'Multiunidade, integrações e relatórios.',    397.00, 3970.00,   5, 20,   2),
  ('enterprise','Enterprise','Sem limites, com suporte dedicado.',         897.00, 8970.00, null, null, 3)
on conflict (codigo) do nothing;

-- ---------------------------------------------------------------------
-- 3. ORGANIZAÇÕES = EMPRESAS CLIENTES (atributos comerciais)
--    Aditivo: nenhuma coluna existente muda de tipo ou de nulidade.
-- ---------------------------------------------------------------------
alter table organizacoes add column if not exists logo_url text;
alter table organizacoes add column if not exists responsavel_nome text;
alter table organizacoes add column if not exists responsavel_email text;
alter table organizacoes add column if not exists telefone text;
alter table organizacoes add column if not exists status status_organizacao not null default 'ativa';
alter table organizacoes add column if not exists trial_expira_em timestamptz;
alter table organizacoes add column if not exists plano_id uuid references planos(id) on delete set null;
alter table organizacoes add column if not exists observacoes text;

create index if not exists idx_organizacoes_status on organizacoes(status);
create index if not exists idx_organizacoes_plano on organizacoes(plano_id);

-- `ativo` (booleano legado) e `status` precisam contar a mesma história.
-- Alinha o que já existe: empresa inativa vira 'bloqueada'.
update organizacoes set status = 'bloqueada' where ativo = false and status = 'ativa';

-- ---------------------------------------------------------------------
-- 4. ASSINATURAS E COBRANÇAS
--    Modeladas por inteiro agora; a integração com gateway entra depois
--    preenchendo `referencia_externa` e mudando `status`.
-- ---------------------------------------------------------------------
create table if not exists assinaturas (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  plano_id uuid not null references planos(id) on delete restrict,
  status status_assinatura not null default 'trial',
  ciclo ciclo_cobranca not null default 'mensal',
  valor numeric(12,2) not null default 0,     -- valor negociado (pode diferir do plano)
  inicio_em date not null default current_date,
  proxima_cobranca_em date,
  cancelado_em timestamptz,
  motivo_cancelamento text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Uma assinatura VIVA por empresa; históricas (canceladas) podem coexistir.
create unique index if not exists idx_assinaturas_org_viva
  on assinaturas(organizacao_id) where cancelado_em is null;
create index if not exists idx_assinaturas_status on assinaturas(status);

drop trigger if exists trg_assinaturas_upd on assinaturas;
create trigger trg_assinaturas_upd before update on assinaturas
  for each row execute function set_updated_at();

create table if not exists cobrancas (
  id uuid primary key default gen_random_uuid(),
  assinatura_id uuid references assinaturas(id) on delete set null,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  competencia date not null,                  -- mês de referência (dia 1)
  valor numeric(12,2) not null,
  status status_cobranca not null default 'pendente',
  vencimento date not null,
  pago_em timestamptz,
  metodo text,                                -- 'pix', 'boleto', 'cartao'...
  referencia_externa text,                    -- id no gateway
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organizacao_id, competencia)
);
create index if not exists idx_cobrancas_org on cobrancas(organizacao_id);
create index if not exists idx_cobrancas_status on cobrancas(status);
create index if not exists idx_cobrancas_vencimento on cobrancas(vencimento);

drop trigger if exists trg_cobrancas_upd on cobrancas;
create trigger trg_cobrancas_upd before update on cobrancas
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- 5. AUDITORIA DA PLATAFORMA — APPEND-ONLY DE VERDADE
--    O requisito é "esses registros nunca poderão ser apagados". RLS não
--    resolve: o backend usa service_role, que ignora policy. Um trigger,
--    não — ele roda para todo mundo. Por isso a imutabilidade mora aqui.
-- ---------------------------------------------------------------------
create table if not exists plataforma_auditoria (
  id uuid primary key default gen_random_uuid(),
  ator_id uuid,                        -- auth.users.id; sem FK para sobreviver à exclusão do usuário
  ator_email text,
  ator_tipo text not null default 'usuario',   -- 'usuario' | 'superadmin' | 'sistema'
  acao text not null,                  -- 'login', 'empresa.bloquear', 'usuario.senha_redefinida'...
  entidade text,                       -- 'organizacao', 'usuario', 'assinatura'...
  entidade_id text,
  organizacao_id uuid,                 -- idem: sem FK, o log sobrevive à empresa
  impersonado_por uuid,                -- superadmin que estava "entrando como empresa"
  detalhes jsonb not null default '{}'::jsonb,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_ator on plataforma_auditoria(ator_id);
create index if not exists idx_audit_org on plataforma_auditoria(organizacao_id);
create index if not exists idx_audit_acao on plataforma_auditoria(acao);
create index if not exists idx_audit_data on plataforma_auditoria(created_at desc);

create or replace function bloquear_alteracao_auditoria()
returns trigger language plpgsql as $$
begin
  raise exception
    'plataforma_auditoria é append-only: % não é permitido nesta tabela.', tg_op
    using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists trg_audit_sem_update on plataforma_auditoria;
create trigger trg_audit_sem_update before update on plataforma_auditoria
  for each row execute function bloquear_alteracao_auditoria();

drop trigger if exists trg_audit_sem_delete on plataforma_auditoria;
create trigger trg_audit_sem_delete before delete on plataforma_auditoria
  for each row execute function bloquear_alteracao_auditoria();

-- TRUNCATE não passa por trigger FOR EACH ROW — precisa do seu próprio.
drop trigger if exists trg_audit_sem_truncate on plataforma_auditoria;
create trigger trg_audit_sem_truncate before truncate on plataforma_auditoria
  for each statement execute function bloquear_alteracao_auditoria();

-- ---------------------------------------------------------------------
-- 6. CONFIGURAÇÕES GLOBAIS DO SAAS
--    `secreto` marca o que NUNCA volta para o frontend (SMTP, chaves de API).
--    A API devolve apenas "preenchido: true/false" para esses.
-- ---------------------------------------------------------------------
create table if not exists plataforma_config (
  chave text primary key,
  valor jsonb not null default 'null'::jsonb,
  secreto boolean not null default false,
  descricao text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

drop trigger if exists trg_pconfig_upd on plataforma_config;
create trigger trg_pconfig_upd before update on plataforma_config
  for each row execute function set_updated_at();

insert into plataforma_config (chave, valor, secreto, descricao) values
  ('saas.nome',            '"Crescer com Delivery"'::jsonb, false, 'Nome da plataforma'),
  ('saas.logo_url',        'null'::jsonb,                   false, 'Logo da plataforma'),
  ('saas.versao',          '"0.1.0"'::jsonb,                false, 'Versão publicada'),
  ('saas.modo_manutencao', 'false'::jsonb,                  false, 'Bloqueia o acesso dos tenants'),
  ('saas.politica_url',    'null'::jsonb,                   false, 'URL da política de privacidade'),
  ('smtp.host',            'null'::jsonb,                   false, 'Servidor SMTP'),
  ('smtp.porta',           '587'::jsonb,                    false, 'Porta SMTP'),
  ('smtp.usuario',         'null'::jsonb,                   false, 'Usuário SMTP'),
  ('smtp.senha',           'null'::jsonb,                   true,  'Senha SMTP'),
  ('api.openai_key',       'null'::jsonb,                   true,  'Chave da OpenAI'),
  ('api.claude_key',       'null'::jsonb,                   true,  'Chave da Anthropic'),
  ('api.cloudflare_token', 'null'::jsonb,                   true,  'Token da Cloudflare'),
  ('backup.frequencia',    '"diario"'::jsonb,               false, 'Frequência do backup'),
  ('backup.retencao_dias', '30'::jsonb,                     false, 'Retenção do backup em dias')
on conflict (chave) do nothing;

-- ---------------------------------------------------------------------
-- 7. SESSÕES DE CONTEXTO — o lastro do Context Token
--    O token assinado carrega apenas o `sid`; TODO o poder (empresa, papel,
--    permissões) é relido daqui a cada requisição. Consequências:
--      * revogar = update numa linha (logout forçado é imediato);
--      * trocar de unidade = revoga a anterior e cria outra;
--      * um token roubado morre junto com a linha;
--      * "usuários online" = sessões vivas e usadas nos últimos minutos.
-- ---------------------------------------------------------------------
create table if not exists sessoes_contexto (
  id uuid primary key default gen_random_uuid(),   -- este é o `sid` do token
  usuario_id uuid not null references auth.users(id) on delete cascade,
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid references unidades(id) on delete set null,
  papel papel_acesso not null,
  permissoes jsonb not null default '[]'::jsonb,
  -- Preenchido quando é um superadmin usando "Entrar como empresa".
  impersonado_por uuid references auth.users(id) on delete set null,
  ip text,
  user_agent text,
  criada_em timestamptz not null default now(),
  ultimo_uso_em timestamptz not null default now(),
  expira_em timestamptz not null,
  revogada_em timestamptz,
  motivo_revogacao text
);
create index if not exists idx_sessoes_usuario on sessoes_contexto(usuario_id);
create index if not exists idx_sessoes_org on sessoes_contexto(organizacao_id);
-- Índice usado pelo "usuários online" e pela limpeza de sessões vencidas.
create index if not exists idx_sessoes_vivas on sessoes_contexto(ultimo_uso_em desc)
  where revogada_em is null;

-- ---------------------------------------------------------------------
-- 8. `perfis` VIRA IDENTIDADE, NÃO VÍNCULO
--    O login pertence ao usuário; a empresa vem de usuarios_organizacoes.
--    Manter as colunas (agora opcionais) evita quebrar qualquer consulta
--    antiga, mas nada no novo fluxo as lê para decidir acesso.
-- ---------------------------------------------------------------------
alter table perfis alter column organizacao_id drop not null;

-- Senha provisória: quando true, o usuário DEVE definir uma nova senha antes de
-- usar qualquer coisa do sistema. O backend bloqueia a API inteira (menos /me e
-- a própria troca de senha) enquanto a flag estiver ligada — sem isso o "troque
-- a senha" seria só uma sugestão que o usuário poderia ignorar chamando a API
-- direto.
alter table perfis add column if not exists senha_provisoria boolean not null default false;
create index if not exists idx_perfis_senha_provisoria on perfis(id) where senha_provisoria;

comment on column perfis.organizacao_id is
  'LEGADO — não use para autorização. O acesso vem de usuarios_organizacoes. Mantida apenas por compatibilidade histórica.';
comment on column perfis.papel is
  'LEGADO — o papel efetivo é o de usuarios_organizacoes.papel (por empresa).';
comment on column perfis.senha_provisoria is
  'true = senha definida por um administrador. O usuário precisa trocá-la no próximo login; a API fica bloqueada até então.';

-- ---------------------------------------------------------------------
-- 9. RLS DAS TABELAS NOVAS
--    Coerente com a 016: o caminho `authenticated` (chave anon) é o que estas
--    policies governam; o backend usa service_role e não é afetado.
--    `anon` fica em deny-all (nenhuma policy o contempla).
-- ---------------------------------------------------------------------

-- Catálogo de planos: leitura para qualquer autenticado (é vitrine); escrita
-- somente superadmin.
alter table planos enable row level security;
drop policy if exists rls_planos_leitura on planos;
create policy rls_planos_leitura on planos
  for select to authenticated using (ativo or is_platform_superadmin());
drop policy if exists rls_planos_escrita on planos;
create policy rls_planos_escrita on planos
  for all to authenticated
  using (is_platform_superadmin()) with check (is_platform_superadmin());

-- Financeiro: a empresa vê o próprio; o superadmin vê tudo.
alter table assinaturas enable row level security;
drop policy if exists rls_assinaturas_tenant on assinaturas;
create policy rls_assinaturas_tenant on assinaturas
  for all to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin())
  with check (is_platform_superadmin());

alter table cobrancas enable row level security;
drop policy if exists rls_cobrancas_tenant on cobrancas;
create policy rls_cobrancas_tenant on cobrancas
  for all to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin())
  with check (is_platform_superadmin());

-- Auditoria: só superadmin lê. Ninguém altera (o trigger da seção 5 garante).
alter table plataforma_auditoria enable row level security;
drop policy if exists rls_auditoria_superadmin on plataforma_auditoria;
create policy rls_auditoria_superadmin on plataforma_auditoria
  for select to authenticated using (is_platform_superadmin());

-- Configurações globais e sessões: superadmin apenas.
alter table plataforma_config enable row level security;
drop policy if exists rls_pconfig_superadmin on plataforma_config;
create policy rls_pconfig_superadmin on plataforma_config
  for all to authenticated
  using (is_platform_superadmin()) with check (is_platform_superadmin());

alter table sessoes_contexto enable row level security;
drop policy if exists rls_sessoes_proprias on sessoes_contexto;
create policy rls_sessoes_proprias on sessoes_contexto
  for select to authenticated
  using (usuario_id = auth.uid() or is_platform_superadmin());

-- ---------------------------------------------------------------------
-- PRÓXIMO PASSO — VIRADA DE ACESSOS
-- ---------------------------------------------------------------------
-- Este arquivo criou/atualizou o schema. Criar a conta do SuperAdmin e zerar
-- os vínculos antigos é feito pelo script:
--
--     npm --prefix backend run virada:superadmin
--
-- Ele usa a Admin API do Supabase (não dá para criar login pelo SQL Editor
-- com segurança), é idempotente, e é auditado em `plataforma_auditoria`.
--
-- VERIFICAÇÃO depois de aplicar E de rodar a virada:
--   -- SuperAdmin (deve retornar 1 linha):
--   select u.email as email_login, p.email as email_cadastro
--     from plataforma_admins pa
--     join auth.users u on u.id = pa.usuario_id
--     left join perfis p on p.id = pa.usuario_id
--    where pa.ativo;
--   -- Vínculos zerados (deve retornar 0):
--   select count(*) from usuarios_organizacoes;
--   -- A Subway Saci deve continuar aqui:
--   select nome, status from organizacoes;
--   -- A auditoria deve recusar isto (erro esperado — trigger de imutabilidade):
--   delete from plataforma_auditoria;
-- =====================================================================
-- FIM
-- =====================================================================

