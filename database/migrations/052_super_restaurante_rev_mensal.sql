-- =====================================================================
-- MIGRATION 052 — Super Restaurante: REV vira MENSAL + critérios de
-- elegibilidade (Nota iFood / REV / Pesquisas)
-- =====================================================================
-- POR QUE ESTA MIGRATION EXISTE
--   Reformulação da Bonificação Mensal em "Super Restaurante" (pedido do
--   usuário). Ponto obrigatório: REV deixa de ser um valor por DIA
--   (mediaDiaria() de bonificacao_lancamentos_diarios.rev_nota — errado,
--   REV é publicado uma vez por competência) e passa a ser um valor por
--   MÊS (unidade + ano + mês = 1 registro).
--
--   Isto NÃO é a mesma mudança das migrations 042/043 (que tentou e
--   reverteu tabela mensal pra REV **e mais 3 indicadores** — Pesquisas,
--   Nota iFood e Pedidos com Chamado continuavam precisando de
--   acompanhamento DIÁRIO real, e continuam). Desta vez é só REV, e é
--   definitivo: REV não é uma contagem que cresce dia a dia como
--   Pesquisas, é uma nota publicada pela operação uma vez por competência
--   — manter um "dia" artificial pra pendurar esse valor nunca fez sentido
--   de negócio, só de schema.
--
-- SEGURANÇA DO DADO — verificado ANTES de escrever esta migration:
--   select count(*) from bonificacao_lancamentos_diarios where rev_nota is
--   not null  →  0 (zero) linhas em todo o banco, em qualquer unidade,
--   organização ou competência. Não existe hoje nenhum mês fechado cujo
--   resultado de bonificação tenha sido calculado com um REV real — o
--   valor sempre foi null. Por isso:
--     * a coluna `rev_nota` NÃO é removida (dado morto é mais barato que
--       schema irreversível — mesmo princípio já usado nas migrations
--       028/042/043);
--     * mesmo assim, a seção 2 abaixo faz um backfill defensivo — SE em
--       algum ambiente existir rev_nota preenchido (um restore de backup,
--       um ambiente que eu não consultei), o dado não se perde: para cada
--       unidade+competência com um ou mais rev_nota, o valor do ÚLTIMO DIA
--       lançado no mês vira o registro mensal (é o valor mais
--       corrigido/atualizado que existiu pra aquele mês — mesma lógica de
--       "a correção mais recente é a que vale"). Roda uma vez, é
--       idempotente (on conflict do nothing).
--
-- FAIXAS DE REV E PESQUISAS — de "bônus parcial em 3 faixas" para "critério
--   obrigatório de tudo ou nada" (itens 4-6 do pedido: "não faça cálculo
--   parcial... a punição é integral"). Isto é uma mudança de REGRA DE
--   NEGÓCIO, não só de leitura — por isso entra em migration, não só no
--   código: a partir de agora REV (mínimo 80) e Pesquisas (mínimo 60) têm
--   UMA faixa cada (limite_minimo, bonus NULL — "sem valor de bonificação
--   parcial", igual ao padrão que Nota iFood/avaliacao_ifood já usa desde a
--   migration 028). Nota iFood já era 1 faixa com mínimo 4,7 e bonus NULL —
--   não muda nada aqui, só passa a ser lida pelo motor de elegibilidade.
--
--   Zero risco de perda de dado real aqui também: nenhuma organização tem
--   um mês FECHADO cujo resultado de bonificação dependeu de REV ou
--   Pesquisas em faixas — REV nunca teve dado, e o único mês com Pesquisas
--   real (Subway North Shopping, ago/2026) ainda está ABERTO hoje (nunca
--   foi exibido como resultado final de um mês fechado).
--
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABELA bonificacao_rev_mensal — unidade + ano + mês = 1 registro.
-- ---------------------------------------------------------------------
create table if not exists bonificacao_rev_mensal (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  unidade_id uuid not null references unidades(id) on delete cascade,
  ano int not null check (ano between 2000 and 2100),
  mes int not null check (mes between 1 and 12),
  valor numeric(6,2) not null check (valor >= 0),

  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,

  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),

  unique (unidade_id, ano, mes)
);
create index if not exists idx_brm_unidade on bonificacao_rev_mensal(unidade_id, ano desc, mes desc);
create index if not exists idx_brm_org on bonificacao_rev_mensal(organizacao_id);

-- Reaproveita a function já criada pela migration 028 (não foi dropada —
-- só o trigger da malfadada tabela mensal 042 foi, junto com a tabela).
drop trigger if exists trg_brm_upd on bonificacao_rev_mensal;
create trigger trg_brm_upd before update on bonificacao_rev_mensal
  for each row execute function bonificacao_set_atualizado_em();

alter table bonificacao_rev_mensal enable row level security;
drop policy if exists rls_bonificacao_rev_mensal_tenant on bonificacao_rev_mensal;
create policy rls_bonificacao_rev_mensal_tenant on bonificacao_rev_mensal
  for all to authenticated
  using (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin())
  with check (unidade_id in (select auth_unidade_ids()) or is_platform_superadmin());

-- ---------------------------------------------------------------------
-- 2. BACKFILL DEFENSIVO — ver nota de segurança acima. No-op neste banco
--    (rev_nota está 100% vazio), mas protege qualquer ambiente que eu não
--    tenha consultado diretamente.
-- ---------------------------------------------------------------------
insert into bonificacao_rev_mensal (organizacao_id, unidade_id, ano, mes, valor, usuario_id, usuario_nome)
select distinct on (unidade_id, extract(year from data)::int, extract(month from data)::int)
  organizacao_id, unidade_id,
  extract(year from data)::int as ano, extract(month from data)::int as mes,
  rev_nota, usuario_id, usuario_nome
from bonificacao_lancamentos_diarios
where rev_nota is not null
order by unidade_id, extract(year from data)::int, extract(month from data)::int, data desc
on conflict (unidade_id, ano, mes) do nothing;

-- ---------------------------------------------------------------------
-- 3. FAIXAS DE REV E PESQUISAS — de bônus parcial em 3 faixas pra critério
--    obrigatório de tudo-ou-nada (1 faixa, sem bônus). Aplica em TODAS as
--    unidades que já têm meta desses indicadores (não só a Subway Saci) —
--    é mudança de regra de negócio, não correção de dado de uma loja.
-- ---------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select m.id as meta_id, m.indicador
    from bonificacao_metas m
    where m.indicador in ('rev', 'pesquisas')
  loop
    delete from bonificacao_metas_faixas where meta_id = r.meta_id;
    insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, valor_max, bonus)
    values (r.meta_id, 1, 'limite_minimo', case r.indicador when 'rev' then 80 when 'pesquisas' then 60 end, null, null);
  end loop;
end $$;

-- =====================================================================
-- VERIFICAÇÃO (rode separadamente):
--   select u.nome, m.indicador, f.valor_min, f.bonus
--   from bonificacao_metas m
--   join unidades u on u.id = m.unidade_id
--   join bonificacao_metas_faixas f on f.meta_id = m.id
--   where m.indicador in ('rev', 'pesquisas', 'avaliacao_ifood')
--   order by u.nome, m.indicador;
--   -- esperado: 1 linha por indicador/unidade, bonus sempre null,
--   -- valor_min = 80 (rev) / 60 (pesquisas) / 4.7 (avaliacao_ifood, já
--   -- estava assim desde a 028).
-- =====================================================================
