-- =====================================================================
-- MIGRATION 060 — Perfis operacionais (base da arquitetura multi-perfil)
-- =====================================================================
-- OBJETIVO (Fase B do projeto multi-perfil — ver docs/multi-perfil-fase-a-auditoria.md
--           e docs/multi-perfil-fase-a1-revisao.md)
--   Preparar o BANCO para "uma conta de acesso (e-mail+senha) com N perfis
--   operacionais (pessoas)". Esta migration é SÓ SCHEMA ADITIVO + BACKFILL.
--   Nenhuma lógica de aplicação muda nesta fase.
--
--   1. Nova tabela `perfis_operacionais` (a pessoa). `perfis` continua sendo
--      a CONTA (espelho 1:1 de auth.users) — NÃO é renomeada.
--   2. BACKFILL com UUID REAPROVEITADO: para cada `perfis` existente, cria
--      exatamente 1 `perfis_operacionais` com `id = perfis.id` e
--      `conta_id = perfis.id`. Assim TODO `usuario_id` já gravado em
--      `usuarios_organizacoes` / `usuarios_unidades` / `agente_conversas` /
--      `sessoes_contexto` já é, sem UPDATE nenhum, um `perfil_id` válido.
--   3. `perfil_id` NULLABLE em `usuarios_organizacoes`, `usuarios_unidades`,
--      `sessoes_contexto`, `agente_conversas` (+ FK e índices), backfill
--      `perfil_id = usuario_id`.
--   4. `plataforma_auditoria.perfil_id` — coluna nova, SEM FK, SEM backfill
--      (tabela append-only; ver seção 6).
--   5. Revoga TODAS as sessões de contexto vivas (motivo
--      'migracao_060_multi_perfil'). Login/senha intactos; o usuário só
--      re-seleciona empresa/unidade uma vez.
--
--   MODEL Y (aprovado na Fase A.1): NÃO existe "um contexto por perfil".
--   Nenhuma UNIQUE limita sessões por perfil/conta — `sessoes_contexto.id`
--   segue sendo a identidade da sessão. Multi-device do mesmo perfil é
--   permitido. A lógica de revogação por sessionId entra na Fase D.
--
-- O QUE ESTA MIGRATION **NÃO** FAZ (proibido nesta fase):
--   * não remove `usuario_id` de tabela nenhuma (necessário p/ rollback e
--     compatibilidade com o backend atual);
--   * não aplica NOT NULL em nenhuma coluna `perfil_id` (quebraria o backend
--     atual, que ainda insere sem ela — ver "BACKWARD COMPATIBILITY");
--   * não adiciona a UNIQUE `(perfil_id, organizacao_id)` / `(perfil_id,
--     unidade_id)` (vem junto do NOT NULL, na Fase C/E);
--   * não adiciona a CHECK `perfil_id IS NOT NULL OR impersonado_por IS NOT
--     NULL` em `sessoes_contexto` (quebraria o `criarSessao` atual — Fase D);
--   * não migra as outras ~28 colunas `-> perfis(id)` (classificadas B/C na
--     Fase A.1 — não é blocker de segurança);
--   * não toca auth.users, não mexe em senha/e-mail, não cria 2º perfil,
--     não cria PIN, não altera Context Token, não altera RLS existente
--     (só cria RLS da tabela nova).
--
-- RESULTADO: cada conta atual termina com EXATAMENTE 1 perfil operacional,
--   cujo id == id da conta.
--
-- PRÉ-REQUISITOS: migrations 015, 020, 030, 048 aplicadas
--   (usuarios_organizacoes/unidades, sessoes_contexto, sessoes_contexto.modulos,
--    agente_conversas, plataforma_auditoria, set_updated_at(),
--    is_platform_superadmin()).
--
-- PRÉ-CHECKS OBRIGATÓRIOS: rode ANTES o bloco "PRÉ-CHECK" abaixo. Se QUALQUER
--   consulta 4–7 ou 10 retornar linha > 0, **NÃO aplique** — reporte a
--   inconsistência (a criação das FKs abaixo falharia de qualquer forma e a
--   transação inteira faria rollback, mas o certo é diagnosticar antes).
--
-- TRANSACIONAL: o arquivo inteiro roda em UMA transação (nenhum statement
--   não-transacional). Se algo falhar, NADA é aplicado.
-- IDEMPOTENTE: reexecutável com segurança (if not exists / on conflict /
--   guardas do_$$). O único efeito repetível é revogar sessões que tenham
--   nascido entre duas execuções — inofensivo.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
--   NÃO executar automaticamente em produção. NÃO rodar contra o banco de
--   produção sem aprovação explícita.
-- =====================================================================


