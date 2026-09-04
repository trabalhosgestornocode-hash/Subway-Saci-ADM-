-- =====================================================================
-- MIGRATION 068 — Desbloqueio administrativo de dias do Dashboard iFood
-- =====================================================================
-- OBJETIVO
--   O Dashboard iFood fecha o dia de forma SEQUENCIAL e ancorada em D-1
--   (ver dashboardExecutivo.calc.js#statusMes e
--   dashboardExecutivo.service.js#financeiroDisponivelNaData):
--
--     * a etapa FINANCEIRO só é oferecida quando a data lançada é
--       exatamente ONTEM — o extrato do iFood de um dia só existe no dia
--       seguinte;
--     * um dia sem lançamento BLOQUEIA os seguintes (STATUS_DIA.BLOQUEADO)
--       — o Financeiro é um snapshot ACUMULADO do mês, então preencher
--       fora de ordem corrompe a série de deltas.
--
--   As duas regras são deliberadas e continuam sendo o comportamento
--   PADRÃO. O problema que esta migration resolve é o beco sem saída: uma
--   unidade que deixou de lançar por alguns dias perde o Financeiro
--   daqueles dias PARA SEMPRE — eles nunca voltam a ser "ontem" e ficam
--   travados atrás da sequência, sem nenhum caminho de regularização.
--
--   Esta tabela é a EXCEÇÃO EXPLÍCITA e AUDITÁVEL: o Painel Administrativo
--   da Crescer libera UMA data de UMA unidade, e só isso.
--
-- O QUE UM DESBLOQUEIO FAZ
--   Concede permissão para que aquele dia possa ser preenchido:
--     * a etapa Financeiro passa a ser oferecida naquela data;
--     * aquela data deixa de ser BLOQUEADA pela sequência.
--
-- O QUE UM DESBLOQUEIO **NÃO** FAZ (invariante do produto)
--   Não cria lançamento, não preenche valor, não copia dado de outro dia,
--   não pula validação de campo, não marca o dia como concluído e não tira
--   o dia da lista de pendências do painel. Um dia liberado e ainda vazio
--   continua PENDENTE — a unidade ainda precisa entrar e preencher.
--
-- GRANULARIDADE (nunca global)
--   organizacao_id + unidade_id + data_referencia + tipo. Liberar 02/09 da
--   Unidade 1 não libera 03/09, nem a Unidade 2, nem outra empresa, nem
--   nenhum outro módulo (Desempenho, Bonificação, Parser seguem intactos).
--
-- ISOLAMENTO MULTI-TENANT
--   `organizacao_id` NUNCA vem do cliente: o backend o deriva da própria
--   unidade (administrativo.repo.js#listarUnidadesElegiveis), então uma
--   linha não consegue apontar para a empresa "errada". A leitura no
--   Dashboard iFood filtra sempre por `unidade_id` — o mesmo id que o
--   Context Token já resolveu. Sem RLS própria, igual a `unidade_config`
--   (058) e `plataforma_auditoria`: o acesso é service_role e a
--   autorização vive no middleware (`requirePainelAdministrativo`).
--
-- HISTÓRICO / AUDITORIA
--   Revogar NÃO apaga a linha: muda `status` para 'revogado' e carimba
--   quem/quando. O histórico do dia (bloqueado -> liberado -> lançado ->
--   regularizado) fica reconstituível. O espelho geral da ação também vai
--   para `plataforma_auditoria` (ACOES.IFOOD_DESBLOQUEIO_*).
--
-- NÃO DESTRUTIVO / IDEMPOTENTE / REVERSÍVEL.
--   - Tabela nova e vazia. Ausência de linha = regra D-1 pura (hoje).
--   - Nenhuma alteração em tabela existente.
--
-- IMPACTO NOS DADOS ATUAIS: nenhum.
--
-- ROLLBACK:
--     drop table if exists dashboard_ifood_desbloqueios;
--   (o sistema volta exatamente ao comportamento anterior: só D-1.)
--
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
--   NÃO executar automaticamente em produção.
-- =====================================================================

create table if not exists dashboard_ifood_desbloqueios (
  id               uuid primary key default gen_random_uuid(),
  organizacao_id   uuid not null references organizacoes(id) on delete cascade,
  unidade_id       uuid not null references unidades(id)     on delete cascade,
  data_referencia  date not null,
  -- Aberto a novos tipos de liberação sem nova migration; hoje só existe um.
  -- O código usa a constante TIPO_DESBLOQUEIO (administrativo.desbloqueios.js).
  tipo             text not null default 'financeiro_dashboard_ifood'
                     check (tipo in ('financeiro_dashboard_ifood')),
  motivo           text not null check (length(btrim(motivo)) between 1 and 80),
  observacao       text check (observacao is null or length(observacao) <= 500),
  status           text not null default 'ativo' check (status in ('ativo', 'revogado')),

  criado_por       uuid,          -- auth.users.id; sem FK (sobrevive à exclusão da conta)
  criado_por_nome  text,
  criado_por_email text,
  criado_em        timestamptz not null default now(),

  revogado_por      uuid,
  revogado_por_nome text,
  revogado_em       timestamptz,

  -- Coerência do ciclo de vida: 'revogado' exige carimbo; 'ativo' não pode tê-lo.
  constraint dashboard_ifood_desbloqueios_revogacao_coerente check (
    (status = 'ativo'    and revogado_em is null and revogado_por is null) or
    (status = 'revogado' and revogado_em is not null)
  )
);

-- REGRA CENTRAL DE INTEGRIDADE: no máximo UM desbloqueio ATIVO por
-- (empresa, unidade, data, tipo). Índice PARCIAL — revogados não competem,
-- então a mesma data pode ser liberada de novo depois de uma revogação, e o
-- histórico inteiro continua na tabela.
create unique index if not exists dashboard_ifood_desbloqueios_ativo_unico
  on dashboard_ifood_desbloqueios (organizacao_id, unidade_id, data_referencia, tipo)
  where status = 'ativo';

-- Caminho quente: o Dashboard iFood pergunta "quais datas desta unidade
-- estão liberadas neste mês?" a cada carregamento de calendário.
create index if not exists dashboard_ifood_desbloqueios_unidade_data
  on dashboard_ifood_desbloqueios (unidade_id, data_referencia)
  where status = 'ativo';

-- Caminho do painel: listar o histórico (ativos E revogados) de uma unidade.
create index if not exists dashboard_ifood_desbloqueios_unidade_hist
  on dashboard_ifood_desbloqueios (unidade_id, data_referencia, criado_em desc);

comment on table dashboard_ifood_desbloqueios is
  'Exceção administrativa por DATA que libera o lançamento financeiro de um dia do Dashboard iFood travado pela regra D-1/sequência. Nunca preenche nada: só concede permissão. Revogar muda status, nunca apaga (histórico de auditoria).';
comment on column dashboard_ifood_desbloqueios.organizacao_id  is 'Empresa dona da unidade. Derivada da unidade pelo backend, nunca recebida do cliente.';
comment on column dashboard_ifood_desbloqueios.data_referencia is 'O DIA liberado (data_lancamento do Dashboard iFood). Granularidade máxima: uma linha = um dia.';
comment on column dashboard_ifood_desbloqueios.tipo            is 'Que tipo de trava esta liberação levanta. Hoje só o financeiro do Dashboard iFood.';
comment on column dashboard_ifood_desbloqueios.motivo          is 'Motivo canônico escolhido no painel (dia_nao_lancado, falha_operacional, dados_posteriores, correcao_administrativa, outro).';
comment on column dashboard_ifood_desbloqueios.observacao      is 'Texto livre; obrigatório quando motivo = outro.';
comment on column dashboard_ifood_desbloqueios.status          is 'ativo = vale agora; revogado = histórico, não libera mais nada.';
