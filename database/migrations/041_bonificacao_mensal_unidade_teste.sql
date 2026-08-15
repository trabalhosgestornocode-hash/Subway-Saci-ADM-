-- =====================================================================
-- MIGRATION 041 — Unidade de teste dedicada para a Bonificação Mensal
-- =====================================================================
-- POR QUE ESTA MIGRATION EXISTE
--   backend/test/bonificacao-mensal-service.test.js rodava contra a unidade
--   REAL da Subway Saci (SACI_UNIDADE_ID = 00000000-0000-0000-0000-
--   0000000000a1), usando a data 2026-08-01 como "data de teste" — segura
--   quando o arquivo foi escrito (mês ainda não tinha chegado), mas deixou
--   de ser segura quando agosto/2026 virou o mês corrente: o comando padrão
--   `npm test` carrega o MESMO .env de produção (não existe banco de teste
--   separado), então toda vez que a suíte roda, ela grava um lançamento
--   fake e DEPOIS APAGA (limparDadosDeTeste) o lançamento real do dia 1º
--   que o usuário tivesse importado — bug reportado como "a bonificação do
--   dia 1º de agosto pede pra ser preenchida de novo".
--
--   Esta migration cria uma unidade PERMANENTE de teste (eh_teste = true),
--   mesmo padrão da migration 025 (Loja Florianópolis-SC 1/2/3), com metas
--   idênticas às da Subway Saci — para os testes automatizados terem seu
--   próprio unidade_id e NUNCA mais tocarem em bonificacao_lancamentos_diarios
--   nem bonificacao_importacoes da unidade real.
--
--   O NOME contém o token "Saci" de propósito: mesmaUnidadeVisio() (ver
--   bonificacaoMensal.calc.js) valida o PDF da Visio pelo token distintivo
--   em comum com o nome da unidade — os PDFs de fixture do teste dizem
--   "Subway Saci", então a unidade de teste precisa compartilhar esse token
--   para o teste de fluxo completo continuar validando de verdade.
--
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- NADA na Subway Saci real é alterado — só adiciona uma unidade nova.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. UNIDADE DE TESTE
-- ---------------------------------------------------------------------
-- ID fixo (não gen_random_uuid()) de propósito: o arquivo de teste
-- (backend/test/bonificacao-mensal-service.test.js) precisa referenciar
-- este id como constante, igual já faz com SACI_UNIDADE_ID (...a1) e
-- OUTRA_UNIDADE_ID (Florianópolis-SC 1) — sem isso, o teste teria que
-- descobrir o id em runtime toda vez.
insert into unidades (id, organizacao_id, nome, eh_teste, modelo_logistico_ifood)
select '00000000-0000-0000-0000-0000000000b1'::uuid, '00000000-0000-0000-0000-000000000001'::uuid,
  'Loja Saci — Teste Automatizado (Bonificação Mensal)', true, 'marketplace'::modelo_logistico_ifood_enum
where not exists (
  select 1 from unidades u where u.id = '00000000-0000-0000-0000-0000000000b1'::uuid
);

-- ---------------------------------------------------------------------
-- 2. VÍNCULO do usuário de desenvolvimento (mesmo padrão da migration 025)
--    — opcional para os testes automatizados (o service roda com
--    service_role e ignora RLS), mas permite também testar manualmente
--    pela UI sem tocar em dado real.
-- ---------------------------------------------------------------------
do $$
declare
  v_usuario_id uuid;
  v_unidade_teste_id uuid := '00000000-0000-0000-0000-0000000000b1';
begin
  select id into v_usuario_id from auth.users where email = 'projetospeu@gmail.com';

  if v_usuario_id is not null then
    insert into usuarios_unidades (usuario_id, unidade_id, papel)
    values (v_usuario_id, v_unidade_teste_id, null)
    on conflict (usuario_id, unidade_id) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. METAS — réplica exata das 11 metas semeadas para a Subway Saci na
--    migration 028 (mesmos indicadores/faixas/valid_from), agora para a
--    unidade de teste. Copia literal, de propósito: os testes existentes
--    já fazem asserts em cima destes valores (ex.: bebidas -> [25,50,75]).
-- ---------------------------------------------------------------------
create or replace function _bonificacao_seed_meta_041(
  p_unidade_id uuid, p_organizacao_id uuid, p_indicador text,
  p_direcao bonificacao_direcao_enum, p_valid_from date
) returns uuid as $f$
declare v_id uuid;
begin
  select id into v_id from bonificacao_metas
    where unidade_id = p_unidade_id and indicador = p_indicador and valid_from = p_valid_from;
  if v_id is null then
    insert into bonificacao_metas (organizacao_id, unidade_id, indicador, direcao, valid_from, observacao)
      values (p_organizacao_id, p_unidade_id, p_indicador, p_direcao, p_valid_from,
              'Seed migration 041 — réplica das metas da Subway Saci para a unidade de teste da Bonificação Mensal')
      returning id into v_id;
  end if;
  return v_id;
end;
$f$ language plpgsql;