-- =====================================================================
-- PRÉ-CHECK  (execute isoladamente ANTES; nada aqui escreve)
-- =====================================================================
-- 1) contas (perfis) hoje:
--    select count(*) as perfis_total from perfis;
-- 2) perfis_operacionais esperados após backfill (== item 1):
--    select count(*) as perfis_op_esperado from perfis;
-- 3) perfis com id nulo (impossível — id é PK — mas confere nome vazio):
--    select count(*) as perfis_sem_nome from perfis where nome is null or btrim(nome) = '';
-- 4) vínculos de EMPRESA cujo usuario_id não tem linha em perfis  >>> TEM QUE SER 0
--    select count(*) as uo_orfaos
--      from usuarios_organizacoes uo
--      left join perfis p on p.id = uo.usuario_id
--     where p.id is null;
-- 5) vínculos de UNIDADE cujo usuario_id não tem linha em perfis  >>> TEM QUE SER 0
--    select count(*) as uu_orfaos
--      from usuarios_unidades uu
--      left join perfis p on p.id = uu.usuario_id
--     where p.id is null;
-- 6) conversas do Agente cujo usuario_id não tem linha em perfis  >>> TEM QUE SER 0
--    (usuario_id NULL é OK — conversa sem dono; conta só as que apontam p/ id inexistente)
--    select count(*) as conv_orfas
--      from agente_conversas c
--      left join perfis p on p.id = c.usuario_id
--     where c.usuario_id is not null and p.id is null;
-- 7) sessões cujo usuario_id não tem linha em perfis  >>> TEM QUE SER 0
--    select count(*) as sess_orfas
--      from sessoes_contexto s
--      left join perfis p on p.id = s.usuario_id
--     where p.id is null;
-- 8) sessões vivas que serão revogadas por esta migration:
--    select count(*) as sessoes_a_revogar from sessoes_contexto where revogada_em is null;
-- 9) contas inativas (o perfil inicial vai nascer inativo também):
--    select count(*) as contas_inativas from perfis where ativo = false;
-- 10) agente_conversas com usuario_id NULL (informativo — perfil_id ficará NULL nelas):
--    select count(*) as conv_sem_dono from agente_conversas where usuario_id is null;
-- 11) impersonações históricas em sessoes_contexto (perfil_id ficará NULL nelas):
--    select count(*) as sessoes_impersonacao
--      from sessoes_contexto where impersonado_por is not null;
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. PERFIS OPERACIONAIS  (a pessoa)
-- ---------------------------------------------------------------------
create table if not exists perfis_operacionais (
  id                uuid primary key default gen_random_uuid(),
  -- CONTA dona deste perfil. FK para `perfis` (espelho 1:1 de auth.users).
  -- ON DELETE CASCADE: espelha `perfis.id -> auth.users on delete cascade`.
  -- Se a conta do Auth é excluída (fluxo SuperAdmin), os perfis vão junto —
  -- o histórico de domínio é preservado à parte (FKs `-> perfis(id)`
  -- SET NULL e `agente_conversas.perfil_id` SET NULL; auditoria sem FK).
  conta_id          uuid not null references perfis(id) on delete cascade,
  nome              text not null,
  ativo             boolean not null default true,
  -- PIN individual — colunas criadas JÁ (evita migration estrutural extra),
  -- mas SEM regra SQL: "conta com 2+ perfis exige PIN em todos" é regra de
  -- aplicação (Fase G/H). Conta com 1 perfil funciona sem PIN.
  pin_hash          text,
  pin_tentativas    integer not null default 0,
  pin_bloqueado_ate timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Sem UNIQUE(conta_id, nome): nome NÃO é identificador (decisão Fase B, item 13).
-- Dois "João" na mesma conta são válidos se forem pessoas distintas. Evitar
-- duplicata acidental é validação de UX, não constraint.

comment on table perfis_operacionais is
  'Perfil operacional (a PESSOA). N por conta. A conta (e-mail+senha) é perfis/auth.users. Autorização efetiva passa a ser por perfil_id (Fase C-E).';
comment on column perfis_operacionais.conta_id is
  'perfis(id) = auth.users(id). No backfill inicial, id == conta_id (UUID reaproveitado).';
comment on column perfis_operacionais.pin_hash is
  'NULL = perfil sem PIN. Hash (Fase H). Nunca texto puro. Nunca exposto ao frontend.';

drop trigger if exists trg_perfis_op_upd on perfis_operacionais;
create trigger trg_perfis_op_upd before update on perfis_operacionais
  for each row execute function set_updated_at();

-- BACKFILL — UUID REAPROVEITADO: 1 perfil por conta, id == conta_id.
-- `perfis.nome` é NOT NULL no schema; o coalesce é só cinto-e-suspensório.
-- Carrega `created_at` e `ativo` da conta (conta inativa -> perfil inativo).
insert into perfis_operacionais (id, conta_id, nome, ativo, created_at, updated_at)
select
  p.id,
  p.id,
  coalesce(nullif(btrim(p.nome), ''), split_part(coalesce(p.email, ''), '@', 1), 'Usuário'),
  coalesce(p.ativo, true),
  coalesce(p.created_at, now()),
  now()
from perfis p
on conflict (id) do nothing;

-- Índice: "listar perfis desta conta" (fluxo GET /sessao/perfis da Fase C).
-- Tabela pequena (poucos perfis por conta) — `(conta_id)` cobre a busca por
-- conta e o filtro `ativo` subsequente sem custo relevante. Um índice
-- `(conta_id) where ativo` só valeria com muitos perfis inativos por conta,
-- cenário não esperado.
create index if not exists idx_perfis_op_conta on perfis_operacionais(conta_id);

-- RLS — padrão do projeto: deny-by-default; o backend usa service_role e
-- ignora RLS; esta policy só vale para acesso direto autenticado (anon key).
-- `auth.uid()` = a CONTA. Um usuário autenticado enxerga os perfis da PRÓPRIA
-- conta; superadmin enxerga todos. Escrita é exclusiva do backend (service_role) —
-- nenhuma policy de insert/update/delete = negado para `authenticated`.
alter table perfis_operacionais enable row level security;
drop policy if exists rls_perfis_op_conta on perfis_operacionais;
create policy rls_perfis_op_conta on perfis_operacionais
  for select to authenticated
  using (conta_id = auth.uid() or is_platform_superadmin());


-- ---------------------------------------------------------------------
-- 2. usuarios_organizacoes.perfil_id   (LEGACY: usuario_id · CANÔNICA FUTURA: perfil_id)
-- ---------------------------------------------------------------------
alter table usuarios_organizacoes add column if not exists perfil_id uuid;

comment on column usuarios_organizacoes.usuario_id is
  'LEGACY/TRANSIÇÃO — mantido até a Fase C/E. Novo código autoriza por perfil_id.';
comment on column usuarios_organizacoes.perfil_id is
  'CANÔNICA FUTURA. NULLABLE nesta fase (o backend atual insere sem ela). '
  'NOT NULL + UNIQUE(perfil_id, organizacao_id) + drop de usuario_id: migration da Fase C/E.';

-- Backfill: perfil_id = usuario_id (o UUID reaproveitado torna isto válido).
update usuarios_organizacoes set perfil_id = usuario_id where perfil_id is null;

-- FK — ON DELETE CASCADE espelha o `usuario_id -> auth.users on delete cascade`
-- já existente nesta MESMA tabela. Vínculo é ESTADO DE ACESSO ATUAL, não
-- histórico: se um perfil for hard-deleted (fora do fluxo normal, que é
-- ativo=false), suas linhas de acesso devem sair junto — não fazem sentido
-- apontando para um perfil inexistente. (RESTRICT seria a alternativa
-- conservadora se preferir bloquear a exclusão de perfil com vínculos.)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'uo_perfil_id_fk') then
    alter table usuarios_organizacoes
      add constraint uo_perfil_id_fk
      foreign key (perfil_id) references perfis_operacionais(id) on delete cascade;
  end if;
