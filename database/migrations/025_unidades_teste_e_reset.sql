-- =====================================================================
-- MIGRATION 025 — Unidades de teste do Dashboard iFood + reset de dia
-- =====================================================================
-- OBJETIVO
--   Criar 3 unidades PERMANENTES de desenvolvimento/teste (Loja
--   Florianópolis-SC 1/2/3), vinculadas ao usuário projetospeu@gmail.com
--   junto com a Subway Saci (preservando o acesso que ele já tem), pra
--   testar manualmente o fluxo do Dashboard iFood sem tocar em dado real.
--
--   Também cria a estrutura pro "reset de dia" — uma exclusão física de
--   lançamento que só pode acontecer em unidade marcada como teste
--   (unidades.eh_teste = true). Nunca em unidade real. Essa checagem é
--   feita no BACKEND a cada chamada (dashboardExecutivo.service.js), não
--   só aqui — esta migration só cria a coluna e a tabela de log.
--
--   NADA é alterado na Subway Saci: nenhum lançamento, configuração,
--   modelo logístico ou vínculo existente é tocado — só adiciona.
--
-- IDEMPOTENTE: pode ser reexecutada com segurança (nem duplica unidade,
--   nem duplica vínculo).
-- PRÉ-REQUISITO: migrations 023 e 024 aplicadas.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. COLUNA `eh_teste` EM `unidades`
--    Default false: nenhuma unidade existente (inclusive Subway Saci)
--    vira "de teste" por acidente.
-- ---------------------------------------------------------------------
alter table unidades add column if not exists eh_teste boolean not null default false;
create index if not exists idx_unidades_eh_teste on unidades(eh_teste) where eh_teste;

-- ---------------------------------------------------------------------
-- 2. 3 UNIDADES DE TESTE — idempotente (só insere quem ainda não existe,
--    casando por nome dentro da mesma organização da Subway Saci).
--    Ficam vazias de propósito: nenhum lançamento é criado aqui.
-- ---------------------------------------------------------------------
insert into unidades (organizacao_id, nome, eh_teste, modelo_logistico_ifood)
select '00000000-0000-0000-0000-000000000001'::uuid, v.nome, true, v.modelo::modelo_logistico_ifood_enum
from (values
  ('Loja Florianópolis-SC 1', 'marketplace'),
  ('Loja Florianópolis-SC 2', 'full_service'),
  ('Loja Florianópolis-SC 3', 'marketplace')
) as v(nome, modelo)
where not exists (
  select 1 from unidades u
  where u.organizacao_id = '00000000-0000-0000-0000-000000000001'::uuid and u.nome = v.nome
);

-- ---------------------------------------------------------------------
-- 3. VÍNCULO DO USUÁRIO com as 3 unidades de teste + a Subway Saci.
--
--    Por que a Subway Saci também entra aqui, mesmo sem mudar nada nela:
--    hoje o usuário só tem vínculo de EMPRESA (usuarios_organizacoes),
--    sem nenhuma linha em usuarios_unidades — e é isso que faz a tela de
--    seleção mostrar 1 única opção "acesso a toda a organização"
--    (sessao.service.js:listarAcessos). No momento em que QUALQUER
--    usuarios_unidades existir pra ele nesta organização, essa opção de
--    "empresa toda" desaparece e vira uma opção por unidade vinculada.
--    Sem incluir a Subway Saci aqui, ele perderia o acesso a ela na
--    prática (ela some da lista, mesmo o vínculo de empresa continuando
--    intacto por baixo).
--
--    papel = null em todas: herda organization_admin do vínculo de
--    empresa que ele já tem — nenhuma permissão é restringida.
-- ---------------------------------------------------------------------
do $$
declare
  v_usuario_id uuid;
  v_subway_saci_id uuid := '00000000-0000-0000-0000-0000000000a1';
begin
  select id into v_usuario_id from auth.users where email = 'projetospeu@gmail.com';

  if v_usuario_id is not null then
    insert into usuarios_unidades (usuario_id, unidade_id, papel)
    select v_usuario_id, u.id, null
    from unidades u
    where u.id = v_subway_saci_id
       or (u.organizacao_id = '00000000-0000-0000-0000-000000000001'::uuid
           and u.nome in ('Loja Florianópolis-SC 1', 'Loja Florianópolis-SC 2', 'Loja Florianópolis-SC 3'))
    on conflict (usuario_id, unidade_id) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. LOG DO RESET DE TESTE — rastreabilidade mínima (não é a auditoria
--    financeira real; essa continua intacta e nunca é tocada pelo reset).
-- ---------------------------------------------------------------------
create table if not exists dashboard_teste_reset_log (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,
  usuario_email text,
  data_inicial_reset date not null,
  lancamentos_removidos jsonb not null,  -- [{id, data}], snapshot de antes de apagar
  created_at timestamptz not null default now()
);
create index if not exists idx_dtrl_unidade on dashboard_teste_reset_log(unidade_id, created_at desc);
create index if not exists idx_dtrl_org on dashboard_teste_reset_log(organizacao_id);

alter table dashboard_teste_reset_log enable row level security;
drop policy if exists rls_dtrl_tenant on dashboard_teste_reset_log;
create policy rls_dtrl_tenant on dashboard_teste_reset_log
  for select to authenticated
  using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin());

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente):
--   select id, nome, eh_teste, modelo_logistico_ifood from unidades
--   where organizacao_id = '00000000-0000-0000-0000-000000000001' order by nome;
--
--   select u.nome, uu.papel from usuarios_unidades uu
--   join unidades u on u.id = uu.unidade_id
--   join auth.users au on au.id = uu.usuario_id
--   where au.email = 'projetospeu@gmail.com' order by u.nome;
-- =====================================================================
