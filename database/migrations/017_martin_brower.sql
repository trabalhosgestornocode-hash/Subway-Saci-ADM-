-- =====================================================================
-- MIGRATION 017 — Integração Martin Brower
-- =====================================================================
-- OBJETIVO
--   Estruturas para importar o catálogo oficial da distribuidora Martin
--   Brower por unidade (loja), manter histórico de preços por código
--   oficial e auditar cada sincronização.
--
-- HIERARQUIA DO TENANT (reutiliza o modelo existente, nada novo é criado):
--   organizacao_id (organizacoes)  -> empresa dentro do SaaS
--     -> unidade_id (unidades)     -> loja física
--       -> client_id               -> a MESMA loja no portal Martin Brower
--         -> order_id              -> pedido corrente (findProxPedidoV2)
--           -> produtos e preços   -> catálogo (loadItens)
--
-- CHAVE DE IDENTIFICAÇÃO DO PRODUTO:
--   organizacao_id + unidade_id + client_id + codigo
--   O `codigo` é o código oficial Martin Brower (ex: '1001088'), guardado
--   como TEXT para preservar zeros à esquerda. NUNCA identificar produto
--   pela descrição.
--
-- SEGREDOS: nenhuma tabela aqui guarda senha, JWT, cookie de sessão ou
--   código 2FA. A política da integração é "credenciais efêmeras, mantidas
--   exclusivamente em memória do processo e descartadas ao final de cada
--   sincronização". Sessões e locks do worker também vivem em memória.
--
-- PRÉ-REQUISITOS: schema.sql (organizacoes, unidades, insumos) e migrations
--   014/015/016 (helpers auth_organizacao_ids, auth_unidade_ids,
--   is_platform_superadmin). Se a 015/016 ainda não rodou, o bloco de RLS
--   no fim é pulado com aviso, e as tabelas ficam com RLS habilitado em
--   deny-all — seguro por padrão.
--
-- IMPACTO NO APP: nenhum no que já existe. O backend usa service_role
--   (ignora RLS); o isolamento efetivo é imposto na camada de aplicação,
--   filtrando organizacao_id + unidade_id em TODA query do repositório.
--
-- IDEMPOTENTE: create table if not exists / drop policy if exists.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. TRIGGER DE atualizado_em (compartilhado pelas tabelas desta migration)
-- ---------------------------------------------------------------------
create or replace function mb_touch_atualizado_em()
returns trigger language plpgsql as $$
begin
  new.atualizado_em = now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 1. CONFIGURAÇÃO DA INTEGRAÇÃO (uma linha por unidade x clientId)
-- ---------------------------------------------------------------------
create table if not exists martin_brower_integracoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  client_id bigint not null,              -- identificador da loja no portal MB
  unidade_nome text,                      -- rótulo da unidade no portal (informativo)
  ativo boolean not null default true,
  status text not null default 'nao_configurado',
  ultimo_order_id bigint,
  ultima_sincronizacao timestamptz,
  ultimo_erro text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (organizacao_id, unidade_id, client_id)
);
-- Uma unidade tem no máximo UMA integração ativa — evita catálogo ambíguo.
create unique index if not exists uq_mb_integracao_unidade_ativa
  on martin_brower_integracoes(unidade_id) where ativo;
create index if not exists idx_mb_integracoes_org on martin_brower_integracoes(organizacao_id);

drop trigger if exists trg_mb_integracoes_upd on martin_brower_integracoes;
create trigger trg_mb_integracoes_upd before update on martin_brower_integracoes
  for each row execute function mb_touch_atualizado_em();

-- ---------------------------------------------------------------------
-- 2. SINCRONIZAÇÕES (auditoria de cada execução)
-- ---------------------------------------------------------------------
create table if not exists martin_brower_sincronizacoes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  client_id bigint,
  order_id bigint,
  origem text not null default 'worker',  -- 'worker' | 'importacao_manual'
  status text not null default 'aguardando',
  etapa_atual text,
  produtos_encontrados integer not null default 0,
  produtos_validos integer not null default 0,
  produtos_ignorados integer not null default 0,
  produtos_criados integer not null default 0,
  produtos_atualizados integer not null default 0,
  precos_alterados integer not null default 0,
  produtos_com_erro integer not null default 0,
  financial_restriction text,
  janela_inicio timestamptz,
  janela_final timestamptz,
  erro_codigo text,
  erro_mensagem text,
  iniciado_em timestamptz not null default now(),
  finalizado_em timestamptz,
  criado_por uuid references perfis(id) on delete set null
);
create index if not exists idx_mb_sync_unidade on martin_brower_sincronizacoes(unidade_id, iniciado_em desc);
create index if not exists idx_mb_sync_org on martin_brower_sincronizacoes(organizacao_id, iniciado_em desc);