end $$;

-- Índice: lookup futuro "vínculos deste perfil" (espelha idx_uo_usuario).
create index if not exists idx_uo_perfil on usuarios_organizacoes(perfil_id);


-- ---------------------------------------------------------------------
-- 3. usuarios_unidades.perfil_id   (mesma estratégia da seção 2)
-- ---------------------------------------------------------------------
alter table usuarios_unidades add column if not exists perfil_id uuid;

comment on column usuarios_unidades.usuario_id is
  'LEGACY/TRANSIÇÃO — mantido até a Fase C/E.';
comment on column usuarios_unidades.perfil_id is
  'CANÔNICA FUTURA. NULLABLE nesta fase. NOT NULL + UNIQUE(perfil_id, unidade_id): Fase C/E.';

update usuarios_unidades set perfil_id = usuario_id where perfil_id is null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'uu_perfil_id_fk') then
    alter table usuarios_unidades
      add constraint uu_perfil_id_fk
      foreign key (perfil_id) references perfis_operacionais(id) on delete cascade;
  end if;
end $$;

create index if not exists idx_uu_perfil on usuarios_unidades(perfil_id);


-- ---------------------------------------------------------------------
-- 4. sessoes_contexto.perfil_id   +   revogação das sessões vivas
-- ---------------------------------------------------------------------
alter table sessoes_contexto add column if not exists perfil_id uuid;