do $$
declare
  v_unidade_id uuid := '00000000-0000-0000-0000-0000000000b1';
  v_organizacao_id uuid := '00000000-0000-0000-0000-000000000001'::uuid;
  v_meta_id uuid;
  v_valid_from date := '2026-08-01';
begin
  if not exists (select 1 from unidades where id = v_unidade_id) then
    raise notice 'Migration 041: unidade de teste não encontrada — seed de metas pulado.';
    return;
  end if;

  v_meta_id := _bonificacao_seed_meta_041(v_unidade_id, v_organizacao_id, 'faturamento', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, bonus) values
    (v_meta_id, 1, 'limite_minimo', 334193.85, 100.00),
    (v_meta_id, 2, 'limite_minimo', 350903.54, 150.00),
    (v_meta_id, 3, 'limite_minimo', 367613.24, 200.00)
  on conflict (meta_id, ordem) do nothing;

  v_meta_id := _bonificacao_seed_meta_041(v_unidade_id, v_organizacao_id, 'bebidas', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, bonus) values
    (v_meta_id, 1, 'limite_minimo', 40, 25.00),
    (v_meta_id, 2, 'limite_minimo', 45, 50.00),
    (v_meta_id, 3, 'limite_minimo', 52, 75.00)
  on conflict (meta_id, ordem) do nothing;

  v_meta_id := _bonificacao_seed_meta_041(v_unidade_id, v_organizacao_id, 'adicionais', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, bonus) values
    (v_meta_id, 1, 'limite_minimo', 20, 25.00),
    (v_meta_id, 2, 'limite_minimo', 25, 50.00),
    (v_meta_id, 3, 'limite_minimo', 30, 75.00)
  on conflict (meta_id, ordem) do nothing;

  v_meta_id := _bonificacao_seed_meta_041(v_unidade_id, v_organizacao_id, 'diversos', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, bonus) values
    (v_meta_id, 1, 'limite_minimo', 20, 25.00),
    (v_meta_id, 2, 'limite_minimo', 28, 50.00),
    (v_meta_id, 3, 'limite_minimo', 38, 75.00)
  on conflict (meta_id, ordem) do nothing;

  v_meta_id := _bonificacao_seed_meta_041(v_unidade_id, v_organizacao_id, 'cmv', 'lower_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, valor_max, bonus) values
    (v_meta_id, 1, 'intervalo', 29.0, 30.0, 100.00),
    (v_meta_id, 2, 'intervalo', 28.1, 28.9, 150.00),
    (v_meta_id, 3, 'limite_maximo', null, 28.0, 200.00)
  on conflict (meta_id, ordem) do nothing;

  v_meta_id := _bonificacao_seed_meta_041(v_unidade_id, v_organizacao_id, 'ticket_medio', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, bonus) values
    (v_meta_id, 1, 'limite_minimo', 48, 100.00),
    (v_meta_id, 2, 'limite_minimo', 50, 150.00),
    (v_meta_id, 3, 'limite_minimo', 53, 200.00)
  on conflict (meta_id, ordem) do nothing;

  v_meta_id := _bonificacao_seed_meta_041(v_unidade_id, v_organizacao_id, 'rev', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, bonus) values
    (v_meta_id, 1, 'limite_minimo', 80, 0.00),
    (v_meta_id, 2, 'limite_minimo', 90, 50.00),
    (v_meta_id, 3, 'limite_minimo', 100, 100.00)
  on conflict (meta_id, ordem) do nothing;

  v_meta_id := _bonificacao_seed_meta_041(v_unidade_id, v_organizacao_id, 'pesquisas', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, valor_max, bonus) values
    (v_meta_id, 1, 'intervalo', 0, 89, 0.00),
    (v_meta_id, 2, 'limite_minimo', 90, null, 50.00),
    (v_meta_id, 3, 'limite_minimo', 120, null, 100.00)
  on conflict (meta_id, ordem) do nothing;

  v_meta_id := _bonificacao_seed_meta_041(v_unidade_id, v_organizacao_id, 'avaliacao_ifood', 'higher_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_min, bonus) values
    (v_meta_id, 1, 'limite_minimo', 4.7, null)
  on conflict (meta_id, ordem) do nothing;

  v_meta_id := _bonificacao_seed_meta_041(v_unidade_id, v_organizacao_id, 'cancelamentos', 'lower_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_max, bonus) values
    (v_meta_id, 1, 'limite_maximo', 1.0, null)
  on conflict (meta_id, ordem) do nothing;

  v_meta_id := _bonificacao_seed_meta_041(v_unidade_id, v_organizacao_id, 'pedidos_chamado', 'lower_is_better', v_valid_from);
  insert into bonificacao_metas_faixas (meta_id, ordem, tipo, valor_max, bonus) values
    (v_meta_id, 1, 'limite_maximo', 2.5, null)
  on conflict (meta_id, ordem) do nothing;
end $$;

drop function if exists _bonificacao_seed_meta_041(uuid, uuid, text, bonificacao_direcao_enum, date);