-- Status possíveis (validados na aplicação, não por enum, para evoluir sem migration):
--   aguardando | autenticando | aguardando_codigo | identificando_unidade
--   identificando_pedido | coletando | normalizando | sincronizando
--   concluido | erro | cancelado | expirado

-- ---------------------------------------------------------------------
-- 3. PRODUTOS DO CATÁLOGO MARTIN BROWER
-- ---------------------------------------------------------------------
create table if not exists martin_brower_produtos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  client_id bigint not null,
  order_id bigint,                        -- pedido em que o item foi visto por último
  client_product_id bigint,               -- appClientProduct.id
  product_id bigint,                      -- appClientProduct.product.id
  codigo text not null,                   -- product.code — CHAVE OFICIAL
  codigo_interno text,                    -- product.ncode
  descricao text not null,
  preco numeric(12,2),
  peso numeric(12,3),                     -- product.weight — BRUTO, não usar p/ custo/kg
  volume numeric(12,3),
  unidade text,                           -- 'CX'
  unidade_descricao text,                 -- 'CAIXA'
  familia text,                           -- 'CON'
  familia_descricao text,                 -- 'Congelados'
  grupo_id bigint,
  grupo_descricao text,
  multiplo numeric(12,3),
  quantidade_media numeric(12,3),
  quantidade_pedido numeric(12,3),
  status_item_id bigint,
  tipo_produto text,                      -- appClientProduct.type ('W'...)
  ativo boolean not null default true,
  visto_na_ultima_sincronizacao boolean not null default true,
  ignorado boolean not null default false,
  motivo_ignorado text,
  regra_ignorado text,                    -- qual regra classificou (auditável/reversível)
  classificacao_manual boolean not null default false, -- admin sobrepôs o filtro
  primeira_sincronizacao timestamptz not null default now(),
  ultima_sincronizacao timestamptz not null default now(),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (organizacao_id, unidade_id, client_id, codigo)
);
create index if not exists idx_mb_prod_unidade on martin_brower_produtos(unidade_id, client_id);
create index if not exists idx_mb_prod_codigo on martin_brower_produtos(organizacao_id, codigo);
create index if not exists idx_mb_prod_grupo on martin_brower_produtos(unidade_id, grupo_descricao);
create index if not exists idx_mb_prod_ignorado on martin_brower_produtos(unidade_id, ignorado);

drop trigger if exists trg_mb_produtos_upd on martin_brower_produtos;
create trigger trg_mb_produtos_upd before update on martin_brower_produtos
  for each row execute function mb_touch_atualizado_em();

-- ---------------------------------------------------------------------
-- 4. HISTÓRICO DE PREÇOS (só grava quando o preço MUDA de verdade)
-- ---------------------------------------------------------------------
create table if not exists martin_brower_precos_historico (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  produto_id uuid not null references martin_brower_produtos(id) on delete cascade,
  client_id bigint not null,
  codigo text not null,
  preco_anterior numeric(12,2),
  preco_novo numeric(12,2),
  alteracao_valor numeric(12,2),
  alteracao_percentual numeric(12,4),
  coletado_em timestamptz not null default now(),
  sincronizacao_id uuid references martin_brower_sincronizacoes(id) on delete set null,
  criado_em timestamptz not null default now()
);
create index if not exists idx_mb_hist_produto on martin_brower_precos_historico(produto_id, coletado_em desc);
create index if not exists idx_mb_hist_unidade on martin_brower_precos_historico(unidade_id, coletado_em desc);
create index if not exists idx_mb_hist_sync on martin_brower_precos_historico(sincronizacao_id);

-- ---------------------------------------------------------------------
-- 5. REGRAS DE FILTRO (itens fora do escopo operacional — seção 8)
-- ---------------------------------------------------------------------
-- Regras configuráveis pelo administrador. As regras PADRÃO da plataforma
-- (uniformes/vestuário) ficam no código (martinbrower.filtros.js); esta
-- tabela permite acrescentar/derrubar regras por organização ou unidade.
create table if not exists martin_brower_filtros (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid references unidades(id) on delete cascade,  -- null = vale p/ a org toda
  tipo text not null,                     -- 'codigo' | 'grupo' | 'familia' | 'descricao' | 'palavra_chave'
  valor text not null,
  acao text not null default 'ignorar',   -- 'ignorar' | 'incluir' (incluir sobrepõe regra padrão)
  motivo text,
  ativo boolean not null default true,
  criado_por uuid references perfis(id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (organizacao_id, unidade_id, tipo, valor)
);
create index if not exists idx_mb_filtros_org on martin_brower_filtros(organizacao_id, ativo);

drop trigger if exists trg_mb_filtros_upd on martin_brower_filtros;
create trigger trg_mb_filtros_upd before update on martin_brower_filtros
  for each row execute function mb_touch_atualizado_em();

-- ---------------------------------------------------------------------
-- 6. VÍNCULO COM INSUMOS INTERNOS (seção 16 — sempre CONFIRMADO por humano)
-- ---------------------------------------------------------------------
-- Prepara o caminho  produto MB -> insumo -> ficha_tecnica -> CMV.
-- Nesta fase NADA é vinculado automaticamente e nenhum custo é propagado:
-- o vínculo é criado apenas por confirmação manual do administrador.
create table if not exists martin_brower_vinculos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  mb_produto_id uuid not null references martin_brower_produtos(id) on delete cascade,
  insumo_id uuid not null references insumos(id) on delete cascade,
  origem text not null default 'manual',  -- 'manual' | 'sugerido_confirmado'
  observacao text,
  confirmado_por uuid references perfis(id) on delete set null,
  confirmado_em timestamptz not null default now(),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (mb_produto_id)
);
create index if not exists idx_mb_vinc_insumo on martin_brower_vinculos(insumo_id);
create index if not exists idx_mb_vinc_unidade on martin_brower_vinculos(unidade_id);