comment on column sessoes_contexto.perfil_id is
  'Perfil da sessão (Context Token v2 = pid). NULLABLE. NULL legítimo APENAS '
  'em sessão de impersonação (impersonado_por IS NOT NULL). A CHECK '
  '(perfil_id IS NOT NULL OR impersonado_por IS NOT NULL) entra na Fase D, '
  'depois que criarSessao passar a gravar perfil_id. NENHUMA UNIQUE sobre '
  'perfil_id/conta — Model Y permite multi-device do mesmo perfil.';

-- FK — ON DELETE CASCADE espelha `usuario_id -> auth.users on delete cascade`.
-- Sessão é efêmera; some com o perfil (e já teria sido revogada antes).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sessoes_perfil_id_fk') then
    alter table sessoes_contexto
      add constraint sessoes_perfil_id_fk
      foreign key (perfil_id) references perfis_operacionais(id) on delete cascade;
  end if;
end $$;

-- Backfill APENAS das sessões NÃO-impersonação (impersonação histórica fica
-- com perfil_id NULL — coerente com o contrato futuro). `usuario_id` é NOT
-- NULL nesta tabela, então toda sessão normal recebe perfil_id.
update sessoes_contexto
   set perfil_id = usuario_id
 where perfil_id is null
   and impersonado_por is null;

-- Índice: "sessões vivas deste perfil" (Model Y — revogação por {perfilId,org},
-- contagem de "usuários online"). Parcial: só linhas vivas importam.
create index if not exists idx_sessoes_perfil_vivas
  on sessoes_contexto(perfil_id) where revogada_em is null;

