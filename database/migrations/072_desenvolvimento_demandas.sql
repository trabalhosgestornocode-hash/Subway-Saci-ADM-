-- =====================================================================
-- MIGRATION 072 — Agenda de Demandas do Desenvolvimento (estrutura)
-- =====================================================================
-- Central oficial do desenvolvimento. Aplicar após 071; não contém demandas seed.
--
-- HISTÓRICO DE NUMERAÇÃO
--   * Originalmente criada como `069_desenvolvimento_demandas.sql`.
--   * JÁ APLICADA como 069 no Supabase em uso — verificado em 2026-09-05 no
--     catálogo do PostgreSQL (tabelas `desenvolvimento_demandas` e
--     `desenvolvimento_demanda_atualizacoes` presentes).
--   * Renumerada no repositório para 072 apenas para ficar depois de
--     `071_restringir_rpc_pin.sql`, que main renumerou de 068 para 071 ao
--     resolver a colisão com `068_dashboard_ifood_desbloqueios.sql`.
--   * NÃO REEXECUTAR onde já rodou como 069: esta migration NÃO é
--     idempotente (`create table` sem `if not exists`). A transação abortaria
--     inteira, sem estrago parcial, mas o erro é evitável. Confirme ambiente a
--     ambiente antes de executar.
--   * Não há dependência funcional em relação à 071 nem à 068 — a ordem é
--     apenas organizacional.
-- =====================================================================
begin;
create table public.desenvolvimento_demandas (
  id uuid primary key default gen_random_uuid(),
  numero bigint generated always as identity unique,
  codigo text generated always as ('DEV-' || case when numero < 1000 then lpad(numero::text,3,'0') else numero::text end) stored,
  titulo text not null check (length(trim(titulo)) between 1 and 180),
  descricao text not null default '', objetivo text not null default '', impacto text not null default '', resumo_entrega text not null default '',
  categoria text not null default 'Outros' check (categoria in ('Operação','Dashboard iFood','Financeiro','Bonificação','Parser Food Delivery','Plano de Ação','Agente Crescer','Painel Administrativo','Usuários e Acessos','Segurança','Integrações','Infraestrutura','Banco de Dados','UX/UI','Correções','Outros')),
  tipo text not null default 'Feature' check (tipo in ('Feature','Melhoria','Correção','Segurança','Infraestrutura','Refatoração','Integração','Manutenção')),
  prioridade text not null default 'MEDIUM' check (prioridade in ('CRITICAL','HIGH','MEDIUM','LOW')),
  prioridade_ordem integer generated always as (case prioridade when 'CRITICAL' then 0 when 'HIGH' then 1 when 'MEDIUM' then 2 else 3 end) stored,
  status text not null default 'BACKLOG' check (status in ('BACKLOG','PLANNED','IN_PROGRESS','VALIDATION','BLOCKED','COMPLETED','ARCHIVED')),
  progresso integer not null default 0 check (progresso between 0 and 100),
  escopo text not null default 'PLATFORM' check (escopo in ('PLATFORM','ORGANIZATION','UNIT')),
  organizacao_id uuid references public.organizacoes(id) on delete set null,
  unidade_id uuid references public.unidades(id) on delete set null,
  inicio_previsto date, inicio_real date, previsao_entrega date, conclusao_real date,
  proximo_passo text not null default '', bloqueio text not null default '',
  dependencia_id uuid references public.desenvolvimento_demandas(id) on delete restrict,
  atualizacao_publica text not null default '', nota_interna text not null default '', link_tecnico text not null default '',
  foco_atual boolean not null default false, ordem integer not null default 0 check (ordem >= 0),
  arquivada boolean generated always as (status = 'ARCHIVED') stored,
  criado_por uuid references auth.users(id) on delete set null,
  atualizado_por uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  versao integer not null default 1,
  check (dependencia_id is distinct from id),
  check ((escopo='PLATFORM' and organizacao_id is null and unidade_id is null) or (escopo='ORGANIZATION' and organizacao_id is not null and unidade_id is null) or (escopo='UNIT' and organizacao_id is not null and unidade_id is not null)),
  check (inicio_previsto is null or previsao_entrega is null or inicio_previsto <= previsao_entrega),
  check (inicio_real is null or conclusao_real is null or inicio_real <= conclusao_real),
  check (status <> 'COMPLETED' or (progresso=100 and conclusao_real is not null)),
  check (status in ('COMPLETED','ARCHIVED') or conclusao_real is null),
  check (status <> 'BLOCKED' or length(trim(bloqueio)) > 0)
);
create unique index desenvolvimento_foco_unico on public.desenvolvimento_demandas ((true)) where foco_atual;
create index desenvolvimento_status on public.desenvolvimento_demandas(status);
create index desenvolvimento_prioridade on public.desenvolvimento_demandas(prioridade_ordem,ordem,numero);
create index desenvolvimento_categoria on public.desenvolvimento_demandas(categoria);
create index desenvolvimento_previsao on public.desenvolvimento_demandas(previsao_entrega);
create index desenvolvimento_org on public.desenvolvimento_demandas(organizacao_id);
create index desenvolvimento_unidade on public.desenvolvimento_demandas(unidade_id);
create index desenvolvimento_criada on public.desenvolvimento_demandas(created_at);
create index desenvolvimento_conclusao on public.desenvolvimento_demandas(conclusao_real);
create table public.desenvolvimento_demanda_atualizacoes (
  id uuid primary key default gen_random_uuid(),
  demanda_id uuid not null references public.desenvolvimento_demandas(id) on delete cascade,
  autor uuid references auth.users(id) on delete set null,
  texto text not null check (length(trim(texto)) between 1 and 10000),
  tipo text not null check (tipo in ('UPDATE','PROGRESS','STATUS','BLOCK','UNBLOCK','FORECAST','COMPLETED','REOPEN','COMMENT','PRIORITY','CREATE','ARCHIVE')),
  visibilidade text not null default 'PUBLIC' check (visibilidade in ('PUBLIC','INTERNAL')),
  created_at timestamptz not null default now()
);
create index desenvolvimento_historico on public.desenvolvimento_demanda_atualizacoes(demanda_id,created_at desc);
create index desenvolvimento_recentes on public.desenvolvimento_demanda_atualizacoes(visibilidade,created_at desc);

