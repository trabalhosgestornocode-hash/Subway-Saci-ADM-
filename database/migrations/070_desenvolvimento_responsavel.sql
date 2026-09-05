-- =====================================================================
-- MIGRATION 070 — Responsável pela demanda + nomes humanos no histórico
-- =====================================================================
-- OBJETIVO
--   Evolução da Agenda de Demandas (069). A 069 NÃO é alterada: esta
--   migration só ACRESCENTA coluna/índice/funções e SUBSTITUI o corpo de
--   duas funções de trigger (create or replace), preservando o arquivo
--   original como registro histórico do que foi aplicado primeiro.
--
--   1. `responsavel_usuario_id`: quem toca a demanda. Nulo é permitido
--      (demandas antigas e demandas ainda sem dono); quando preenchido,
--      PRECISA ser uma conta com acesso ao Painel Administrativo — acesso
--      próprio (`painel_administrativo_usuarios`) ou SuperAdmin
--      (`plataforma_admins`), exatamente o par que o middleware
--      `requirePainelAdministrativo` consulta. Não existe cadastro
--      paralelo de pessoas: a fonte é a que já existe.
--
--   2. Histórico com NOME, não UUID. O texto do evento é montado no
--      momento da escrita (como todos os eventos da 069, que já gravam
--      texto pronto), então a troca de responsável fica legível para
--      sempre — inclusive se a conta for removida depois.
--
--   3. `ator_tipo` da auditoria deixa de ser 'superadmin' fixo: agora
--      qualquer usuário do Painel Administrativo escreve na agenda, e a
--      auditoria precisa refletir quem de fato agiu.
--
-- NENHUMA demanda recebe responsável por aqui. Definir o responsável de
-- DEV-001/DEV-002 é feito pela interface, com autor registrado.
--
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Coluna do responsável
-- ---------------------------------------------------------------------
alter table public.desenvolvimento_demandas
  add column if not exists responsavel_usuario_id uuid references auth.users(id) on delete set null;

create index if not exists desenvolvimento_responsavel
  on public.desenvolvimento_demandas(responsavel_usuario_id);

comment on column public.desenvolvimento_demandas.responsavel_usuario_id is
  'Conta responsavel pela demanda. Sempre um usuario com acesso ativo ao Painel Administrativo (painel_administrativo_usuarios) ou SuperAdmin ativo (plataforma_admins). Nulo = sem responsavel definido.';

-- Novo tipo de evento no histórico. O CHECK da 069 é recriado com ASSIGN
-- somado — a lista original permanece exatamente como estava.
alter table public.desenvolvimento_demanda_atualizacoes
  drop constraint if exists desenvolvimento_demanda_atualizacoes_tipo_check;
alter table public.desenvolvimento_demanda_atualizacoes
  add constraint desenvolvimento_demanda_atualizacoes_tipo_check
  check (tipo in ('UPDATE','PROGRESS','STATUS','BLOCK','UNBLOCK','FORECAST','COMPLETED','REOPEN','COMMENT','PRIORITY','CREATE','ARCHIVE','ASSIGN'));

-- ---------------------------------------------------------------------
-- 2. Nome humano de uma conta — NUNCA devolve UUID
--    perfis.nome -> perfis.email -> auth.users.email -> rótulo genérico.
--    SECURITY DEFINER porque `auth.users` não é legível fora do backend.
--    O SuperAdmin pode não ter linha em `perfis` (não pertence a nenhuma
--    empresa) — por isso o fallback para o e-mail do Auth.
-- ---------------------------------------------------------------------
create or replace function public.desenvolvimento_nome_usuario(p_id uuid)
returns text language sql stable security definer set search_path=public,auth as $fn$
  select coalesce(
           nullif(btrim(p.nome), ''),
           nullif(btrim(p.email), ''),
           nullif(btrim(u.email), ''),
           'Usuário sem cadastro')
    from auth.users u
    left join public.perfis p on p.id = u.id
   where u.id = p_id
$fn$;

-- Elegibilidade do responsável: o MESMO par consultado por
-- requirePainelAdministrativo. Sem cadastro paralelo, sem lista fixa.
create or replace function public.desenvolvimento_pode_ser_responsavel(p_id uuid)
returns boolean language sql stable security definer set search_path=public as $fn$
  select p_id is not null and (
         exists (select 1 from public.painel_administrativo_usuarios where usuario_id = p_id and ativo)
      or exists (select 1 from public.plataforma_admins            where usuario_id = p_id and ativo))
$fn$;