drop trigger if exists trg_mb_vinculos_upd on martin_brower_vinculos;
create trigger trg_mb_vinculos_upd before update on martin_brower_vinculos
  for each row execute function mb_touch_atualizado_em();

-- ---------------------------------------------------------------------
-- 7. RLS — mesmo padrão da migration 016 (isolamento por VÍNCULO)
-- ---------------------------------------------------------------------
-- Habilita RLS SEMPRE. Sem policy, o papel `authenticated` fica em deny-all
-- (seguro por padrão) e o backend segue funcionando via service_role.
do $$
declare
  t text;
  mb_tables text[] := array[
    'martin_brower_integracoes','martin_brower_sincronizacoes','martin_brower_produtos',
    'martin_brower_precos_historico','martin_brower_filtros','martin_brower_vinculos'
  ];
begin
  foreach t in array mb_tables loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

-- Policies só se os helpers da 015/016 existirem.
do $$
declare
  t text;
  -- tabelas com unidade_id NOT NULL: escopo por unidade + organização
  und_tables text[] := array[
    'martin_brower_integracoes','martin_brower_sincronizacoes','martin_brower_produtos',
    'martin_brower_precos_historico','martin_brower_vinculos'
  ];
begin
  if to_regproc('public.auth_unidade_ids') is null
     or to_regproc('public.auth_organizacao_ids') is null
     or to_regproc('public.is_platform_superadmin') is null then
    raise notice 'MB 017: helpers das migrations 015/016 ausentes — policies NAO criadas. Tabelas ficam em deny-all para authenticated (backend usa service_role e segue normal). Rode 015 e 016 e reexecute esta migration.';
    return;
  end if;

  foreach t in array und_tables loop
    execute format('drop policy if exists rls_%s_tenant on public.%I;', t, t);
    -- Exige AMBOS: vínculo com a organização E com a unidade. Isso impede
    -- acesso cruzado entre unidades da MESMA organização (regra 4 da spec).
    execute format($f$
      create policy rls_%s_tenant on public.%I
        for all to authenticated
        using (is_platform_superadmin() or (
          organizacao_id in (select auth_organizacao_ids())
          and unidade_id in (select auth_unidade_ids())))
        with check (is_platform_superadmin() or (
          organizacao_id in (select auth_organizacao_ids())
          and unidade_id in (select auth_unidade_ids())));
    $f$, t, t);
  end loop;

  -- martin_brower_filtros: unidade_id é NULLABLE (regra da organização inteira).
  drop policy if exists rls_martin_brower_filtros_tenant on public.martin_brower_filtros;
  create policy rls_martin_brower_filtros_tenant on public.martin_brower_filtros
    for all to authenticated
    using (is_platform_superadmin() or (
      organizacao_id in (select auth_organizacao_ids())
      and (unidade_id is null or unidade_id in (select auth_unidade_ids()))))
    with check (is_platform_superadmin() or (
      organizacao_id in (select auth_organizacao_ids())
      and (unidade_id is null or unidade_id in (select auth_unidade_ids()))));
end $$;

-- ---------------------------------------------------------------------
-- 8. VERIFICAÇÃO (rode separadamente)
--   select tablename, count(*) as policies from pg_policies
--   where schemaname='public' and tablename like 'martin_brower%'
--   group by tablename order by tablename;
--   -- Esperado: 6 tabelas, 1 policy rls_*_tenant cada.
--
--   -- Cadastrar a integração da Subway Saci (substitua pelos ids reais):
--   -- insert into martin_brower_integracoes (organizacao_id, unidade_id, client_id, unidade_nome, status)
--   -- select o.id, u.id, <CLIENT_ID>, u.nome, 'pronto'
--   --   from unidades u join organizacoes o on o.id = u.organizacao_id
--   --  where u.nome ilike '%saci%';
-- =====================================================================
-- FIM
-- =====================================================================