-- Backend service_role apenas: nem notas nem histórico podem ser consultados diretamente por JWT.
alter table public.desenvolvimento_demandas enable row level security;
alter table public.desenvolvimento_demanda_atualizacoes enable row level security;
revoke all on public.desenvolvimento_demandas, public.desenvolvimento_demanda_atualizacoes from anon, authenticated;
grant all on public.desenvolvimento_demandas, public.desenvolvimento_demanda_atualizacoes to service_role;
grant usage, select on sequence public.desenvolvimento_demandas_numero_seq to service_role;

create function public.desenvolvimento_preparar() returns trigger language plpgsql set search_path=public as $$
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
end $$;
create trigger desenvolvimento_preparar before insert or update on public.desenvolvimento_demandas for each row execute function public.desenvolvimento_preparar();

-- Guardar a relação também quando uma unidade é transferida por outros módulos.
-- Preserva a operação existente: demandas da unidade acompanham sua nova organização.
create function public.desenvolvimento_transferir_escopo() returns trigger language plpgsql security definer set search_path=public as $$
begin
  update desenvolvimento_demandas set organizacao_id=new.organizacao_id where unidade_id=new.id;
  return new;
end $$;
create trigger desenvolvimento_transferir_escopo after update of organizacao_id on public.unidades for each row when (old.organizacao_id is distinct from new.organizacao_id) execute function public.desenvolvimento_transferir_escopo();

-- Histórico e auditoria na MESMA transação, inclusive em falha/rollback.
create function public.desenvolvimento_registrar() returns trigger language plpgsql set search_path=public as $$
declare k text; antes jsonb; depois jsonb; tipo_evento text; rotulo text;
begin
  if TG_OP='INSERT' then
    insert into desenvolvimento_demanda_atualizacoes(demanda_id,autor,texto,tipo) values(new.id,new.atualizado_por,'Demanda criada.','CREATE');
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
    if old.nota_interna is distinct from new.nota_interna or old.link_tecnico is distinct from new.link_tecnico then
      insert into desenvolvimento_demanda_atualizacoes(demanda_id,autor,texto,tipo,visibilidade) values(new.id,new.atualizado_por,'Informações técnicas atualizadas.','UPDATE','INTERNAL');
    end if;
  end if;
  insert into plataforma_auditoria(ator_id,ator_tipo,acao,entidade,entidade_id,detalhes)
  values(case when TG_OP='DELETE' then old.atualizado_por else new.atualizado_por end,'superadmin','desenvolvimento.'||lower(TG_OP),'desenvolvimento_demandas',case when TG_OP='DELETE' then old.id::text else new.id::text end,
    jsonb_build_object('antes',case when TG_OP<>'INSERT' then to_jsonb(old)-'nota_interna'-'link_tecnico' else null end,'depois',case when TG_OP<>'DELETE' then to_jsonb(new)-'nota_interna'-'link_tecnico' else null end));
  return null;
end $$;
create trigger desenvolvimento_registrar after insert or update or delete on public.desenvolvimento_demandas for each row execute function public.desenvolvimento_registrar();

create function public.desenvolvimento_tocar_atualizacao() returns trigger language plpgsql set search_path=public as $$
begin
  -- Históricos automáticos já pertencem a uma alteração da demanda.
  if pg_trigger_depth()=1 then
    update desenvolvimento_demandas set atualizado_por=new.autor where id=new.demanda_id;
  end if;
  return null;
end $$;
create trigger desenvolvimento_tocar_atualizacao after insert on public.desenvolvimento_demanda_atualizacoes for each row execute function public.desenvolvimento_tocar_atualizacao();

-- Delete com autor e controle otimista. Só service_role pode executar.
create function public.desenvolvimento_excluir(p_id uuid,p_versao integer,p_autor uuid) returns boolean language plpgsql set search_path=public as $$
begin
  update desenvolvimento_demandas set atualizado_por=p_autor where id=p_id and versao=p_versao;
  if not found then return false; end if;
  delete from desenvolvimento_demandas where id=p_id;
  return true;
end $$;
revoke all on function public.desenvolvimento_excluir(uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.desenvolvimento_excluir(uuid,integer,uuid) to service_role;
revoke all on function public.desenvolvimento_preparar(), public.desenvolvimento_registrar(), public.desenvolvimento_transferir_escopo(), public.desenvolvimento_tocar_atualizacao() from public,anon,authenticated;
commit;