-- Tipo do ator para a auditoria. SECURITY DEFINER pela mesma razão das
-- funções acima: o gatilho roda com os privilégios de quem escreveu na
-- agenda, e `plataforma_admins` não é legível por todo mundo.
create or replace function public.desenvolvimento_ator_tipo(p_id uuid)
returns text language sql stable security definer set search_path=public as $fn$
  select case when exists (select 1 from public.plataforma_admins where usuario_id = p_id and ativo)
              then 'superadmin' else 'usuario' end
$fn$;

revoke all on function public.desenvolvimento_ator_tipo(uuid) from public, anon, authenticated;
grant execute on function public.desenvolvimento_ator_tipo(uuid) to service_role;
revoke all on function public.desenvolvimento_nome_usuario(uuid) from public, anon, authenticated;
revoke all on function public.desenvolvimento_pode_ser_responsavel(uuid) from public, anon, authenticated;
grant execute on function public.desenvolvimento_nome_usuario(uuid) to service_role;
grant execute on function public.desenvolvimento_pode_ser_responsavel(uuid) to service_role;

-- ---------------------------------------------------------------------
-- 3. Preparação da linha — corpo da 069 + guarda do responsável.
--    A guarda só roda quando o responsável MUDA: revogar o acesso de
--    alguém não pode travar a edição das demandas antigas dele.
-- ---------------------------------------------------------------------
create or replace function public.desenvolvimento_preparar() returns trigger language plpgsql set search_path=public as $fn$
begin
  -- Exclusões do cadastro existente não ficam bloqueadas por uma agenda.
  -- Normaliza apenas remoções de FKs; o service rejeita escopos inválidos de entrada.
  if TG_OP='UPDATE' then
    if old.organizacao_id is not null and new.organizacao_id is null then new.unidade_id:=null; new.escopo:='PLATFORM';
    elsif old.unidade_id is not null and new.unidade_id is null then new.escopo:=case when new.organizacao_id is null then 'PLATFORM' else 'ORGANIZATION' end; end if;
  end if;
  if new.unidade_id is not null and not exists (select 1 from unidades where id=new.unidade_id and organizacao_id=new.organizacao_id for share) then
    raise exception 'Unidade incompatível com organização' using errcode='23514';
  end if;
  -- Responsável só pode ser quem de fato entra no Painel Administrativo.
  if new.responsavel_usuario_id is not null
     and (TG_OP='INSERT' or old.responsavel_usuario_id is distinct from new.responsavel_usuario_id)
     and not desenvolvimento_pode_ser_responsavel(new.responsavel_usuario_id) then
    raise exception 'Responsável sem acesso ao Painel Administrativo' using errcode='23514';
  end if;
  if new.status='COMPLETED' then
    new.progresso:=100;
    new.conclusao_real:=coalesce(new.conclusao_real,(now() at time zone 'America/Sao_Paulo')::date);
  end if;
  if new.status='IN_PROGRESS' then new.inicio_real:=coalesce(new.inicio_real,(now() at time zone 'America/Sao_Paulo')::date); end if;
  if new.status in ('COMPLETED','ARCHIVED') then new.foco_atual:=false; end if;
  if TG_OP='UPDATE' then
    new.versao:=old.versao+1;
    new.updated_at:=clock_timestamp();
    if old.status='COMPLETED' and new.status not in ('COMPLETED','ARCHIVED') then new.conclusao_real:=null; if new.progresso=100 then new.progresso:=0; end if; end if;
  end if;
  return new;
end $fn$;

