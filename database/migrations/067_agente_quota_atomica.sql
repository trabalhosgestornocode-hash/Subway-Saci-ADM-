-- =====================================================================
-- MIGRATION 067 — Agente Crescer: reserva ATÔMICA de quota (org + conta + perfil)
-- =====================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO SEM APROVAÇÃO EXPLÍCITA.
--
--     Nada aqui QUEBRA o backend anterior:
--       * as estruturas são ADITIVAS (tabela + função novas);
--       * o backend da Fase P0.2 degrada graciosamente se a função não
--         existir ainda — cai no CONTADOR BEST-EFFORT anterior (COUNT em
--         agente_uso) e loga um aviso. Só DEPOIS desta migration aplicada é
--         que a reserva vira atômica e o fail-closed passa a valer de verdade.
--
-- PROBLEMA QUE RESOLVE (achado do Codex na revisão da Fase P0)
--   O teto do Agente por organização era: COUNT -> verifica -> chama Claude ->
--   registra. Chamadas concorrentes leem a MESMA contagem e passam JUNTAS pelo
--   limite (TOCTOU). Com 10 requisições simultâneas e 1 vaga, as 10 passavam.
--
-- COMO RESOLVE
--   Uma função que, numa ÚNICA transação, incrementa os contadores de TODOS os
--   escopos (organização, conta, perfil) e, se QUALQUER um passar do limite,
--   levanta exceção -> a transação inteira faz ROLLBACK -> NENHUM contador é
--   consumido -> o backend responde 429. Sem SELECT-then-check: o INSERT ...
--   ON CONFLICT DO UPDATE ... RETURNING é atômico por linha, e o loop dentro
--   da mesma transação garante o "tudo ou nada".
--
-- JANELA
--   Janela FIXA (tumbling), não deslizante — precisão suficiente para proteção
--   contra abuso e trivial de fazer atômica. Cada (escopo, chave,
--   janela_segundos, janela_inicio) é uma linha. `janela_inicio` = início do
--   balde: floor(epoch / janela) * janela.
--
-- SEGURANÇA DA FUNÇÃO (respostas às perguntas do pedido)
--   * quem executa: SOMENTE o backend (service_role). `revoke ... from anon,
--     authenticated` — um cliente jamais chama isto.
--   * SECURITY INVOKER (padrão), NÃO definer: só o service_role chama, e ele
--     já tem acesso pleno. Se um dia a função for concedida a `authenticated`
--     por engano, o RLS deny-by-default de `agente_quota_uso` faz o INSERT
--     FALHAR — modo de falha seguro. DEFINER faria o oposto (deixaria escrever).
--   * search_path fixado (= public) — sem hijack.
--   * tenant arbitrário pelo cliente: IMPOSSÍVEL — a função só recebe UUIDs e
--     incrementa um contador; não lê nem devolve dado de tenant nenhum. E o
--     backend só passa valores VINDOS DA SESSÃO (req.tenant.organizacaoId /
--     req.user.id / req.perfil.id), nunca do corpo da requisição.
--   * `escopo` é validado contra a lista fechada ('org','conta','perfil').
--
-- IDEMPOTENTE (if not exists / create or replace). TRANSACIONAL.
-- COMO USAR: Supabase -> SQL Editor -> cole o arquivo inteiro.
--   NÃO executar em produção sem aprovação explícita.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Tabela de contadores (baldes de janela fixa)
-- ---------------------------------------------------------------------
create table if not exists agente_quota_uso (
  escopo           text        not null check (escopo in ('org', 'conta', 'perfil')),
  chave            uuid        not null,   -- organizacao_id | conta_id | perfil_id
  janela_segundos  integer     not null check (janela_segundos > 0),
  janela_inicio    timestamptz not null,  -- início do balde (tumbling)
  consumido        integer     not null default 0 check (consumido >= 0),
  atualizado_em    timestamptz not null default now(),
  primary key (escopo, chave, janela_segundos, janela_inicio)
);

comment on table agente_quota_uso is
  'Contadores de janela fixa da quota do Agente Crescer (Fase P0.2). Uma linha '
  'por (escopo, chave, tamanho-da-janela, balde). Escrita SÓ via '
  'agente_reservar_quota(), que é atômica. Limpeza oportunista de baldes '
  'antigos dentro da própria função.';

-- Índice para a limpeza oportunista não fazer scan.
create index if not exists ix_agente_quota_uso_janela on agente_quota_uso (janela_inicio);

-- RLS deny-by-default (padrão do projeto: backend usa service_role e ignora
-- RLS; ninguém mais lê/escreve). Sem policy = ninguém além de service_role.
alter table agente_quota_uso enable row level security;