-- REVOGAÇÃO das sessões vivas — mudança de contrato de sessão (Model Y +
-- futuro Context Token v2). NÃO é DELETE físico. O usuário continua logado
-- (JWT do Supabase intacto) e apenas re-seleciona empresa/unidade: o
-- Context Token some -> requireContexto responde 409 -> frontend cai na
-- tela de seleção (restaurarContexto -> false -> listarAcessos).
update sessoes_contexto
   set revogada_em = now(),
       motivo_revogacao = 'migracao_060_multi_perfil'
 where revogada_em is null;


-- ---------------------------------------------------------------------
-- 5. agente_conversas.perfil_id   (BLOCKER DE SEGURANÇA — Fase A.1)
--    `buscarConversa` isola conversa por usuario_id. Conta compartilhada
--    -> Fulana 1 veria as conversas da Fulana 2. A conversa passa a
--    pertencer ao PERFIL. A troca das QUERIES do backend é da Fase D;
--    aqui só o schema + backfill + índice.
-- ---------------------------------------------------------------------
alter table agente_conversas add column if not exists perfil_id uuid;

comment on column agente_conversas.usuario_id is
  'LEGACY/TRANSIÇÃO. O isolamento passa a ser por perfil_id (Fase D).';
comment on column agente_conversas.perfil_id is
  'Dono da conversa (PERFIL). NULLABLE — espelha usuario_id, que já é '
  'nullable (conversa sem dono / impersonação). NOT NULL fica FORA desta '
  'fase: (a) usuario_id já admite NULL, (b) o backend atual insere sem '
  'perfil_id. Isolamento é responsabilidade da QUERY (perfil_id = X OU IS '
  'NULL), não de um NOT NULL.';

-- FK — ON DELETE SET NULL: espelha EXATAMENTE o `usuario_id -> perfis(id)
-- on delete set null` desta tabela. Conversa é HISTÓRICO: perfil excluído
-- não apaga a conversa (a org ainda é dona; organizacao_id é CASCADE).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'agente_conversas_perfil_id_fk') then
    alter table agente_conversas
      add constraint agente_conversas_perfil_id_fk
      foreign key (perfil_id) references perfis_operacionais(id) on delete set null;
  end if;
end $$;

-- Backfill: perfil_id = usuario_id (mantém NULL onde usuario_id é NULL).
update agente_conversas set perfil_id = usuario_id where perfil_id is null;

-- Índice: espelha idx_agente_conversas_escopo, trocando usuario_id -> perfil_id.
-- É o índice que a `buscarConversa` reescrita (Fase D) vai usar. NULL
-- participa normalmente do índice (cobre a visão sem dono).
create index if not exists idx_agente_conversas_escopo_perfil
  on agente_conversas(perfil_id, organizacao_id, unidade_id);