-- ---------------------------------------------------------------------
-- 4. Histórico e auditoria — corpo da 069 + evento ASSIGN com nomes
--    resolvidos na escrita, e ator_tipo derivado de quem realmente agiu.
-- ---------------------------------------------------------------------
create or replace function public.desenvolvimento_registrar() returns trigger language plpgsql set search_path=public as $fn$
declare k text; antes jsonb; depois jsonb; tipo_evento text; rotulo text; ator uuid;
begin
  if TG_OP='INSERT' then
    insert into desenvolvimento_demanda_atualizacoes(demanda_id,autor,texto,tipo) values(new.id,new.atualizado_por,'Demanda criada.','CREATE');
    if new.responsavel_usuario_id is not null then
      insert into desenvolvimento_demanda_atualizacoes(demanda_id,autor,texto,tipo)
      values(new.id,new.atualizado_por,'Responsável definido: '||desenvolvimento_nome_usuario(new.responsavel_usuario_id)||'.','ASSIGN');
    end if;
  elsif TG_OP='UPDATE' then
    antes:=to_jsonb(old); depois:=to_jsonb(new);
    foreach k in array array['status','progresso','previsao_entrega','prioridade','bloqueio','atualizacao_publica'] loop
      if antes->k is distinct from depois->k then
        tipo_evento:=case k when 'status' then case when new.status='COMPLETED' then 'COMPLETED' when old.status='COMPLETED' then 'REOPEN' when new.status='ARCHIVED' then 'ARCHIVE' else 'STATUS' end when 'progresso' then 'PROGRESS' when 'previsao_entrega' then 'FORECAST' when 'prioridade' then 'PRIORITY' when 'bloqueio' then case when new.bloqueio='' then 'UNBLOCK' else 'BLOCK' end else 'UPDATE' end;
        rotulo:=case k when 'status' then 'Status' when 'progresso' then 'Progresso' when 'previsao_entrega' then 'Previsão' when 'prioridade' then 'Prioridade' when 'bloqueio' then 'Bloqueio' else 'Atualização pública' end;
        insert into desenvolvimento_demanda_atualizacoes(demanda_id,autor,texto,tipo)
        values(new.id,new.atualizado_por,case when k='atualizacao_publica' then coalesce(nullif(new.atualizacao_publica,''),'Atualização pública removida.') else rotulo||' alterado de '||coalesce(antes->>k,'sem valor')||' para '||coalesce(depois->>k,'sem valor')||'.' end,tipo_evento);
      end if;
    end loop;
    -- Troca de responsável: anterior e novo por NOME, resolvidos agora.
    if old.responsavel_usuario_id is distinct from new.responsavel_usuario_id then
      insert into desenvolvimento_demanda_atualizacoes(demanda_id,autor,texto,tipo)
      values(new.id,new.atualizado_por,
        'Responsável alterado de '||coalesce(desenvolvimento_nome_usuario(old.responsavel_usuario_id),'sem responsável')
        ||' para '||coalesce(desenvolvimento_nome_usuario(new.responsavel_usuario_id),'sem responsável')||'.','ASSIGN');
    end if;
    if old.nota_interna is distinct from new.nota_interna or old.link_tecnico is distinct from new.link_tecnico then
      insert into desenvolvimento_demanda_atualizacoes(demanda_id,autor,texto,tipo,visibilidade) values(new.id,new.atualizado_por,'Informações técnicas atualizadas.','UPDATE','INTERNAL');
    end if;
  end if;
  ator := case when TG_OP='DELETE' then old.atualizado_por else new.atualizado_por end;
  insert into plataforma_auditoria(ator_id,ator_tipo,acao,entidade,entidade_id,detalhes)
  values(ator,
    desenvolvimento_ator_tipo(ator),
    'desenvolvimento.'||lower(TG_OP),'desenvolvimento_demandas',case when TG_OP='DELETE' then old.id::text else new.id::text end,
    jsonb_build_object('antes',case when TG_OP<>'INSERT' then to_jsonb(old)-'nota_interna'-'link_tecnico' else null end,'depois',case when TG_OP<>'DELETE' then to_jsonb(new)-'nota_interna'-'link_tecnico' else null end));
  return null;
end $fn$;

commit;

-- =====================================================================
-- VERIFICAÇÃO
--   -- Coluna criada e vazia (nenhuma demanda ganhou dono por migration):
--   select codigo, titulo, responsavel_usuario_id from desenvolvimento_demandas order by numero;
--
--   -- Quem pode ser responsável (é exatamente o que a API oferece no formulário):
--   select usuario_id, desenvolvimento_nome_usuario(usuario_id) as nome
--     from painel_administrativo_usuarios where ativo
--   union
--   select usuario_id, desenvolvimento_nome_usuario(usuario_id)
--     from plataforma_admins where ativo;
--
--   -- Conta sem acesso ao painel é recusada pelo banco (erro 23514):
--   -- update desenvolvimento_demandas set responsavel_usuario_id='<uuid sem painel>' where codigo='DEV-001';
--
--   -- Histórico legível, sem UUID:
--   select created_at, tipo, texto, desenvolvimento_nome_usuario(autor) as autor
--     from desenvolvimento_demanda_atualizacoes order by created_at desc limit 20;
-- =====================================================================
-- ROLLBACK
--   alter table desenvolvimento_demandas drop column responsavel_usuario_id;
--   drop function if exists desenvolvimento_ator_tipo(uuid);
--   drop function if exists desenvolvimento_pode_ser_responsavel(uuid);
--   drop function if exists desenvolvimento_nome_usuario(uuid);
--   -- e reexecutar os blocos `desenvolvimento_preparar` / `desenvolvimento_registrar` da 069.
-- =====================================================================