-- ---------------------------------------------------------------------
-- 2. Função de RESERVA ATÔMICA
-- ---------------------------------------------------------------------
-- p_reservas: jsonb array de objetos
--   { "escopo": "org"|"conta"|"perfil", "chave": "<uuid>",
--     "janela_segundos": <int>, "limite": <int> }
--
-- Efeito: incrementa +1 cada contador. Se QUALQUER um ficar > limite, levanta
-- exceção 'AGENTE_QUOTA_EXCEDIDA:<escopo>' -> ROLLBACK de TODOS os incrementos.
-- Sucesso: devolve o mapa escopo -> consumido (para observabilidade/headers).
create or replace function agente_reservar_quota(p_reservas jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  r            jsonb;
  v_escopo     text;
  v_chave      uuid;
  v_janela     integer;
  v_limite     integer;
  v_inicio     timestamptz;
  v_consumido  integer;
  v_resultado  jsonb := '{}'::jsonb;
begin
  if p_reservas is null or jsonb_typeof(p_reservas) <> 'array' or jsonb_array_length(p_reservas) = 0 then
    raise exception 'AGENTE_QUOTA_RESERVAS_INVALIDAS';
  end if;

  -- Limpeza oportunista (2% das chamadas) — mantém a tabela pequena sem cron.
  if random() < 0.02 then
    delete from agente_quota_uso where janela_inicio < now() - interval '2 days';
  end if;

  for r in select value from jsonb_array_elements(p_reservas)
  loop
    v_escopo := r->>'escopo';
    if v_escopo not in ('org', 'conta', 'perfil') then
      raise exception 'AGENTE_QUOTA_ESCOPO_INVALIDO:%', coalesce(v_escopo, 'null');
    end if;
    v_chave  := (r->>'chave')::uuid;
    v_janela := (r->>'janela_segundos')::integer;
    v_limite := (r->>'limite')::integer;
    if v_chave is null or v_janela is null or v_janela <= 0 or v_limite is null or v_limite <= 0 then
      raise exception 'AGENTE_QUOTA_PARAMETRO_INVALIDO:%', v_escopo;
    end if;

    v_inicio := to_timestamp(floor(extract(epoch from clock_timestamp()) / v_janela) * v_janela);

    insert into agente_quota_uso (escopo, chave, janela_segundos, janela_inicio, consumido)
      values (v_escopo, v_chave, v_janela, v_inicio, 1)
      on conflict (escopo, chave, janela_segundos, janela_inicio)
      do update set consumido = agente_quota_uso.consumido + 1, atualizado_em = now()
      returning consumido into v_consumido;

    if v_consumido > v_limite then
      -- ROLLBACK implícito de TODOS os incrementos deste loop (mesma transação).
      raise exception 'AGENTE_QUOTA_EXCEDIDA:%', v_escopo
        using detail = format('consumido=%s limite=%s janela=%ss', v_consumido, v_limite, v_janela);
    end if;

    v_resultado := v_resultado || jsonb_build_object(
      v_escopo, jsonb_build_object(
        'consumido', v_consumido,
        'limite', v_limite,
        'restante', greatest(0, v_limite - v_consumido),
        'janela_inicio', v_inicio,
        'janela_segundos', v_janela
      )
    );
  end loop;

  return v_resultado;
end;
$$;

comment on function agente_reservar_quota(jsonb) is
  'Fase P0.2 — reserva ATÔMICA de quota do Agente Crescer em N escopos ao mesmo '
  'tempo (org/conta/perfil). Incrementa todos; se um passar do limite, ROLLBACK '
  'de todos e exceção AGENTE_QUOTA_EXCEDIDA:<escopo>. Chamada SÓ pelo backend '
  '(service_role). Não lê dado de tenant; recebe só UUIDs da sessão.';

-- Ninguém além do backend chama isto.
revoke all on function agente_reservar_quota(jsonb) from anon, authenticated;

commit;

-- =====================================================================
-- PÓS-CHECK (rode depois; nada aqui escreve)
-- =====================================================================
--   select to_regclass('public.agente_quota_uso');
--   select proname, prosecdef from pg_proc where proname = 'agente_reservar_quota';
--   -- teste rápido (1 vaga, 2 tentativas -> a 2ª estoura):
--   select agente_reservar_quota('[{"escopo":"org","chave":"00000000-0000-0000-0000-000000000001","janela_segundos":3600,"limite":1}]');
--   select agente_reservar_quota('[{"escopo":"org","chave":"00000000-0000-0000-0000-000000000001","janela_segundos":3600,"limite":1}]'); -- deve dar AGENTE_QUOTA_EXCEDIDA:org
--   delete from agente_quota_uso where chave = '00000000-0000-0000-0000-000000000001';
--
-- =====================================================================
-- ROLLBACK (nada aqui é destrutivo de dados de negócio)
-- =====================================================================
--   begin;
--   drop function if exists agente_reservar_quota(jsonb);
--   drop table if exists agente_quota_uso;
--   commit;
-- =====================================================================