-- ---------------------------------------------------------------------
-- 6. plataforma_auditoria.perfil_id   (SEM FK, SEM BACKFILL)
-- ---------------------------------------------------------------------
-- `ALTER TABLE ... ADD COLUMN` (nullable, sem default volátil) é operação de
-- catálogo — NÃO percorre linhas e NÃO dispara os triggers BEFORE
-- UPDATE/DELETE/TRUNCATE da migration 020. É seguro.
--
-- SEM FK — mesmo motivo de `ator_id`/`impersonado_por` nesta tabela ("sem FK
-- para sobreviver à exclusão do usuário"). Auditoria é imutável e não pode
-- perder identidade histórica nem por exclusão de perfil nem de conta.
--
-- SEM BACKFILL — o trigger `trg_audit_sem_update` recusa QUALQUER update na
-- tabela, inclusive service_role. As linhas históricas ficam com perfil_id
-- NULL; a identidade delas continua preservada em `ator_id` + `ator_email`
-- (como sempre foi). Só as linhas gravadas a partir da Fase I carregam
-- perfil_id.
alter table plataforma_auditoria add column if not exists perfil_id uuid;

comment on column plataforma_auditoria.perfil_id is
  'Perfil operacional que executou a ação. SEM FK (append-only; sobrevive à '
  'exclusão de perfil/conta). NULL em linhas anteriores à Fase I e em ações '
  'de superadmin/sistema. Preenchido a partir da Fase I via req.acesso.perfilId.';

-- Índice: trilha de auditoria por perfil (view de detalhe do usuário, futura
-- por-perfil). Fica quase vazio até a Fase I — é barato e evita outra migration.
create index if not exists idx_audit_perfil on plataforma_auditoria(perfil_id);


-- ---------------------------------------------------------------------
-- 7. RLS EXISTENTE — o que foi REVISADO e NÃO alterado (e por quê)
-- ---------------------------------------------------------------------
-- (Fase A.1, item 17. Nenhuma policy abaixo referencia perfil_id, então
--  nenhuma quebra. NÃO reconstruímos segurança aqui.)
--
--   * rls_uo_self / rls_uu_self  ->  `usuario_id = auth.uid()`  — MANTIDAS.
--       `usuario_id` continua populado (= conta) nesta e nas próximas fases,
--       então a policy segue correta como "vínculos da minha CONTA". NÃO
--       trocar para `perfil_id = auth.uid()`: só funcionaria para o perfil
--       inicial (id == conta); os perfis adicionais seriam ESCONDIDOS.
--
--   * auth_organizacao_ids() / auth_unidade_ids()  — MANTIDAS.
--       Leem `usuarios_*.usuario_id = auth.uid()`. Devolvem a UNIÃO das orgs
--       da CONTA (todos os perfis). Isso é autorização em nível de CONTA no
--       RLS; a seleção fina por PERFIL é responsabilidade do backend +
--       Context Token (que carrega o perfil_id da sessão). Como o frontend
--       NÃO consulta tabelas de tenant direto (confirmado na Fase A.1), não
--       há over-share real hoje. RISCO CONHECIDO: se algum dia uma API
--       passar a usar a anon key contra tabelas de tenant, estes helpers
--       precisam filtrar pelo perfil ativo da sessão — revisitar então.
--
--   * is_platform_superadmin()  — MANTIDA. `plataforma_admins.usuario_id =
--       auth.uid()`: superadmin é atributo da CONTA. Correto.
--
--   * rls_agente_conversas_tenant  — MANTIDA. Filtra por `organizacao_id`,
--       não por `usuario_id`. Adicionar `perfil_id` não a afeta. (O
--       isolamento por perfil é feito na QUERY do backend, não no RLS.)


-- ---------------------------------------------------------------------
-- 8. PÓS-CHECK  (execute isoladamente DEPOIS)
-- ---------------------------------------------------------------------
-- A) 1 perfil por conta, e id == conta_id:
--    select
--      (select count(*) from perfis)               as contas,
--      (select count(*) from perfis_operacionais)  as perfis_op,
--      (select count(*) from perfis_operacionais where id = conta_id) as id_reaproveitado_ok;
--    -- esperado: contas == perfis_op == id_reaproveitado_ok
--
-- B) backfill perfil_id nos vínculos (todo não-nulo == usuario_id):
--    select count(*) as uo_pendentes from usuarios_organizacoes where perfil_id is null;   -- 0
--    select count(*) as uo_divergentes from usuarios_organizacoes where perfil_id <> usuario_id;  -- 0
--    select count(*) as uu_pendentes from usuarios_unidades where perfil_id is null;        -- 0
--    select count(*) as uu_divergentes from usuarios_unidades where perfil_id <> usuario_id;      -- 0
--
-- C) agente_conversas — perfil_id == usuario_id onde havia dono; NULL onde não havia;
--    NENHUMA conversa trocou de dono:
--    select count(*) as conv_divergentes from agente_conversas
--      where usuario_id is not null and perfil_id <> usuario_id;                            -- 0
--    select count(*) as conv_dono_perdido from agente_conversas
--      where usuario_id is not null and perfil_id is null;                                  -- 0
--
-- D) sessões: todas as vivas foram revogadas com o motivo certo; impersonação
--    histórica ficou com perfil_id NULL:
--    select count(*) as sessoes_vivas from sessoes_contexto where revogada_em is null;      -- 0
--    select count(*) as revogadas_060 from sessoes_contexto
--      where motivo_revogacao = 'migracao_060_multi_perfil';                                -- == pré-check 8
--    select count(*) as imp_com_perfil from sessoes_contexto
--      where impersonado_por is not null and perfil_id is not null;                         -- 0
--    select count(*) as normal_sem_perfil from sessoes_contexto
--      where impersonado_por is null and perfil_id is null;                                 -- 0
--
-- E) FKs criadas:
--    select conname from pg_constraint
--     where conname in ('uo_perfil_id_fk','uu_perfil_id_fk','sessoes_perfil_id_fk','agente_conversas_perfil_id_fk')
--     order by conname;                                                                     -- 4 linhas
--
-- F) plataforma_auditoria ganhou a coluna e continua append-only:
--    select column_name from information_schema.columns
--     where table_name = 'plataforma_auditoria' and column_name = 'perfil_id';              -- 1 linha
--    -- e (erro esperado — trigger de imutabilidade):
--    -- update plataforma_auditoria set perfil_id = null where false;
--
-- G) nenhuma tabela de domínio foi tocada (as ~28 colunas B/C seguem só com
--    usuario_id / created_by / etc.):
--    select column_name from information_schema.columns
--     where table_name = 'lancamentos_financeiros_diarios' and column_name = 'perfil_id';   -- 0 linhas
-- =====================================================================


-- =====================================================================
-- ROLLBACK  (ordem exata — execute de trás para frente; tudo comentado)
-- =====================================================================
-- `usuario_id` NUNCA foi removido, então o rollback devolve o estado exato
-- de antes (menos as sessões revogadas, que já estariam expiradas/revogadas
-- de qualquer forma — reverter o `revogada_em` não faz sentido e não é
-- necessário: o usuário só re-seleciona contexto).
--
-- 1. Índices novos:
--    drop index if exists idx_audit_perfil;
--    drop index if exists idx_agente_conversas_escopo_perfil;
--    drop index if exists idx_sessoes_perfil_vivas;
--    drop index if exists idx_uu_perfil;
--    drop index if exists idx_uo_perfil;
--    drop index if exists idx_perfis_op_conta;
--
-- 2. FKs novas (antes de dropar a tabela-alvo):
--    alter table agente_conversas       drop constraint if exists agente_conversas_perfil_id_fk;
--    alter table sessoes_contexto       drop constraint if exists sessoes_perfil_id_fk;
--    alter table usuarios_unidades      drop constraint if exists uu_perfil_id_fk;
--    alter table usuarios_organizacoes  drop constraint if exists uo_perfil_id_fk;
--
-- 3. Colunas perfil_id (todas nullable, nenhuma referenciada por view/policy):
--    alter table plataforma_auditoria   drop column if exists perfil_id;
--    alter table agente_conversas       drop column if exists perfil_id;
--    alter table sessoes_contexto       drop column if exists perfil_id;
--    alter table usuarios_unidades      drop column if exists perfil_id;
--    alter table usuarios_organizacoes  drop column if exists perfil_id;
--
-- 4. Comentários revertidos (opcional — inofensivos se ficarem):
--    comment on column usuarios_organizacoes.usuario_id is null;  -- etc.
--
-- 5. RLS + tabela nova:
--    drop policy if exists rls_perfis_op_conta on perfis_operacionais;
--    drop trigger if exists trg_perfis_op_upd on perfis_operacionais;
--    drop table if exists perfis_operacionais;   -- (perde só os perfis; nada
--                                                --  de domínio referencia esta tabela)
--
-- 6. Nada a fazer em auth.users / perfis / set_updated_at() / policies antigas
--    (não foram tocados).
-- =====================================================================
-- FIM
-- =====================================================================
