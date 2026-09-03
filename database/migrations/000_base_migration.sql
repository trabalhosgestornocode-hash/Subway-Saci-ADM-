/*
==========================================================================
CRESCER COM DELIVERY — MIGRATION BASE / BOOTSTRAP
==========================================================================
FINALIDADE:
  Criar o schema completo ATUAL em um banco NOVO e VAZIO, em UMA execução —
  equivalente a rodar schema.sql + migrations 001..067 em sequência, porém
  já no formato FINAL (sem reproduzir as transformações históricas nem os
  backfills de dados).

USAR EM:
  - Supabase de staging / teste
  - banco PostgreSQL local limpo
  - CI
  - desenvolvimento local
  - bootstrap / recuperação de desastre (banco novo)

NÃO USAR:
  - como migration de UPGRADE em produção. A produção continua com as
    migrations incrementais 001..067. Este arquivo NÃO deve ser registrado
    como migration aplicada em produção.
  - sobre um banco que já tem dados (não é idempotente para reexecução).

PRÉ-REQUISITOS (fornecidos pelo Supabase; num Postgres puro, crie stubs):
  - extensão  pgcrypto
  - schema    auth      + tabela auth.users + funções auth.uid()/auth.role()/auth.jwt()
  - schema    storage   + tabela storage.buckets
  - roles     anon, authenticated, service_role

GERADO A PARTIR DO ESTADO FINAL DAS MIGRATIONS 001..067
  Fonte (git HEAD): f12b2f3
  Método: pg_dump --schema-only de um banco construído com
          schema.sql + todas as migrations, + seeds ESTRUTURAIS (catálogo de
          módulos, planos, config da plataforma, metas globais, buckets).
  Dados de NEGÓCIO (empresas/usuários/vendas/financeiro/produtos reais,
  iFood, Martin Brower) NÃO entram — o banco resultante é funcional e vazio
  de clientes.

RLS: reflete EXATAMENTE o estado atual (enable + policies). NÃO houve
  redesenho — RLS será tratada em fase separada.

MIGRATION 067 (quota atômica do Agente): o REVOKE de PUBLIC e o GRANT a
  service_role estão reafirmados explicitamente no final deste arquivo.
==========================================================================
*/

set statement_timeout = 0;
set lock_timeout = 0;
set client_encoding = 'UTF8';
set standard_conforming_strings = on;
set check_function_bodies = false;
set client_min_messages = warning;
set row_security = off;

create extension if not exists pgcrypto;

-- ========================================================================
-- SCHEMA (estado final consolidado — gerado por pg_dump --schema-only)
-- ========================================================================
--

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: bonificacao_direcao_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.bonificacao_direcao_enum AS ENUM (
    'higher_is_better',
    'lower_is_better'
);


--
-- Name: bonificacao_faixa_tipo_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.bonificacao_faixa_tipo_enum AS ENUM (
    'limite_minimo',
    'limite_maximo',
    'intervalo'
);


--
-- Name: bonificacao_tipo_relatorio_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.bonificacao_tipo_relatorio_enum AS ENUM (
    'geral',
    'loja'
);


--
-- Name: canal; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.canal AS ENUM (
    'balcao',
    'ifood',
    'uber',
    'app',
    'outro'
);


--
-- Name: canal_notificacao; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.canal_notificacao AS ENUM (
    'whatsapp',
    'email',
    'sistema'
);


--
-- Name: ciclo_cobranca; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ciclo_cobranca AS ENUM (
    'mensal',
    'anual'
);


--
-- Name: forma_pagamento; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.forma_pagamento AS ENUM (
    'dinheiro',
    'credito',
    'debito',
    'pix',
    'ifood',
    'voucher',
    'outro'
);


--
-- Name: modelo_logistico_ifood_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.modelo_logistico_ifood_enum AS ENUM (
    'marketplace',
    'full_service'
);


--
-- Name: origem_lancamento_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.origem_lancamento_enum AS ENUM (
    'diario',
    'distribuicao_mensal'
);


--
-- Name: papel_acesso; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.papel_acesso AS ENUM (
    'platform_superadmin',
    'organization_admin',
    'unit_manager',
    'finance',
    'operations',
    'viewer'
);


--
-- Name: papel_usuario; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.papel_usuario AS ENUM (
    'admin',
    'gerente',
    'operador',
    'financeiro',
    'desenvolvedor',
    'leitura'
);


--
-- Name: severidade_alerta; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.severidade_alerta AS ENUM (
    'info',
    'atencao',
    'critico'
);


--
-- Name: situacao_operacao_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.situacao_operacao_enum AS ENUM (
    'normal',
    'sem_operacao',
    'zero_vendas',
    'parcial'
);


--
-- Name: status_alerta; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.status_alerta AS ENUM (
    'novo',
    'lido',
    'resolvido',
    'ignorado'
);


--
-- Name: status_assinatura; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.status_assinatura AS ENUM (
    'trial',
    'ativa',
    'inadimplente',
    'cancelada'
);


--
-- Name: status_cobranca; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.status_cobranca AS ENUM (
    'pendente',
    'paga',
    'vencida',
    'cancelada',
    'estornada'
);


--
-- Name: status_lancamento_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.status_lancamento_enum AS ENUM (
    'rascunho',
    'finalizado'
);


--
-- Name: status_notificacao; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.status_notificacao AS ENUM (
    'pendente',
    'enviado',
    'falha'
);


--
-- Name: status_organizacao; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.status_organizacao AS ENUM (
    'ativa',
    'teste',
    'bloqueada',
    'suspensa',
    'cancelada'
);


--
-- Name: status_pedido; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.status_pedido AS ENUM (
    'rascunho',
    'enviado',
    'confirmado',
    'entregue_parcial',
    'entregue',
    'cancelado'
);


--
-- Name: status_venda; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.status_venda AS ENUM (
    'concluida',
    'cancelada',
    'pendente'
);


--
-- Name: tamanho_produto; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tamanho_produto AS ENUM (
    '15cm',
    '30cm',
    'salada',
    'unico'
);


--
-- Name: tipo_alerta; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_alerta AS ENUM (
    'estoque_critico',
    'ruptura_prevista',
    'cmv_alto',
    'margem_baixa',
    'desperdicio',
    'faturamento_baixo',
    'compra_necessaria',
    'anomalia',
    'vencimento_proximo'
);


--
-- Name: tipo_categoria; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_categoria AS ENUM (
    'produto',
    'insumo'
);


--
-- Name: tipo_divergencia; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_divergencia AS ENUM (
    'falta',
    'sobra',
    'avaria',
    'preco',
    'produto_errado'
);


--
-- Name: tipo_fornecedor; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_fornecedor AS ENUM (
    'distribuidora',
    'local',
    'outro'
);


--
-- Name: tipo_insumo; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_insumo AS ENUM (
    'proteina',
    'queijo',
    'molho',
    'vegetal',
    'pao',
    'embalagem',
    'bebida',
    'descartavel',
    'doce',
    'chips',
    'outro'
);


--
-- Name: tipo_movimentacao; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_movimentacao AS ENUM (
    'entrada_manual',
    'entrada_fornecedor',
    'saida_venda',
    'perda',
    'vencimento',
    'transferencia_saida',
    'transferencia_entrada',
    'ajuste_inventario'
);


--
-- Name: tipo_produto; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_produto AS ENUM (
    'sanduiche',
    'salada',
    'bebida',
    'sobremesa',
    'chips',
    'adicional',
    'acompanhamento',
    'combo',
    'submontagem',
    'outro'
);


--
-- Name: unidade_medida_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.unidade_medida_enum AS ENUM (
    'g',
    'kg',
    'ml',
    'l',
    'un',
    'fatia',
    'porcao',
    'folha'
);


--
-- Name: agente_conversas_set_atualizado_em(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agente_conversas_set_atualizado_em() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.atualizado_em = now();
  return new;
end;
$$;


--
-- Name: agente_reservar_quota(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agente_reservar_quota(p_reservas jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
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


--
-- Name: auth_organizacao_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_organizacao_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select organizacao_id from perfis where id = auth.uid();
$$;


--
-- Name: auth_organizacao_ids(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_organizacao_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select organizacao_id from usuarios_organizacoes
  where usuario_id = auth.uid() and ativo;
$$;


--
-- Name: auth_unidade_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_unidade_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select unidade_id from perfis where id = auth.uid();
$$;


--
-- Name: auth_unidade_ids(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_unidade_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select unidade_id from usuarios_unidades
  where usuario_id = auth.uid() and ativo;
$$;


--
-- Name: bloquear_alteracao_auditoria(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bloquear_alteracao_auditoria() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception
    'plataforma_auditoria é append-only: % não é permitido nesta tabela.', tg_op
    using errcode = 'insufficient_privilege';
end $$;


--
-- Name: bonificacao_set_atualizado_em(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bonificacao_set_atualizado_em() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.atualizado_em = now();
  return new;
end;
$$;


--
-- Name: converter_empresa_para_unidade(uuid, uuid, uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.converter_empresa_para_unidade(p_organizacao_id uuid, p_empresa_mae_id uuid, p_ator_id uuid, p_ator_email text DEFAULT NULL::text, p_ip text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_org_nome text;
  v_org_eh_modelo boolean;
  v_mae_nome text;
  v_mae_eh_modelo boolean;
  v_qtd_unidades int;
  v_nova_unidade_id uuid;
  v_qtd_modulos int := 0;
  v_qtd_vinculos_usuarios int := 0;
begin
  if p_organizacao_id = p_empresa_mae_id then
    raise exception 'A empresa não pode se tornar unidade de si mesma.' using errcode = '22023';
  end if;

  select nome, eh_modelo into v_org_nome, v_org_eh_modelo
    from organizacoes where id = p_organizacao_id for update;
  if v_org_nome is null then
    raise exception 'Empresa não encontrada.' using errcode = 'P0002';
  end if;
  if v_org_eh_modelo then
    raise exception 'Esta organização é um Modelo Padrão — não pode virar unidade.' using errcode = '22023';
  end if;

  select nome, eh_modelo into v_mae_nome, v_mae_eh_modelo
    from organizacoes where id = p_empresa_mae_id for update;
  if v_mae_nome is null then
    raise exception 'Empresa-mãe não encontrada.' using errcode = 'P0002';
  end if;
  if v_mae_eh_modelo then
    raise exception 'A empresa-mãe escolhida é um Modelo Padrão — não pode receber unidades.' using errcode = '22023';
  end if;

  select count(*) into v_qtd_unidades from unidades where organizacao_id = p_organizacao_id;
  if v_qtd_unidades > 0 then
    raise exception 'Esta empresa tem % unidade(s) própria(s) — a conversão só é permitida quando ela não tem nenhuma unidade cadastrada. Transfira ou promova as unidades dela primeiro.', v_qtd_unidades
      using errcode = '22023';
  end if;

  -- Nasce uma unidade nova dentro da empresa-mãe: diferente da promoção
  -- (que só troca o pai de uma unidade JÁ existente), aqui não existia
  -- nenhuma unidade prévia pra "virar" esta — é o mínimo indispensável.
  -- CNPJ fica de fora (mesmo motivo da promoção: evita colisão com o
  -- unique de unidades.cnpj; editável depois).
  insert into unidades (organizacao_id, nome, ativo)
    values (p_empresa_mae_id, v_org_nome, true)
    returning id into v_nova_unidade_id;

  -- Módulos: a unidade nova herda o que a EMPRESA-MÃE já libera (nunca os
  -- da empresa convertida, que deixou de existir como tal).
  insert into unidade_modulos (unidade_id, modulo_id, habilitado_por)
    select v_nova_unidade_id, om.modulo_id, p_ator_id
    from organizacao_modulos om where om.organizacao_id = p_empresa_mae_id;
  get diagnostics v_qtd_modulos = row_count;

  -- Usuários com acesso à empresa convertida (nível empresa) ganham acesso
  -- à unidade nova, com o mesmo papel — senão perderiam o acesso.
  insert into usuarios_unidades (usuario_id, unidade_id, papel, ativo)
    select uo.usuario_id, v_nova_unidade_id, uo.papel, true
    from usuarios_organizacoes uo
    where uo.organizacao_id = p_organizacao_id and uo.ativo = true
    on conflict (usuario_id, unidade_id) do nothing;
  get diagnostics v_qtd_vinculos_usuarios = row_count;

  -- Arquiva a empresa convertida: 'cancelada' já significa "encerrada;
  -- dados preservados para eventual retomada" no resto do painel — some da
  -- lista normal de Empresas e do login, mas NADA é apagado (catálogo,
  -- auditoria, tudo continua existindo).
  update organizacoes set
      status = 'cancelada', ativo = false, updated_at = now(),
      observacoes = coalesce(observacoes || E'\n', '') || format(
        'Convertida em unidade de "%s" em %s. Catálogo próprio (se houver) NÃO foi mesclado automaticamente — permanece aqui, preservado, desvinculado.',
        v_mae_nome, to_char(now(), 'DD/MM/YYYY HH24:MI'))
    where id = p_organizacao_id;

  update sessoes_contexto set revogada_em = now(), motivo_revogacao = 'empresa_convertida_em_unidade'
    where organizacao_id = p_organizacao_id and revogada_em is null;

  insert into plataforma_auditoria (ator_id, ator_email, ator_tipo, acao, entidade, entidade_id, organizacao_id, detalhes, ip, user_agent)
  values (p_ator_id, p_ator_email, 'superadmin', 'empresa.convertida_para_unidade', 'organizacao', p_organizacao_id::text, p_empresa_mae_id,
    jsonb_build_object(
      'empresaConvertida', v_org_nome, 'empresaConvertidaId', p_organizacao_id,
      'empresaMaeId', p_empresa_mae_id, 'empresaMaeNome', v_mae_nome,
      'novaUnidadeId', v_nova_unidade_id, 'modulosHerdados', v_qtd_modulos,
      'usuariosComAcessoEstendido', v_qtd_vinculos_usuarios,
      'aviso', 'catalogo proprio da empresa convertida (se houver) nao foi mesclado ao catalogo da empresa-mae'
    ), p_ip, p_user_agent);

  return jsonb_build_object(
    'novaUnidadeId', v_nova_unidade_id, 'unidadeNome', v_org_nome,
    'empresaConvertidaId', p_organizacao_id, 'empresaConvertidaNome', v_org_nome,
    'empresaMaeId', p_empresa_mae_id, 'empresaMaeNome', v_mae_nome
  );
end;
$$;


--
-- Name: excluir_organizacao_definitivamente(uuid, text, uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.excluir_organizacao_definitivamente(p_organizacao_id uuid, p_confirmacao_nome text, p_ator_id uuid, p_ator_email text DEFAULT NULL::text, p_ip text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_nome text;
  v_qtd_unidades int := 0;
  v_qtd_usuarios int := 0;
  v_qtd_categorias int := 0;
  v_qtd_insumos int := 0;
  v_qtd_produtos int := 0;
  v_qtd_ficha int := 0;
  v_qtd_mov_estoque int := 0;
  v_qtd_pedidos_itens int := 0;
  v_qtd_vendas_itens int := 0;
  v_qtd_pedidos_compra int := 0;
begin
  -- 1) Trava e valida a empresa.
  select nome into v_nome from organizacoes where id = p_organizacao_id for update;
  if v_nome is null then
    raise exception 'Empresa não encontrada.' using errcode = 'P0002';
  end if;

  -- 2) Confirmação por nome, dentro da MESMA transação — a barreira contra
  --    clique acidental não pode depender só do backend ter lido certo.
  if p_confirmacao_nome is distinct from v_nome then
    raise exception 'Confirmação inválida — digite o nome exato da empresa.' using errcode = '22023';
  end if;

  -- 3) Contagens ANTES de apagar qualquer coisa — vão para a auditoria e
  --    para o retorno (o mesmo formato que o preview de impacto usa).
  select count(*) into v_qtd_unidades  from unidades              where organizacao_id = p_organizacao_id;
  select count(*) into v_qtd_usuarios  from usuarios_organizacoes where organizacao_id = p_organizacao_id;
  select count(*) into v_qtd_categorias from categorias           where organizacao_id = p_organizacao_id;
  select count(*) into v_qtd_insumos   from insumos               where organizacao_id = p_organizacao_id;
  select count(*) into v_qtd_produtos  from produtos              where organizacao_id = p_organizacao_id;

  -- 4) Limpa as travas RESTRICT, sempre escopado a ESTA organização (nunca
  --    um delete solto por insumo_id/produto_id — teria que ser, por
  --    definição, de OUTRA empresa, e isso é bug de isolamento, não algo
  --    para varrer para debaixo do tapete).
  delete from ficha_tecnica
    where produto_id in (select id from produtos where organizacao_id = p_organizacao_id);
  get diagnostics v_qtd_ficha = row_count;

  delete from movimentacoes_estoque
    where insumo_id in (select id from insumos where organizacao_id = p_organizacao_id);
  get diagnostics v_qtd_mov_estoque = row_count;

  delete from pedidos_compra_itens
    where insumo_id in (select id from insumos where organizacao_id = p_organizacao_id);
  get diagnostics v_qtd_pedidos_itens = row_count;

  delete from vendas_itens
    where produto_id in (select id from produtos where organizacao_id = p_organizacao_id);
  get diagnostics v_qtd_vendas_itens = row_count;

  -- pedidos_compra.fornecedor_id é RESTRICT, e fornecedores cai pelo mesmo
  -- cascade de organizacao_id que o resto — os próprios pedidos precisam
  -- sumir primeiro. `unidade_id` já é cascade a partir de `unidades`, mas a
  -- ORDEM entre ramos diferentes da árvore de cascata não é garantida pelo
  -- Postgres; explícito aqui não deixa isso ao acaso.
  delete from pedidos_compra
    where unidade_id in (select id from unidades where organizacao_id = p_organizacao_id);
  get diagnostics v_qtd_pedidos_compra = row_count;

  -- 5) Revoga sessões desta empresa — redundante com o cascade de
  --    organizacao_id em sessoes_contexto (a linha vai sumir de qualquer
  --    forma), mas derruba acesso ativo no mesmo instante, sem esperar o
  --    resto da transação.
  update sessoes_contexto set revogada_em = now(), motivo_revogacao = 'empresa_excluida'
    where organizacao_id = p_organizacao_id and revogada_em is null;

  -- 6) Auditoria NA MESMA transação — `plataforma_auditoria.organizacao_id`
  --    não tem FK (é append-only e sobrevive à empresa de propósito), então
  --    a linha continua legível depois do delete; e se qualquer passo acima
  --    tivesse falhado, o rollback também desfaz esta linha (nunca sobra um
  --    "empresa.excluida" para uma empresa que continua existindo).
  insert into plataforma_auditoria
    (ator_id, ator_email, ator_tipo, acao, entidade, entidade_id, organizacao_id, detalhes, ip, user_agent)
  values (
    p_ator_id, p_ator_email, 'superadmin', 'empresa.excluida', 'organizacao', p_organizacao_id::text, p_organizacao_id,
    jsonb_build_object(
      'empresa', v_nome,
      'estrutura', jsonb_build_object('unidades', v_qtd_unidades, 'usuarios', v_qtd_usuarios),
      'catalogo', jsonb_build_object(
        'categorias', v_qtd_categorias, 'insumos', v_qtd_insumos, 'produtos', v_qtd_produtos, 'fichaTecnica', v_qtd_ficha
      ),
      'historicoLimpoAntesDoCascade', jsonb_build_object(
        'movimentacoesEstoque', v_qtd_mov_estoque, 'itensPedidoCompra', v_qtd_pedidos_itens,
        'itensVenda', v_qtd_vendas_itens, 'pedidosCompra', v_qtd_pedidos_compra
      )
    ),
    p_ip, p_user_agent
  );

  -- 7) Delete em cascata — agora seguro: nenhuma linha RESTRICT sobrou.
  --    Isto apaga unidades, categorias, insumos, produtos, fornecedores, e
  --    TODO o histórico operacional (Dashboard Executivo, Bonificação,
  --    Parser FD, Martin Brower, Agente Crescer, SW, vínculos de usuário,
  --    sessões) via os on delete cascade já existentes.
  delete from organizacoes where id = p_organizacao_id;

  return jsonb_build_object(
    'organizacaoId', p_organizacao_id, 'organizacaoNome', v_nome,
    'estrutura', jsonb_build_object('unidades', v_qtd_unidades, 'usuarios', v_qtd_usuarios),
    'catalogo', jsonb_build_object(
      'categorias', v_qtd_categorias, 'insumos', v_qtd_insumos, 'produtos', v_qtd_produtos, 'fichaTecnica', v_qtd_ficha
    ),
    'historicoLimpoAntesDoCascade', jsonb_build_object(
      'movimentacoesEstoque', v_qtd_mov_estoque, 'itensPedidoCompra', v_qtd_pedidos_itens,
      'itensVenda', v_qtd_vendas_itens, 'pedidosCompra', v_qtd_pedidos_compra
    ),
    'excluida', true
  );
end;
$$;


--
-- Name: fn_baixa_estoque_venda(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_baixa_estoque_venda() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_unidade_id uuid;
  rec record;
  v_saldo numeric(14,3);
begin
  select unidade_id into v_unidade_id from vendas where id = new.venda_id;

  for rec in
    with recursive expl as (
      select ft.insumo_id, ft.subproduto_id, ft.quantidade::numeric as qtd
      from ficha_tecnica ft
      where ft.produto_id = new.produto_id
      union all
      select ft.insumo_id, ft.subproduto_id, e.qtd * ft.quantidade
      from expl e
      join ficha_tecnica ft on ft.produto_id = e.subproduto_id
      where e.subproduto_id is not null
    )
    select insumo_id, sum(qtd * new.quantidade) as total
    from expl
    where insumo_id is not null
    group by insumo_id
  loop
    insert into estoque (unidade_id, insumo_id, quantidade_atual, estoque_minimo)
    values (v_unidade_id, rec.insumo_id, 0, 0)
    on conflict (unidade_id, insumo_id) do nothing;

    update estoque
       set quantidade_atual = quantidade_atual - rec.total, atualizado_em = now()
     where unidade_id = v_unidade_id and insumo_id = rec.insumo_id
    returning quantidade_atual into v_saldo;

    insert into movimentacoes_estoque
      (unidade_id, insumo_id, tipo, quantidade, saldo_apos, referencia_tipo, referencia_id)
    values
      (v_unidade_id, rec.insumo_id, 'saida_venda', -rec.total, v_saldo, 'venda_item', new.id);
  end loop;

  return new;
end;
$$;


--
-- Name: fn_custo_produto(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_custo_produto(p_produto_id uuid) RETURNS numeric
    LANGUAGE sql STABLE
    AS $$
  select coalesce(
    (select custo_manual from produtos where id = p_produto_id),
    (
      with recursive expl as (
        select ft.insumo_id, ft.subproduto_id, ft.quantidade::numeric as qtd
        from ficha_tecnica ft
        where ft.produto_id = p_produto_id and coalesce(ft.ativo, true)
        union all
        select ft.insumo_id, ft.subproduto_id, e.qtd * ft.quantidade
        from expl e
        join ficha_tecnica ft on ft.produto_id = e.subproduto_id and coalesce(ft.ativo, true)
        where e.subproduto_id is not null
      )
      select coalesce(sum(e.qtd * i.preco_unitario), 0)
      from expl e
      join insumos i on i.id = e.insumo_id
      where e.insumo_id is not null
    )
  );
$$;


--
-- Name: fn_recalc_custo(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_recalc_custo(p_produto_id uuid) RETURNS void
    LANGUAGE sql
    AS $$
  update produtos set custo_cache = fn_custo_produto(p_produto_id), updated_at = now()
  where id = p_produto_id;
$$;


--
-- Name: ifood_touch_atualizado_em(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ifood_touch_atualizado_em() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.atualizado_em = now();
  return new;
end $$;


--
-- Name: is_platform_superadmin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_platform_superadmin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1 from plataforma_admins
    where usuario_id = auth.uid() and ativo
  );
$$;


--
-- Name: mb_touch_atualizado_em(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mb_touch_atualizado_em() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.atualizado_em = now();
  return new;
end $$;


--
-- Name: parser_fd_set_atualizado_em(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.parser_fd_set_atualizado_em() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.atualizado_em = now();
  return new;
end;
$$;


--
-- Name: perfil_pin_registrar_falha(uuid, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.perfil_pin_registrar_falha(p_perfil_id uuid, p_max_tentativas integer DEFAULT 5, p_lock_minutos integer DEFAULT 15) RETURNS TABLE(pin_tentativas integer, pin_bloqueado_ate timestamp with time zone)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update perfis_operacionais
     set pin_tentativas = perfis_operacionais.pin_tentativas + 1,
         pin_bloqueado_ate = case
           when perfis_operacionais.pin_tentativas + 1 >= p_max_tentativas
             then now() + make_interval(mins => p_lock_minutos)
           else perfis_operacionais.pin_bloqueado_ate
         end
   where id = p_perfil_id
  returning perfis_operacionais.pin_tentativas, perfis_operacionais.pin_bloqueado_ate;
$$;


--
-- Name: perfil_pin_registrar_sucesso(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.perfil_pin_registrar_sucesso(p_perfil_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update perfis_operacionais
     set pin_tentativas = 0,
         pin_bloqueado_ate = null
   where id = p_perfil_id;
$$;


--
-- Name: promover_unidade_para_empresa(uuid, text, uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.promover_unidade_para_empresa(p_unidade_id uuid, p_nome_empresa text, p_ator_id uuid, p_ator_email text DEFAULT NULL::text, p_ip text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_org_antiga_id uuid;
  v_org_antiga_nome text;
  v_org_antiga_eh_modelo boolean;
  v_unidade_nome text;
  v_nova_org_id uuid;
  v_nome_final text;
  v_qtd_categorias int := 0;
  v_qtd_insumos int := 0;
  v_qtd_produtos int := 0;
  v_qtd_ficha int := 0;
  v_qtd_precos int := 0;
  v_qtd_swmap int := 0;
  v_qtd_swcombo int := 0;
  v_qtd_swvendidos_remap int := 0;
  v_qtd_mbvinc_remap int := 0;
  v_qtd_modulos int := 0;
  v_qtd_vinculos_usuarios int := 0;
  v_remapeamentos_genericos jsonb;
begin
  -- 1) Trava e valida a unidade + a empresa atual dela.
  select organizacao_id, nome into v_org_antiga_id, v_unidade_nome
    from unidades where id = p_unidade_id for update;
  if v_org_antiga_id is null then
    raise exception 'Unidade não encontrada.' using errcode = 'P0002';
  end if;

  select nome, eh_modelo into v_org_antiga_nome, v_org_antiga_eh_modelo
    from organizacoes where id = v_org_antiga_id for update;
  if v_org_antiga_nome is null then
    raise exception 'Empresa atual da unidade não encontrada — dado inconsistente.' using errcode = 'P0002';
  end if;
  if v_org_antiga_eh_modelo then
    raise exception 'Esta unidade pertence a um Modelo Padrão — não pode ser promovida.' using errcode = '22023';
  end if;

  v_nome_final := coalesce(nullif(trim(p_nome_empresa), ''), v_unidade_nome);

  -- 2) Cria a empresa nova. CNPJ fica NULL de propósito — evita colisão com
  --    o unique de organizacoes.cnpj; o SuperAdmin edita depois se quiser.
  insert into organizacoes (nome, status, ativo)
    values (v_nome_final, 'ativa', true)
    returning id into v_nova_org_id;

  -- 3) Clona o catálogo (mesmo escopo/exclusões de shared/clonarCatalogo.js).
  create temporary table map_categorias (old_id uuid primary key, new_id uuid not null) on commit drop;
  create temporary table map_insumos    (old_id uuid primary key, new_id uuid not null) on commit drop;
  create temporary table map_produtos   (old_id uuid primary key, new_id uuid not null) on commit drop;

  insert into map_categorias (old_id, new_id)
    select id, gen_random_uuid() from categorias where organizacao_id = v_org_antiga_id;
  insert into categorias (id, organizacao_id, nome, tipo, ordem, ativo)
    select m.new_id, v_nova_org_id, c.nome, c.tipo, c.ordem, c.ativo
    from categorias c join map_categorias m on m.old_id = c.id;
  get diagnostics v_qtd_categorias = row_count;

  insert into map_insumos (old_id, new_id)
    select id, gen_random_uuid() from insumos where organizacao_id = v_org_antiga_id;
  insert into insumos (
    id, organizacao_id, categoria_id, fornecedor_id, codigo, nome, tipo, unidade_medida,
    preco_caixa, rendimento, fator_correcao, preco_unitario, estoque_minimo, validade_dias,
    ativo, descricao, forma_compra
  )
    select m.new_id, v_nova_org_id,
      (select mc.new_id from map_categorias mc where mc.old_id = i.categoria_id),
      null, -- fornecedor_id: fora do escopo do clone (mesma decisão de clonarCatalogo.js)
      i.codigo, i.nome, i.tipo, i.unidade_medida,
      i.preco_caixa, i.rendimento, i.fator_correcao, i.preco_unitario, i.estoque_minimo, i.validade_dias,
      i.ativo, i.descricao, i.forma_compra
    from insumos i join map_insumos m on m.old_id = i.id;
  get diagnostics v_qtd_insumos = row_count;

  insert into map_produtos (old_id, new_id)
    select id, gen_random_uuid() from produtos where organizacao_id = v_org_antiga_id;
  insert into produtos (
    id, organizacao_id, categoria_id, tipo, nome, sku, codigo_pdv, tamanho, vendavel, custo_manual, imagem_url, ativo
  )
    select m.new_id, v_nova_org_id,
      (select mc.new_id from map_categorias mc where mc.old_id = p.categoria_id),
      p.tipo, p.nome, p.sku, p.codigo_pdv, p.tamanho, p.vendavel, p.custo_manual, p.imagem_url, p.ativo
    from produtos p join map_produtos m on m.old_id = p.id;
  get diagnostics v_qtd_produtos = row_count;

  -- Ficha técnica: pula (conta) linha órfã — insumo/subproduto que não
  -- fazia parte do catálogo clonado. Mesmo comportamento de clonarCatalogo.js.
  insert into ficha_tecnica (
    id, produto_id, insumo_id, subproduto_id, quantidade, observacao, unidade_uso, quantidade_informada, ordem, ativo
  )
    select gen_random_uuid(), mp.new_id,
      (select mi.new_id from map_insumos mi where mi.old_id = f.insumo_id),
      (select mp2.new_id from map_produtos mp2 where mp2.old_id = f.subproduto_id),
      f.quantidade, f.observacao, f.unidade_uso, f.quantidade_informada, f.ordem, f.ativo
    from ficha_tecnica f
    join map_produtos mp on mp.old_id = f.produto_id
    where (f.insumo_id is null or exists (select 1 from map_insumos mi2 where mi2.old_id = f.insumo_id))
      and (f.subproduto_id is null or exists (select 1 from map_produtos mp3 where mp3.old_id = f.subproduto_id));
  get diagnostics v_qtd_ficha = row_count;

  insert into produto_precos (id, produto_id, canal, tabela, preco, desatualizado)
    select gen_random_uuid(), mp.new_id, pr.canal, pr.tabela, pr.preco, pr.desatualizado
    from produto_precos pr join map_produtos mp on mp.old_id = pr.produto_id;
  get diagnostics v_qtd_precos = row_count;

  -- 4) Mapeamento SW/PDV (escopo organização, igual ao catálogo) — sem
  --    isto, a importação de Vendas da empresa nova nasceria sem NENHUM
  --    vínculo (tudo cairia como "sem vínculo" desde o primeiro dia).
  insert into sw_mapeamento_produtos (organizacao_id, codigo_sw, nome_sw, tipo_item, produto_id, ignorar_no_cmv, ignorar_no_estoque, ativo)
    select v_nova_org_id, s.codigo_sw, s.nome_sw, s.tipo_item,
      (select mp.new_id from map_produtos mp where mp.old_id = s.produto_id),
      s.ignorar_no_cmv, s.ignorar_no_estoque, s.ativo
    from sw_mapeamento_produtos s where s.organizacao_id = v_org_antiga_id;
  get diagnostics v_qtd_swmap = row_count;

  insert into sw_combo_componentes (organizacao_id, codigo_sw, produto_id, quantidade)
    select v_nova_org_id, sc.codigo_sw, mp.new_id, sc.quantidade
    from sw_combo_componentes sc
    join map_produtos mp on mp.old_id = sc.produto_id
    where sc.organizacao_id = v_org_antiga_id;
  get diagnostics v_qtd_swcombo = row_count;

  -- 5) Histórico JÁ GRAVADO da própria unidade (linhas que não mudam de
  --    unidade_id — só o produto_id/insumo_id que apontava pro catálogo
  --    antigo passa a apontar pro clone): rompe a dependência da
  --    empresa-mãe sem apagar ou reescrever nenhum valor histórico.
  update sw_produtos_vendidos spv
    set produto_id = mp.new_id
    from map_produtos mp
    where spv.unidade_id = p_unidade_id and spv.produto_id = mp.old_id;
  get diagnostics v_qtd_swvendidos_remap = row_count;

  update martin_brower_vinculos mbv
    set organizacao_id = v_nova_org_id, insumo_id = mi.new_id
    from map_insumos mi
    where mbv.unidade_id = p_unidade_id and mbv.insumo_id = mi.old_id;
  get diagnostics v_qtd_mbvinc_remap = row_count;

  -- 5b) Toda a demais tabela operacional com o mesmo par (unidade_id +
  --     organizacao_id redundante) — Dashboard Executivo, Bonificação,
  --     Parser FD, Agente Crescer, Martin Brower (integrações/sincronizações/
  --     produtos/preços/filtros), histórico de tabela comercial/modelo
  --     logístico etc. Ver o helper no topo do arquivo para o porquê e as
  --     exclusões.
  v_remapeamentos_genericos := remapear_organizacao_em_tabelas_de_unidade(p_unidade_id, v_org_antiga_id, v_nova_org_id);

  -- 6) Módulos: a empresa nova nasce com os módulos que a empresa-mãe já
  --    tinha habilitados (o SuperAdmin ajusta depois pela aba Acessos).
  --    unidade_modulos NÃO muda — é só da unidade, sobrevive intacta.
  insert into organizacao_modulos (organizacao_id, modulo_id, habilitado_por)
    select v_nova_org_id, om.modulo_id, p_ator_id
    from organizacao_modulos om where om.organizacao_id = v_org_antiga_id;
  get diagnostics v_qtd_modulos = row_count;

  -- 7) Move a unidade DE VERDADE — ela não é recriada, só troca de pai.
  update unidades set organizacao_id = v_nova_org_id, updated_at = now() where id = p_unidade_id;

  -- 8) Usuários com acesso à EMPRESA TODA (sem vínculo de unidade
  --    específico) ganham o mesmo papel na empresa nova — senão perderiam,
  --    silenciosamente, o acesso a uma unidade que já viam. Vínculo
  --    ESPECÍFICO desta unidade (usuarios_unidades) não muda — não
  --    referencia organizacao_id, continua valendo.
  insert into usuarios_organizacoes (usuario_id, organizacao_id, papel, ativo)
    select uo.usuario_id, v_nova_org_id, uo.papel, true
    from usuarios_organizacoes uo
    where uo.organizacao_id = v_org_antiga_id and uo.ativo = true
    on conflict (usuario_id, organizacao_id) do nothing;
  get diagnostics v_qtd_vinculos_usuarios = row_count;

  -- 9) Revoga sessões presas a esta unidade — o token antigo aponta pra
  --    empresa/unidade que já não existem mais desse jeito.
  update sessoes_contexto set revogada_em = now(), motivo_revogacao = 'unidade_promovida'
    where unidade_id = p_unidade_id and revogada_em is null;

  -- 10) Auditoria — na MESMA transação: se qualquer passo acima falhar,
  --     esta linha também não existe (rollback é atômico).
  insert into plataforma_auditoria (ator_id, ator_email, ator_tipo, acao, entidade, entidade_id, organizacao_id, detalhes, ip, user_agent)
  values (p_ator_id, p_ator_email, 'superadmin', 'unidade.promovida_para_empresa', 'unidade', p_unidade_id::text, v_nova_org_id,
    jsonb_build_object(
      'unidade', v_unidade_nome,
      'de', jsonb_build_object('tipo', 'unidade', 'organizacaoId', v_org_antiga_id, 'organizacaoNome', v_org_antiga_nome),
      'para', jsonb_build_object('tipo', 'empresa', 'organizacaoId', v_nova_org_id, 'organizacaoNome', v_nome_final),
      'catalogoClonado', jsonb_build_object(
        'categorias', v_qtd_categorias, 'insumos', v_qtd_insumos, 'produtos', v_qtd_produtos,
        'fichaTecnica', v_qtd_ficha, 'precos', v_qtd_precos,
        'mapeamentosSw', v_qtd_swmap, 'combosSw', v_qtd_swcombo
      ),
      'remapeados', jsonb_build_object(
        'vendasSwHistoricas', v_qtd_swvendidos_remap, 'martinBrowerVinculos', v_qtd_mbvinc_remap,
        'outrasTabelas', v_remapeamentos_genericos
      ),
      'modulosHerdados', v_qtd_modulos, 'usuariosComAcessoEstendido', v_qtd_vinculos_usuarios
    ),
    p_ip, p_user_agent);

  return jsonb_build_object(
    'unidadeId', p_unidade_id, 'unidadeNome', v_unidade_nome,
    'novaOrganizacaoId', v_nova_org_id, 'novaOrganizacaoNome', v_nome_final,
    'organizacaoAnteriorId', v_org_antiga_id, 'organizacaoAnteriorNome', v_org_antiga_nome,
    'catalogo', jsonb_build_object(
      'categorias', v_qtd_categorias, 'insumos', v_qtd_insumos, 'produtos', v_qtd_produtos,
      'fichaTecnica', v_qtd_ficha, 'precos', v_qtd_precos
    ),
    'tabelasRemapeadas', v_remapeamentos_genericos
  );
end;
$$;


--
-- Name: remapear_organizacao_em_tabelas_de_unidade(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remapear_organizacao_em_tabelas_de_unidade(p_unidade_id uuid, p_org_antiga_id uuid, p_org_nova_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $_$
declare
  v_tabela text;
  v_qtd int;
  v_resultado jsonb := '{}'::jsonb;
begin
  for v_tabela in
    select c1.table_name
    from information_schema.columns c1
    join information_schema.columns c2
      on c2.table_schema = c1.table_schema and c2.table_name = c1.table_name and c2.column_name = 'unidade_id'
    join information_schema.tables t
      on t.table_schema = c1.table_schema and t.table_name = c1.table_name and t.table_type = 'BASE TABLE'
    where c1.table_schema = 'public' and c1.column_name = 'organizacao_id'
      and c1.table_name not in ('martin_brower_vinculos', 'sessoes_contexto', 'insumo_historico')
    order by c1.table_name
  loop
    execute format(
      'update public.%I set organizacao_id = $1 where unidade_id = $2 and organizacao_id = $3',
      v_tabela
    ) using p_org_nova_id, p_unidade_id, p_org_antiga_id;
    get diagnostics v_qtd = row_count;
    if v_qtd > 0 then
      v_resultado := v_resultado || jsonb_build_object(v_tabela, v_qtd);
    end if;
  end loop;
  return v_resultado;
end;
$_$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin new.updated_at = now(); return new; end;
$$;


--
-- Name: transferir_unidade_organizacao(uuid, uuid, uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transferir_unidade_organizacao(p_unidade_id uuid, p_nova_organizacao_id uuid, p_ator_id uuid, p_ator_email text DEFAULT NULL::text, p_ip text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_org_antiga_id uuid;
  v_org_antiga_nome text;
  v_org_nova_nome text;
  v_org_nova_eh_modelo boolean;
  v_unidade_nome text;
  v_remapeamentos_genericos jsonb;
begin
  select organizacao_id, nome into v_org_antiga_id, v_unidade_nome
    from unidades where id = p_unidade_id for update;
  if v_org_antiga_id is null then
    raise exception 'Unidade não encontrada.' using errcode = 'P0002';
  end if;

  if v_org_antiga_id = p_nova_organizacao_id then
    raise exception 'A unidade já pertence a esta empresa.' using errcode = '22023';
  end if;

  select nome into v_org_antiga_nome from organizacoes where id = v_org_antiga_id;

  select nome, eh_modelo into v_org_nova_nome, v_org_nova_eh_modelo
    from organizacoes where id = p_nova_organizacao_id for update;
  if v_org_nova_nome is null then
    raise exception 'Empresa de destino não encontrada.' using errcode = 'P0002';
  end if;
  if v_org_nova_eh_modelo then
    raise exception 'A empresa de destino é um Modelo Padrão — não pode receber unidades.' using errcode = '22023';
  end if;

  update unidades set organizacao_id = p_nova_organizacao_id, updated_at = now() where id = p_unidade_id;

  -- Mesmo remapeamento genérico da promoção (ver o helper): Dashboard
  -- Executivo, Bonificação, Parser FD, Agente Crescer, Martin Brower e
  -- históricos têm organizacao_id redundante ao lado de unidade_id — sem
  -- isto, essas tabelas ficariam com unidade_id na empresa NOVA e
  -- organizacao_id ainda na ANTIGA. Deliberadamente NÃO inclui catálogo/
  -- sw_mapeamento_produtos/martin_brower_vinculos (ver comentário da função).
  v_remapeamentos_genericos := remapear_organizacao_em_tabelas_de_unidade(p_unidade_id, v_org_antiga_id, p_nova_organizacao_id);

  update sessoes_contexto set revogada_em = now(), motivo_revogacao = 'unidade_transferida'
    where unidade_id = p_unidade_id and revogada_em is null;

  insert into plataforma_auditoria (ator_id, ator_email, ator_tipo, acao, entidade, entidade_id, organizacao_id, detalhes, ip, user_agent)
  values (p_ator_id, p_ator_email, 'superadmin', 'unidade.transferida_entre_empresas', 'unidade', p_unidade_id::text, p_nova_organizacao_id,
    jsonb_build_object(
      'unidade', v_unidade_nome,
      'de', jsonb_build_object('organizacaoId', v_org_antiga_id, 'organizacaoNome', v_org_antiga_nome),
      'para', jsonb_build_object('organizacaoId', p_nova_organizacao_id, 'organizacaoNome', v_org_nova_nome),
      'tabelasRemapeadas', v_remapeamentos_genericos,
      'aviso', 'catalogo e integracoes de mapeamento SW/Martin Brower (produto/insumo) nao sao remapeados automaticamente'
    ), p_ip, p_user_agent);

  return jsonb_build_object(
    'unidadeId', p_unidade_id, 'unidadeNome', v_unidade_nome,
    'organizacaoAnteriorId', v_org_antiga_id, 'organizacaoAnteriorNome', v_org_antiga_nome,
    'novaOrganizacaoId', p_nova_organizacao_id, 'novaOrganizacaoNome', v_org_nova_nome,
    'tabelasRemapeadas', v_remapeamentos_genericos
  );
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agente_conversas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agente_conversas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    usuario_id uuid,
    organizacao_id uuid NOT NULL,
    unidade_id uuid,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL,
    perfil_id uuid
);


--
-- Name: agente_mensagens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agente_mensagens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversa_id uuid NOT NULL,
    papel text NOT NULL,
    conteudo text NOT NULL,
    tools_utilizadas jsonb DEFAULT '[]'::jsonb NOT NULL,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    acoes jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT agente_mensagens_papel_check CHECK ((papel = ANY (ARRAY['user'::text, 'assistant'::text])))
);


--
-- Name: agente_quota_uso; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agente_quota_uso (
    escopo text NOT NULL,
    chave uuid NOT NULL,
    janela_segundos integer NOT NULL,
    janela_inicio timestamp with time zone NOT NULL,
    consumido integer DEFAULT 0 NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agente_quota_uso_consumido_check CHECK ((consumido >= 0)),
    CONSTRAINT agente_quota_uso_escopo_check CHECK ((escopo = ANY (ARRAY['org'::text, 'conta'::text, 'perfil'::text]))),
    CONSTRAINT agente_quota_uso_janela_segundos_check CHECK ((janela_segundos > 0))
);


--
-- Name: agente_uso; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agente_uso (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversa_id uuid,
    usuario_id uuid,
    organizacao_id uuid NOT NULL,
    unidade_id uuid,
    provider text DEFAULT 'anthropic'::text NOT NULL,
    model text NOT NULL,
    pricing_version text NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    cache_creation_tokens integer DEFAULT 0 NOT NULL,
    cache_read_tokens integer DEFAULT 0 NOT NULL,
    estimated_cost_usd numeric(12,6),
    tool_calls_count integer DEFAULT 0 NOT NULL,
    tools_used jsonb DEFAULT '[]'::jsonb NOT NULL,
    duration_ms integer NOT NULL,
    success boolean NOT NULL,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: alertas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alertas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    tipo public.tipo_alerta NOT NULL,
    severidade public.severidade_alerta DEFAULT 'atencao'::public.severidade_alerta NOT NULL,
    titulo text NOT NULL,
    mensagem text NOT NULL,
    dados jsonb,
    status public.status_alerta DEFAULT 'novo'::public.status_alerta NOT NULL,
    gerado_por text DEFAULT 'sistema'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: assinaturas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assinaturas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    plano_id uuid NOT NULL,
    status public.status_assinatura DEFAULT 'trial'::public.status_assinatura NOT NULL,
    ciclo public.ciclo_cobranca DEFAULT 'mensal'::public.ciclo_cobranca NOT NULL,
    valor numeric(12,2) DEFAULT 0 NOT NULL,
    inicio_em date DEFAULT CURRENT_DATE NOT NULL,
    proxima_cobranca_em date,
    cancelado_em timestamp with time zone,
    motivo_cancelamento text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bonificacao_importacoes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bonificacao_importacoes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    data_lancamento date,
    tipo_relatorio public.bonificacao_tipo_relatorio_enum NOT NULL,
    nome_arquivo text,
    hash_arquivo text,
    arquivo_storage text,
    estabelecimento_detectado text,
    status text DEFAULT 'concluida'::text NOT NULL,
    mensagem_erro text,
    substituiu_importacao_id uuid,
    usuario_id uuid,
    usuario_nome text,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bonificacao_importacoes_status_check CHECK ((status = ANY (ARRAY['concluida'::text, 'erro'::text])))
);


--
-- Name: bonificacao_lancamentos_diarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bonificacao_lancamentos_diarios (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    data date NOT NULL,
    sem_operacao boolean DEFAULT false NOT NULL,
    motivo_sem_operacao text,
    faturamento_geral numeric(14,2),
    ppd_geral numeric(8,1),
    estabelecimento_geral text,
    faturamento_loja numeric(14,2),
    ppd_loja numeric(8,1),
    qtd_sanduiches_loja integer,
    qtd_bebidas_loja integer,
    qtd_adicionais_loja integer,
    qtd_diversos_loja integer,
    estabelecimento_loja text,
    percentual_bebidas_pdf numeric(6,3),
    percentual_adicionais_pdf numeric(6,3),
    percentual_diversos_pdf numeric(6,3),
    cmv_pct numeric(6,3),
    ticket_medio numeric(10,2),
    avaliacao_ifood numeric(3,2),
    cancelamentos_pct numeric(6,3),
    pedidos_chamado_pct numeric(6,3),
    rev_nota numeric(6,2),
    pesquisas_qtd integer,
    origem text DEFAULT 'manual'::text NOT NULL,
    manual_override jsonb DEFAULT '{}'::jsonb NOT NULL,
    importacao_geral_id uuid,
    importacao_loja_id uuid,
    usuario_id uuid,
    usuario_nome text,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL,
    cupons_validos_geral integer,
    cupons_vendas_geral integer,
    CONSTRAINT bonificacao_lancamentos_diarios_origem_check CHECK ((origem = ANY (ARRAY['visio'::text, 'manual'::text, 'misto'::text])))
);


--
-- Name: bonificacao_lancamentos_exclusoes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bonificacao_lancamentos_exclusoes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    data_lancamento date NOT NULL,
    lancamento_snapshot jsonb NOT NULL,
    motivo text NOT NULL,
    usuario_id uuid,
    usuario_nome text,
    usuario_email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bonificacao_metas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bonificacao_metas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    indicador text NOT NULL,
    direcao public.bonificacao_direcao_enum NOT NULL,
    valid_from date NOT NULL,
    valid_until date,
    observacao text,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bonificacao_metas_indicador_check CHECK ((indicador = ANY (ARRAY['faturamento'::text, 'bebidas'::text, 'adicionais'::text, 'diversos'::text, 'cmv'::text, 'ticket_medio'::text, 'avaliacao_ifood'::text, 'cancelamentos'::text, 'pedidos_chamado'::text, 'rev'::text, 'pesquisas'::text])))
);


--
-- Name: bonificacao_metas_faixas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bonificacao_metas_faixas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    meta_id uuid NOT NULL,
    ordem integer NOT NULL,
    tipo public.bonificacao_faixa_tipo_enum NOT NULL,
    valor_min numeric(14,4),
    valor_max numeric(14,4),
    bonus numeric(10,2)
);


--
-- Name: bonificacao_rev_mensal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bonificacao_rev_mensal (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    ano integer NOT NULL,
    mes integer NOT NULL,
    valor numeric(6,2) NOT NULL,
    usuario_id uuid,
    usuario_nome text,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bonificacao_rev_mensal_ano_check CHECK (((ano >= 2000) AND (ano <= 2100))),
    CONSTRAINT bonificacao_rev_mensal_mes_check CHECK (((mes >= 1) AND (mes <= 12))),
    CONSTRAINT bonificacao_rev_mensal_valor_check CHECK ((valor >= (0)::numeric))
);


--
-- Name: canais_venda; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canais_venda (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    canal public.canal NOT NULL,
    comissao_pct numeric(6,4) DEFAULT 0 NOT NULL,
    ativo boolean DEFAULT true NOT NULL
);


--
-- Name: categorias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categorias (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    nome text NOT NULL,
    tipo public.tipo_categoria DEFAULT 'produto'::public.tipo_categoria NOT NULL,
    ordem integer DEFAULT 0 NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cobrancas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cobrancas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    assinatura_id uuid,
    organizacao_id uuid NOT NULL,
    competencia date NOT NULL,
    valor numeric(12,2) NOT NULL,
    status public.status_cobranca DEFAULT 'pendente'::public.status_cobranca NOT NULL,
    vencimento date NOT NULL,
    pago_em timestamp with time zone,
    metodo text,
    referencia_externa text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dashboard_teste_reset_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_teste_reset_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    usuario_id uuid,
    usuario_nome text,
    usuario_email text,
    data_inicial_reset date NOT NULL,
    lancamentos_removidos jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: divergencias_compra; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.divergencias_compra (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pedido_compra_id uuid NOT NULL,
    insumo_id uuid,
    tipo public.tipo_divergencia NOT NULL,
    quantidade_divergente numeric(14,3),
    descricao text,
    resolvida boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: divergencias_vendas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.divergencias_vendas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    importacao_id uuid,
    tipo text NOT NULL,
    nivel text DEFAULT 'atencao'::text NOT NULL,
    titulo text NOT NULL,
    descricao text,
    resolvida boolean DEFAULT false NOT NULL,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    resolvida_em timestamp with time zone
);


--
-- Name: estoque; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estoque (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    insumo_id uuid NOT NULL,
    quantidade_atual numeric(14,3) DEFAULT 0 NOT NULL,
    estoque_minimo numeric(14,3) DEFAULT 0 NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ficha_tecnica; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ficha_tecnica (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    produto_id uuid NOT NULL,
    insumo_id uuid,
    subproduto_id uuid,
    quantidade numeric(14,5) NOT NULL,
    observacao text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    unidade_uso public.unidade_medida_enum,
    quantidade_informada numeric(14,5),
    ordem integer DEFAULT 0 NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    origem text,
    CONSTRAINT ficha_nao_recursivo CHECK (((subproduto_id IS NULL) OR (subproduto_id <> produto_id))),
    CONSTRAINT ficha_um_componente CHECK (((insumo_id IS NULL) <> (subproduto_id IS NULL)))
);


--
-- Name: fornecedores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fornecedores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    nome text NOT NULL,
    tipo public.tipo_fornecedor DEFAULT 'local'::public.tipo_fornecedor NOT NULL,
    cnpj text,
    contato text,
    email text,
    telefone text,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ifood_conexoes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ifood_conexoes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    merchant_id text,
    merchant_nome text,
    merchant_razao_social text,
    status text DEFAULT 'pendente'::text NOT NULL,
    conectada_em timestamp with time zone,
    ultima_sincronizacao_em timestamp with time zone,
    ultimo_erro text,
    criado_por uuid,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ifood_conexoes_status_check CHECK ((status = ANY (ARRAY['pendente'::text, 'ativa'::text, 'revogada'::text, 'reauth_required'::text])))
);


--
-- Name: ifood_credenciais; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ifood_credenciais (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conexao_id uuid NOT NULL,
    app_type text NOT NULL,
    access_token_cifrado text NOT NULL,
    refresh_token_cifrado text,
    expira_em timestamp with time zone NOT NULL,
    token_type text,
    status text DEFAULT 'ativa'::text NOT NULL,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ifood_credenciais_app_type_check CHECK ((app_type = ANY (ARRAY['analytics'::text, 'financial'::text]))),
    CONSTRAINT ifood_credenciais_status_check CHECK ((status = ANY (ARRAY['ativa'::text, 'reauth_required'::text])))
);


--
-- Name: ifood_oauth_sessoes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ifood_oauth_sessoes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    app_type text NOT NULL,
    user_code text NOT NULL,
    authorization_code_verifier_cifrado text,
    verification_url text,
    verification_url_complete text,
    expira_em timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    verifier_consumido_em timestamp with time zone,
    criado_por uuid,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ifood_oauth_sessoes_app_type_check CHECK ((app_type = ANY (ARRAY['analytics'::text, 'financial'::text]))),
    CONSTRAINT ifood_oauth_sessoes_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'authorized'::text, 'expired'::text, 'failed'::text])))
);


--
-- Name: importacoes_vendas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.importacoes_vendas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    origem text DEFAULT 'manual'::text NOT NULL,
    canal text DEFAULT 'balcao'::text NOT NULL,
    data_movimento date,
    tipo_relatorio text NOT NULL,
    nome_arquivo text,
    hash_arquivo text,
    status text DEFAULT 'concluida'::text NOT NULL,
    total_registros integer DEFAULT 0 NOT NULL,
    valor_total numeric(14,2) DEFAULT 0 NOT NULL,
    mensagem_erro text,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL,
    observacao text,
    arquivo_storage text
);


--
-- Name: insights_ia; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insights_ia (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    tipo text NOT NULL,
    conteudo text,
    dados jsonb,
    periodo_inicio date,
    periodo_fim date,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: insumo_historico; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insumo_historico (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    insumo_id uuid NOT NULL,
    unidade_id uuid,
    preco_anterior numeric(12,4),
    preco_novo numeric(12,4),
    custo_anterior numeric(12,6),
    custo_novo numeric(12,6),
    variacao_pct numeric(10,4),
    unidade_medida_anterior public.unidade_medida_enum,
    unidade_medida_nova public.unidade_medida_enum,
    usuario_id uuid,
    usuario_nome text,
    usuario_email text,
    observacao text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: insumos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insumos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    categoria_id uuid,
    fornecedor_id uuid,
    codigo text,
    nome text NOT NULL,
    tipo public.tipo_insumo DEFAULT 'outro'::public.tipo_insumo NOT NULL,
    unidade_medida public.unidade_medida_enum DEFAULT 'kg'::public.unidade_medida_enum NOT NULL,
    preco_caixa numeric(12,4),
    rendimento numeric(12,4),
    fator_correcao numeric(8,4) DEFAULT 1 NOT NULL,
    preco_unitario numeric(12,6) DEFAULT 0 NOT NULL,
    estoque_minimo numeric(14,3) DEFAULT 0 NOT NULL,
    validade_dias integer,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    descricao text,
    forma_compra text,
    preco_atualizado_em timestamp with time zone,
    created_by uuid,
    origem text
);


--
-- Name: lancamentos_financeiros_auditoria; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lancamentos_financeiros_auditoria (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lancamento_id uuid NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    campo text NOT NULL,
    valor_anterior text,
    valor_novo text,
    usuario_id uuid,
    usuario_nome text,
    usuario_email text,
    motivo text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lancamentos_financeiros_diarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lancamentos_financeiros_diarios (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    data_lancamento date NOT NULL,
    situacao public.situacao_operacao_enum DEFAULT 'normal'::public.situacao_operacao_enum NOT NULL,
    motivo_sem_operacao text,
    observacao text,
    qtd_vendas integer,
    valor_vendas_bruto numeric(14,2),
    novos_clientes integer,
    valor_vendas_ifood numeric(14,2),
    taxas_comissoes numeric(14,2),
    servicos_promocoes numeric(14,2),
    taxas_entregadores numeric(14,2),
    outras_deducoes numeric(14,2),
    justificativa_ajuste text,
    status public.status_lancamento_enum DEFAULT 'rascunho'::public.status_lancamento_enum NOT NULL,
    usuario_id uuid,
    usuario_nome text,
    usuario_email text,
    finalizado_em timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    origem_lancamento public.origem_lancamento_enum DEFAULT 'diario'::public.origem_lancamento_enum NOT NULL,
    distribuicao_mensal_id uuid,
    ajustes_favor_loja numeric(14,2),
    ajustes_contra_loja numeric(14,2),
    CONSTRAINT lfd_ajustes_contra_loja_check CHECK (((ajustes_contra_loja IS NULL) OR (ajustes_contra_loja >= (0)::numeric))),
    CONSTRAINT lfd_ajustes_favor_loja_check CHECK (((ajustes_favor_loja IS NULL) OR (ajustes_favor_loja >= (0)::numeric))),
    CONSTRAINT lfd_novos_clientes_check CHECK (((novos_clientes IS NULL) OR (novos_clientes >= 0))),
    CONSTRAINT lfd_qtd_vendas_check CHECK (((qtd_vendas IS NULL) OR (qtd_vendas >= 0))),
    CONSTRAINT lfd_servicos_promocoes_check CHECK (((servicos_promocoes IS NULL) OR (servicos_promocoes >= (0)::numeric))),
    CONSTRAINT lfd_taxas_comissoes_check CHECK (((taxas_comissoes IS NULL) OR (taxas_comissoes >= (0)::numeric))),
    CONSTRAINT lfd_taxas_entregadores_check CHECK (((taxas_entregadores IS NULL) OR (taxas_entregadores >= (0)::numeric))),
    CONSTRAINT lfd_valor_vendas_bruto_check CHECK (((valor_vendas_bruto IS NULL) OR (valor_vendas_bruto >= (0)::numeric))),
    CONSTRAINT lfd_valor_vendas_ifood_check CHECK (((valor_vendas_ifood IS NULL) OR (valor_vendas_ifood >= (0)::numeric)))
);


--
-- Name: lancamentos_financeiros_distribuicao_mensal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lancamentos_financeiros_distribuicao_mensal (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    ano integer NOT NULL,
    mes integer NOT NULL,
    valor_total_centavos bigint NOT NULL,
    dias_distribuidos integer NOT NULL,
    usuario_id uuid,
    usuario_nome text,
    usuario_email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_por_id uuid,
    atualizado_por_nome text,
    atualizado_por_email text,
    CONSTRAINT lancamentos_financeiros_distribuicao_me_dias_distribuidos_check CHECK ((dias_distribuidos > 0)),
    CONSTRAINT lancamentos_financeiros_distribuicao_mensal_ano_check CHECK (((ano >= 2000) AND (ano <= 2100))),
    CONSTRAINT lancamentos_financeiros_distribuicao_mensal_mes_check CHECK (((mes >= 1) AND (mes <= 12))),
    CONSTRAINT lancamentos_financeiros_distribuicao_valor_total_centavos_check CHECK ((valor_total_centavos > 0))
);


--
-- Name: lancamentos_financeiros_distribuicao_mensal_auditoria; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lancamentos_financeiros_distribuicao_mensal_auditoria (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    distribuicao_mensal_id uuid,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    ano integer NOT NULL,
    mes integer NOT NULL,
    acao text NOT NULL,
    campos_alterados jsonb,
    usuario_id uuid,
    usuario_nome text,
    usuario_email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lancamentos_financeiros_distribuicao_mensal_auditori_acao_check CHECK ((acao = ANY (ARRAY['criado'::text, 'editado'::text, 'excluido'::text]))),
    CONSTRAINT lancamentos_financeiros_distribuicao_mensal_auditoria_ano_check CHECK (((ano >= 2000) AND (ano <= 2100))),
    CONSTRAINT lancamentos_financeiros_distribuicao_mensal_auditoria_mes_check CHECK (((mes >= 1) AND (mes <= 12)))
);


--
-- Name: lancamentos_financeiros_exclusoes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lancamentos_financeiros_exclusoes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    data_lancamento date NOT NULL,
    lancamento_snapshot jsonb NOT NULL,
    motivo text NOT NULL,
    usuario_id uuid,
    usuario_nome text,
    usuario_email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lotes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    insumo_id uuid NOT NULL,
    quantidade numeric(14,3) NOT NULL,
    data_validade date,
    custo_unitario numeric(12,6),
    pedido_compra_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: martin_brower_filtros; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.martin_brower_filtros (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid,
    tipo text NOT NULL,
    valor text NOT NULL,
    acao text DEFAULT 'ignorar'::text NOT NULL,
    motivo text,
    ativo boolean DEFAULT true NOT NULL,
    criado_por uuid,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: martin_brower_integracoes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.martin_brower_integracoes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    client_id text NOT NULL,
    unidade_nome text,
    ativo boolean DEFAULT true NOT NULL,
    status text DEFAULT 'nao_configurado'::text NOT NULL,
    ultimo_order_id bigint,
    ultima_sincronizacao timestamp with time zone,
    ultimo_erro text,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: martin_brower_precos_historico; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.martin_brower_precos_historico (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    produto_id uuid NOT NULL,
    client_id text NOT NULL,
    codigo text NOT NULL,
    preco_anterior numeric(12,2),
    preco_novo numeric(12,2),
    alteracao_valor numeric(12,2),
    alteracao_percentual numeric(12,4),
    coletado_em timestamp with time zone DEFAULT now() NOT NULL,
    sincronizacao_id uuid,
    criado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: martin_brower_produtos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.martin_brower_produtos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    client_id text NOT NULL,
    order_id bigint,
    client_product_id bigint,
    product_id bigint,
    codigo text NOT NULL,
    codigo_interno text,
    descricao text NOT NULL,
    preco numeric(12,2),
    peso numeric(12,3),
    volume numeric(12,3),
    unidade text,
    unidade_descricao text,
    familia text,
    familia_descricao text,
    grupo_id bigint,
    grupo_descricao text,
    multiplo numeric(12,3),
    quantidade_media numeric(12,3),
    quantidade_pedido numeric(12,3),
    status_item_id bigint,
    tipo_produto text,
    ativo boolean DEFAULT true NOT NULL,
    visto_na_ultima_sincronizacao boolean DEFAULT true NOT NULL,
    ignorado boolean DEFAULT false NOT NULL,
    motivo_ignorado text,
    regra_ignorado text,
    classificacao_manual boolean DEFAULT false NOT NULL,
    primeira_sincronizacao timestamp with time zone DEFAULT now() NOT NULL,
    ultima_sincronizacao timestamp with time zone DEFAULT now() NOT NULL,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: martin_brower_sincronizacoes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.martin_brower_sincronizacoes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    client_id text,
    order_id bigint,
    origem text DEFAULT 'worker'::text NOT NULL,
    status text DEFAULT 'aguardando'::text NOT NULL,
    etapa_atual text,
    produtos_encontrados integer DEFAULT 0 NOT NULL,
    produtos_validos integer DEFAULT 0 NOT NULL,
    produtos_ignorados integer DEFAULT 0 NOT NULL,
    produtos_criados integer DEFAULT 0 NOT NULL,
    produtos_atualizados integer DEFAULT 0 NOT NULL,
    precos_alterados integer DEFAULT 0 NOT NULL,
    produtos_com_erro integer DEFAULT 0 NOT NULL,
    financial_restriction text,
    janela_inicio timestamp with time zone,
    janela_final timestamp with time zone,
    erro_codigo text,
    erro_mensagem text,
    iniciado_em timestamp with time zone DEFAULT now() NOT NULL,
    finalizado_em timestamp with time zone,
    criado_por uuid,
    request_id text
);


--
-- Name: martin_brower_vinculos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.martin_brower_vinculos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    mb_produto_id uuid NOT NULL,
    insumo_id uuid NOT NULL,
    origem text DEFAULT 'manual'::text NOT NULL,
    observacao text,
    confirmado_por uuid,
    confirmado_em timestamp with time zone DEFAULT now() NOT NULL,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: metas_indicadores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metas_indicadores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid,
    unidade_id uuid,
    indicador text NOT NULL,
    meta_ideal numeric(6,4) NOT NULL,
    limite numeric(6,4) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    modelo_logistico public.modelo_logistico_ifood_enum DEFAULT 'full_service'::public.modelo_logistico_ifood_enum NOT NULL,
    CONSTRAINT metas_indicadores_indicador_check CHECK ((indicador = ANY (ARRAY['taxas_comissoes'::text, 'servicos_promocoes'::text, 'taxas_entregadores'::text, 'total_deducoes'::text])))
);


--
-- Name: modulos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modulos (
    id text NOT NULL,
    nome text NOT NULL,
    categoria text NOT NULL,
    ordem integer DEFAULT 0 NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT modulos_categoria_check CHECK ((categoria = ANY (ARRAY['operacao'::text, 'integracao'::text])))
);


--
-- Name: movimentacoes_estoque; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.movimentacoes_estoque (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    insumo_id uuid NOT NULL,
    tipo public.tipo_movimentacao NOT NULL,
    quantidade numeric(14,3) NOT NULL,
    custo_unitario numeric(12,6),
    saldo_apos numeric(14,3),
    referencia_tipo text,
    referencia_id uuid,
    observacao text,
    usuario_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notas_fiscais; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notas_fiscais (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    pedido_compra_id uuid,
    numero text,
    chave_acesso text,
    valor_total numeric(14,2),
    arquivo_url text,
    emitida_em date,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notificacoes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notificacoes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    alerta_id uuid,
    canal public.canal_notificacao DEFAULT 'whatsapp'::public.canal_notificacao NOT NULL,
    destinatario text,
    mensagem text NOT NULL,
    status public.status_notificacao DEFAULT 'pendente'::public.status_notificacao NOT NULL,
    enviado_em timestamp with time zone,
    erro text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: organizacao_modulos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizacao_modulos (
    organizacao_id uuid NOT NULL,
    modulo_id text NOT NULL,
    habilitado_em timestamp with time zone DEFAULT now() NOT NULL,
    habilitado_por uuid
);


--
-- Name: organizacoes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizacoes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nome text NOT NULL,
    cnpj text,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    logo_url text,
    responsavel_nome text,
    responsavel_email text,
    telefone text,
    status public.status_organizacao DEFAULT 'ativa'::public.status_organizacao NOT NULL,
    trial_expira_em timestamp with time zone,
    plano_id uuid,
    observacoes text,
    eh_modelo boolean DEFAULT false NOT NULL,
    modelo_origem_id uuid
);


--
-- Name: painel_administrativo_usuarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.painel_administrativo_usuarios (
    usuario_id uuid NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    criado_por uuid,
    observacao text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: parametros; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parametros (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    chave text NOT NULL,
    valor jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: parser_fd_auditoria; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parser_fd_auditoria (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    importacao_id uuid NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    acao text NOT NULL,
    codigos_antes jsonb,
    codigos_depois jsonb,
    taxas_validas_antes numeric(14,2),
    taxas_validas_depois numeric(14,2),
    motivo text,
    snapshot jsonb,
    usuario_id uuid,
    usuario_nome text,
    usuario_email text,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    pedido_id uuid,
    numero_pedido text,
    classificacao_antes text,
    classificacao_depois text,
    CONSTRAINT parser_fd_auditoria_acao_check CHECK ((acao = ANY (ARRAY['importacao_criada'::text, 'codigos_alterados'::text, 'excluida'::text, 'classificacao_alterada'::text])))
);


--
-- Name: parser_fd_importacoes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parser_fd_importacoes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    periodo_inicio date NOT NULL,
    periodo_fim date NOT NULL,
    nome_arquivo text,
    hash_arquivo text NOT NULL,
    arquivo_storage text,
    total_pedidos integer DEFAULT 0 NOT NULL,
    entregues integer DEFAULT 0 NOT NULL,
    cancelados integer DEFAULT 0 NOT NULL,
    cancelados_com_taxa integer DEFAULT 0 NOT NULL,
    cancelados_sem_taxa integer DEFAULT 0 NOT NULL,
    taxas_brutas numeric(14,2) DEFAULT 0 NOT NULL,
    taxas_descartadas numeric(14,2) DEFAULT 0 NOT NULL,
    taxas_validas numeric(14,2) DEFAULT 0 NOT NULL,
    codigos_sem_taxa jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'concluida'::text NOT NULL,
    mensagem_erro text,
    usuario_id uuid,
    usuario_nome text,
    usuario_email text,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL,
    pedidos_subway integer DEFAULT 0 NOT NULL,
    pedidos_acai integer DEFAULT 0 NOT NULL,
    pedidos_revisao integer DEFAULT 0 NOT NULL,
    coluna_detalhes_encontrada boolean DEFAULT true NOT NULL,
    pedidos_sem_entregador integer DEFAULT 0 NOT NULL,
    cancelados_recebem_taxa integer DEFAULT 0 NOT NULL,
    cancelados_nao_recebem_taxa integer DEFAULT 0 NOT NULL,
    cancelados_revisao integer DEFAULT 0 NOT NULL,
    CONSTRAINT parser_fd_importacoes_status_check CHECK ((status = ANY (ARRAY['concluida'::text, 'erro'::text])))
);


--
-- Name: parser_fd_pedidos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parser_fd_pedidos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    importacao_id uuid NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    numero_pedido text NOT NULL,
    data_hora timestamp with time zone,
    situacao text,
    entregador text,
    taxa_entregador numeric(14,2),
    valor_total_pedido numeric(14,2),
    forma_pagamento text,
    razao_cancelamento text,
    justificativa_cancelamento text,
    data_entregue timestamp with time zone,
    data_finalizado timestamp with time zone,
    data_cancelado timestamp with time zone,
    origem text,
    sem_taxa_informado boolean DEFAULT false NOT NULL,
    status_conciliacao text,
    dados_brutos jsonb NOT NULL,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    operacao text DEFAULT 'subway'::text NOT NULL,
    operacao_motivo text,
    detalhes_pedido text,
    data_pronto timestamp with time zone,
    data_despachado timestamp with time zone,
    data_aceito timestamp with time zone,
    data_coletado timestamp with time zone,
    data_chegada_entrega timestamp with time zone,
    data_rejeitado timestamp with time zone,
    razao_rejeicao text,
    justificativa_rejeicao text,
    classificacao_cancelamento text,
    classificacao_motivo text,
    classificacao_nivel_confianca text,
    classificacao_regra text,
    classificacao_original text,
    classificacao_override_usuario_id uuid,
    classificacao_override_usuario_nome text,
    classificacao_override_usuario_email text,
    classificacao_override_motivo text,
    classificacao_override_em timestamp with time zone,
    CONSTRAINT parser_fd_pedidos_classificacao_cancelamento_check CHECK ((classificacao_cancelamento = ANY (ARRAY['recebe_taxa'::text, 'nao_recebe_taxa'::text, 'revisar'::text]))),
    CONSTRAINT parser_fd_pedidos_classificacao_nivel_confianca_check CHECK ((classificacao_nivel_confianca = ANY (ARRAY['muito_alta'::text, 'alta'::text, 'inconclusiva'::text]))),
    CONSTRAINT parser_fd_pedidos_operacao_check CHECK ((operacao = ANY (ARRAY['subway'::text, 'acai_no_grau'::text, 'revisao_necessaria'::text]))),
    CONSTRAINT parser_fd_pedidos_status_conciliacao_check CHECK ((status_conciliacao = ANY (ARRAY['incluido'::text, 'excluido'::text, 'cancelado_com_taxa'::text])))
);


--
-- Name: pedidos_compra; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pedidos_compra (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    fornecedor_id uuid NOT NULL,
    status public.status_pedido DEFAULT 'rascunho'::public.status_pedido NOT NULL,
    data_pedido date DEFAULT CURRENT_DATE NOT NULL,
    data_entrega_prevista date,
    data_entrega_real date,
    valor_total numeric(14,2) DEFAULT 0 NOT NULL,
    observacao text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pedidos_compra_itens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pedidos_compra_itens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pedido_compra_id uuid NOT NULL,
    insumo_id uuid NOT NULL,
    quantidade numeric(14,3) NOT NULL,
    quantidade_recebida numeric(14,3),
    custo_unitario numeric(12,6) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: perfis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.perfis (
    id uuid NOT NULL,
    organizacao_id uuid,
    unidade_id uuid,
    nome text NOT NULL,
    email text,
    papel public.papel_usuario DEFAULT 'operador'::public.papel_usuario NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    senha_provisoria boolean DEFAULT false NOT NULL
);


--
-- Name: perfis_operacionais; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.perfis_operacionais (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conta_id uuid NOT NULL,
    nome text NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    pin_hash text,
    pin_tentativas integer DEFAULT 0 NOT NULL,
    pin_bloqueado_ate timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    pin_atualizado_em timestamp with time zone
);


--
-- Name: planos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    codigo text NOT NULL,
    nome text NOT NULL,
    descricao text,
    preco_mensal numeric(12,2) DEFAULT 0 NOT NULL,
    preco_anual numeric(12,2) DEFAULT 0 NOT NULL,
    limite_unidades integer,
    limite_usuarios integer,
    recursos jsonb DEFAULT '{}'::jsonb NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    ordem integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: plataforma_acessos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plataforma_acessos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    superadmin_id uuid NOT NULL,
    organizacao_id uuid,
    acao text DEFAULT 'acessar_organizacao'::text NOT NULL,
    contexto jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: plataforma_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plataforma_admins (
    usuario_id uuid NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    observacao text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: plataforma_auditoria; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plataforma_auditoria (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ator_id uuid,
    ator_email text,
    ator_tipo text DEFAULT 'usuario'::text NOT NULL,
    acao text NOT NULL,
    entidade text,
    entidade_id text,
    organizacao_id uuid,
    impersonado_por uuid,
    detalhes jsonb DEFAULT '{}'::jsonb NOT NULL,
    ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    perfil_id uuid
);


--
-- Name: plataforma_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plataforma_config (
    chave text NOT NULL,
    valor jsonb DEFAULT 'null'::jsonb NOT NULL,
    secreto boolean DEFAULT false NOT NULL,
    descricao text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);


--
-- Name: produto_historico; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.produto_historico (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    produto_id uuid NOT NULL,
    alteracao_id uuid NOT NULL,
    campo text NOT NULL,
    rotulo text NOT NULL,
    valor_anterior text,
    valor_novo text,
    usuario_id uuid,
    usuario_nome text,
    usuario_email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: produto_precos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.produto_precos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    produto_id uuid NOT NULL,
    canal public.canal NOT NULL,
    tabela text,
    preco numeric(12,2) NOT NULL,
    desatualizado boolean DEFAULT false NOT NULL,
    atualizado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: produtos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.produtos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    categoria_id uuid,
    tipo public.tipo_produto DEFAULT 'outro'::public.tipo_produto NOT NULL,
    nome text NOT NULL,
    sku text,
    codigo_pdv text,
    tamanho public.tamanho_produto,
    vendavel boolean DEFAULT true NOT NULL,
    custo_cache numeric(12,4),
    imagem_url text,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    custo_manual numeric(12,4)
);


--
-- Name: sessoes_contexto; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessoes_contexto (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    usuario_id uuid NOT NULL,
    organizacao_id uuid NOT NULL,
    unidade_id uuid,
    papel public.papel_acesso NOT NULL,
    permissoes jsonb DEFAULT '[]'::jsonb NOT NULL,
    impersonado_por uuid,
    ip text,
    user_agent text,
    criada_em timestamp with time zone DEFAULT now() NOT NULL,
    ultimo_uso_em timestamp with time zone DEFAULT now() NOT NULL,
    expira_em timestamp with time zone NOT NULL,
    revogada_em timestamp with time zone,
    motivo_revogacao text,
    modulos jsonb DEFAULT '[]'::jsonb NOT NULL,
    perfil_id uuid,
    selecao_nonce text,
    CONSTRAINT sessoes_contexto_perfil_xor_impersonacao CHECK ((((perfil_id IS NOT NULL) AND (impersonado_por IS NULL)) OR ((perfil_id IS NULL) AND (impersonado_por IS NOT NULL))))
);


--
-- Name: sw_combo_componentes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sw_combo_componentes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    codigo_sw text NOT NULL,
    produto_id uuid NOT NULL,
    quantidade numeric(10,3) DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sw_faturamento_diario; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sw_faturamento_diario (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    importacao_id uuid,
    data_movimento date NOT NULL,
    produtos numeric(14,2) DEFAULT 0,
    repiques numeric(14,2) DEFAULT 0,
    servicos numeric(14,2) DEFAULT 0,
    taxas_entrega numeric(14,2) DEFAULT 0,
    creditos numeric(14,2) DEFAULT 0,
    descontos numeric(14,2) DEFAULT 0,
    combos numeric(14,2) DEFAULT 0,
    especiais numeric(14,2) DEFAULT 0,
    cortesias numeric(14,2) DEFAULT 0,
    assinadas numeric(14,2) DEFAULT 0,
    total numeric(14,2) DEFAULT 0,
    faturamento numeric(14,2) DEFAULT 0,
    diferenca numeric(14,2) DEFAULT 0,
    origem text DEFAULT 'manual'::text NOT NULL,
    canal text DEFAULT 'balcao'::text NOT NULL,
    criado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sw_mapeamento_produtos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sw_mapeamento_produtos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    codigo_sw text NOT NULL,
    nome_sw text,
    tipo_item text DEFAULT 'produto'::text NOT NULL,
    produto_id uuid,
    ignorar_no_cmv boolean DEFAULT false NOT NULL,
    ignorar_no_estoque boolean DEFAULT false NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sw_produtos_vendidos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sw_produtos_vendidos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    importacao_id uuid,
    data_movimento date NOT NULL,
    grupo text,
    codigo_sw text,
    nome_sw text,
    quantidade numeric(14,3) DEFAULT 0 NOT NULL,
    valor_total numeric(14,2) DEFAULT 0 NOT NULL,
    preco_medio numeric(14,4) DEFAULT 0,
    tipo_item text DEFAULT 'produto'::text NOT NULL,
    produto_id uuid,
    custo_teorico numeric(14,4),
    ignorar_no_cmv boolean DEFAULT false NOT NULL,
    ignorar_no_estoque boolean DEFAULT false NOT NULL,
    origem text DEFAULT 'manual'::text NOT NULL,
    canal text DEFAULT 'balcao'::text NOT NULL,
    criado_em timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: unidade_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unidade_config (
    unidade_id uuid NOT NULL,
    cmv_saudavel numeric(5,2),
    cmv_atencao numeric(5,2),
    meta_fat_dia numeric(14,2),
    meta_fat_mes numeric(14,2),
    margem_minima numeric(5,2),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    atualizado_por uuid,
    CONSTRAINT unidade_config_cmv_atencao_check CHECK (((cmv_atencao IS NULL) OR ((cmv_atencao >= (0)::numeric) AND (cmv_atencao <= (100)::numeric)))),
    CONSTRAINT unidade_config_cmv_saudavel_check CHECK (((cmv_saudavel IS NULL) OR ((cmv_saudavel >= (0)::numeric) AND (cmv_saudavel <= (100)::numeric)))),
    CONSTRAINT unidade_config_faixas_coerentes CHECK (((cmv_saudavel IS NULL) OR (cmv_atencao IS NULL) OR (cmv_saudavel <= cmv_atencao))),
    CONSTRAINT unidade_config_margem_minima_check CHECK (((margem_minima IS NULL) OR ((margem_minima >= (0)::numeric) AND (margem_minima <= (100)::numeric)))),
    CONSTRAINT unidade_config_meta_fat_dia_check CHECK (((meta_fat_dia IS NULL) OR (meta_fat_dia >= (0)::numeric))),
    CONSTRAINT unidade_config_meta_fat_mes_check CHECK (((meta_fat_mes IS NULL) OR (meta_fat_mes >= (0)::numeric)))
);


--
-- Name: unidade_modelo_logistico_historico; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unidade_modelo_logistico_historico (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    organizacao_id uuid NOT NULL,
    modelo_anterior public.modelo_logistico_ifood_enum,
    modelo_novo public.modelo_logistico_ifood_enum NOT NULL,
    usuario_id uuid,
    usuario_nome text,
    usuario_email text,
    motivo text,
    observacao text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: unidade_modulos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unidade_modulos (
    unidade_id uuid NOT NULL,
    modulo_id text NOT NULL,
    habilitado_em timestamp with time zone DEFAULT now() NOT NULL,
    habilitado_por uuid
);


--
-- Name: unidade_tabela_comercial_historico; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unidade_tabela_comercial_historico (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    organizacao_id uuid NOT NULL,
    canal text NOT NULL,
    tabela_anterior text,
    tabela_nova text NOT NULL,
    usuario_id uuid,
    usuario_nome text,
    usuario_email text,
    origem text DEFAULT 'tenant'::text NOT NULL,
    motivo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT unidade_tabela_comercial_historico_canal_check CHECK ((canal = ANY (ARRAY['balcao'::text, 'ifood'::text]))),
    CONSTRAINT unidade_tabela_comercial_historico_origem_check CHECK ((origem = ANY (ARRAY['tenant'::text, 'superadmin'::text])))
);


--
-- Name: unidades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unidades (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacao_id uuid NOT NULL,
    nome text NOT NULL,
    cnpj text,
    endereco text,
    telefone text,
    responsavel text,
    email text,
    cidade text,
    estado text,
    tabela_balcao text,
    tabela_ifood text,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    modelo_logistico_ifood public.modelo_logistico_ifood_enum DEFAULT 'full_service'::public.modelo_logistico_ifood_enum NOT NULL,
    eh_teste boolean DEFAULT false NOT NULL
);


--
-- Name: usuarios_organizacoes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usuarios_organizacoes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    usuario_id uuid NOT NULL,
    organizacao_id uuid NOT NULL,
    papel public.papel_acesso DEFAULT 'viewer'::public.papel_acesso NOT NULL,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    perfil_id uuid NOT NULL,
    CONSTRAINT uo_papel_valido CHECK ((papel <> 'platform_superadmin'::public.papel_acesso))
);


--
-- Name: usuarios_unidades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usuarios_unidades (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    usuario_id uuid NOT NULL,
    unidade_id uuid NOT NULL,
    papel public.papel_acesso,
    ativo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    perfil_id uuid NOT NULL,
    CONSTRAINT uu_papel_valido CHECK (((papel IS NULL) OR (papel <> 'platform_superadmin'::public.papel_acesso)))
);


--
-- Name: vendas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unidade_id uuid NOT NULL,
    origem public.canal DEFAULT 'balcao'::public.canal NOT NULL,
    external_id text,
    data_hora timestamp with time zone DEFAULT now() NOT NULL,
    valor_total numeric(14,2) DEFAULT 0 NOT NULL,
    forma_pagamento public.forma_pagamento,
    status public.status_venda DEFAULT 'concluida'::public.status_venda NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vendas_itens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendas_itens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    venda_id uuid NOT NULL,
    produto_id uuid NOT NULL,
    quantidade numeric(12,3) DEFAULT 1 NOT NULL,
    preco_unitario numeric(12,2) DEFAULT 0 NOT NULL,
    valor_total numeric(14,2) DEFAULT 0 NOT NULL,
    custo_unitario_snapshot numeric(12,6),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vw_estoque_critico; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_estoque_critico AS
 SELECT e.unidade_id,
    e.insumo_id,
    i.nome AS insumo,
    e.quantidade_atual,
    e.estoque_minimo,
    i.unidade_medida
   FROM (public.estoque e
     JOIN public.insumos i ON ((i.id = e.insumo_id)))
  WHERE (e.quantidade_atual <= e.estoque_minimo);


--
-- Name: vw_faturamento_diario; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_faturamento_diario AS
 SELECT unidade_id,
    ((data_hora AT TIME ZONE 'America/Sao_Paulo'::text))::date AS dia,
    origem,
    count(*) AS qtd_vendas,
    sum(valor_total) AS faturamento
   FROM public.vendas
  WHERE (status = 'concluida'::public.status_venda)
  GROUP BY unidade_id, (((data_hora AT TIME ZONE 'America/Sao_Paulo'::text))::date), origem;


--
-- Name: vw_produto_margem; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_produto_margem AS
 SELECT p.id AS produto_id,
    p.organizacao_id,
    p.nome,
    p.tamanho,
    pp.canal,
    pp.tabela,
    pp.preco,
    pp.desatualizado,
    public.fn_custo_produto(p.id) AS custo,
    COALESCE(cv.comissao_pct, (0)::numeric) AS comissao_pct,
    round(((pp.preco * ((1)::numeric - COALESCE(cv.comissao_pct, (0)::numeric))) - public.fn_custo_produto(p.id)), 2) AS lucro_liquido,
        CASE
            WHEN (pp.preco > (0)::numeric) THEN round(((public.fn_custo_produto(p.id) / pp.preco) * (100)::numeric), 2)
            ELSE NULL::numeric
        END AS cmv_pct
   FROM ((public.produtos p
     JOIN public.produto_precos pp ON ((pp.produto_id = p.id)))
     LEFT JOIN public.canais_venda cv ON (((cv.organizacao_id = p.organizacao_id) AND (cv.canal = pp.canal))))
  WHERE p.vendavel;


--
-- Name: vw_produtos_vendidos; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vw_produtos_vendidos AS
 SELECT v.unidade_id,
    vi.produto_id,
    p.nome,
    sum(vi.quantidade) AS qtd_total,
    sum(vi.valor_total) AS receita_total
   FROM ((public.vendas_itens vi
     JOIN public.vendas v ON (((v.id = vi.venda_id) AND (v.status = 'concluida'::public.status_venda))))
     JOIN public.produtos p ON ((p.id = vi.produto_id)))
  GROUP BY v.unidade_id, vi.produto_id, p.nome;


--
-- Name: agente_conversas agente_conversas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agente_conversas
    ADD CONSTRAINT agente_conversas_pkey PRIMARY KEY (id);


--
-- Name: agente_mensagens agente_mensagens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agente_mensagens
    ADD CONSTRAINT agente_mensagens_pkey PRIMARY KEY (id);


--
-- Name: agente_quota_uso agente_quota_uso_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agente_quota_uso
    ADD CONSTRAINT agente_quota_uso_pkey PRIMARY KEY (escopo, chave, janela_segundos, janela_inicio);


--
-- Name: agente_uso agente_uso_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agente_uso
    ADD CONSTRAINT agente_uso_pkey PRIMARY KEY (id);


--
-- Name: alertas alertas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alertas
    ADD CONSTRAINT alertas_pkey PRIMARY KEY (id);


--
-- Name: assinaturas assinaturas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assinaturas
    ADD CONSTRAINT assinaturas_pkey PRIMARY KEY (id);


--
-- Name: bonificacao_importacoes bonificacao_importacoes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_importacoes
    ADD CONSTRAINT bonificacao_importacoes_pkey PRIMARY KEY (id);


--
-- Name: bonificacao_lancamentos_diarios bonificacao_lancamentos_diarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_lancamentos_diarios
    ADD CONSTRAINT bonificacao_lancamentos_diarios_pkey PRIMARY KEY (id);


--
-- Name: bonificacao_lancamentos_diarios bonificacao_lancamentos_diarios_unidade_id_data_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_lancamentos_diarios
    ADD CONSTRAINT bonificacao_lancamentos_diarios_unidade_id_data_key UNIQUE (unidade_id, data);


--
-- Name: bonificacao_lancamentos_exclusoes bonificacao_lancamentos_exclusoes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_lancamentos_exclusoes
    ADD CONSTRAINT bonificacao_lancamentos_exclusoes_pkey PRIMARY KEY (id);


--
-- Name: bonificacao_metas_faixas bonificacao_metas_faixas_meta_id_ordem_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_metas_faixas
    ADD CONSTRAINT bonificacao_metas_faixas_meta_id_ordem_key UNIQUE (meta_id, ordem);


--
-- Name: bonificacao_metas_faixas bonificacao_metas_faixas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_metas_faixas
    ADD CONSTRAINT bonificacao_metas_faixas_pkey PRIMARY KEY (id);


--
-- Name: bonificacao_metas bonificacao_metas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_metas
    ADD CONSTRAINT bonificacao_metas_pkey PRIMARY KEY (id);


--
-- Name: bonificacao_rev_mensal bonificacao_rev_mensal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_rev_mensal
    ADD CONSTRAINT bonificacao_rev_mensal_pkey PRIMARY KEY (id);


--
-- Name: bonificacao_rev_mensal bonificacao_rev_mensal_unidade_id_ano_mes_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_rev_mensal
    ADD CONSTRAINT bonificacao_rev_mensal_unidade_id_ano_mes_key UNIQUE (unidade_id, ano, mes);


--
-- Name: canais_venda canais_venda_organizacao_id_canal_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canais_venda
    ADD CONSTRAINT canais_venda_organizacao_id_canal_key UNIQUE (organizacao_id, canal);


--
-- Name: canais_venda canais_venda_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canais_venda
    ADD CONSTRAINT canais_venda_pkey PRIMARY KEY (id);


--
-- Name: categorias categorias_organizacao_id_nome_tipo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categorias
    ADD CONSTRAINT categorias_organizacao_id_nome_tipo_key UNIQUE (organizacao_id, nome, tipo);


--
-- Name: categorias categorias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categorias
    ADD CONSTRAINT categorias_pkey PRIMARY KEY (id);


--
-- Name: cobrancas cobrancas_organizacao_id_competencia_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobrancas
    ADD CONSTRAINT cobrancas_organizacao_id_competencia_key UNIQUE (organizacao_id, competencia);


--
-- Name: cobrancas cobrancas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobrancas
    ADD CONSTRAINT cobrancas_pkey PRIMARY KEY (id);


--
-- Name: dashboard_teste_reset_log dashboard_teste_reset_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_teste_reset_log
    ADD CONSTRAINT dashboard_teste_reset_log_pkey PRIMARY KEY (id);


--
-- Name: divergencias_compra divergencias_compra_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.divergencias_compra
    ADD CONSTRAINT divergencias_compra_pkey PRIMARY KEY (id);


--
-- Name: divergencias_vendas divergencias_vendas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.divergencias_vendas
    ADD CONSTRAINT divergencias_vendas_pkey PRIMARY KEY (id);


--
-- Name: estoque estoque_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estoque
    ADD CONSTRAINT estoque_pkey PRIMARY KEY (id);


--
-- Name: estoque estoque_unidade_id_insumo_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estoque
    ADD CONSTRAINT estoque_unidade_id_insumo_id_key UNIQUE (unidade_id, insumo_id);


--
-- Name: ficha_tecnica ficha_tecnica_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ficha_tecnica
    ADD CONSTRAINT ficha_tecnica_pkey PRIMARY KEY (id);


--
-- Name: fornecedores fornecedores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fornecedores
    ADD CONSTRAINT fornecedores_pkey PRIMARY KEY (id);


--
-- Name: ifood_conexoes ifood_conexoes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ifood_conexoes
    ADD CONSTRAINT ifood_conexoes_pkey PRIMARY KEY (id);


--
-- Name: ifood_credenciais ifood_credenciais_conexao_id_app_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ifood_credenciais
    ADD CONSTRAINT ifood_credenciais_conexao_id_app_type_key UNIQUE (conexao_id, app_type);


--
-- Name: ifood_credenciais ifood_credenciais_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ifood_credenciais
    ADD CONSTRAINT ifood_credenciais_pkey PRIMARY KEY (id);


--
-- Name: ifood_oauth_sessoes ifood_oauth_sessoes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ifood_oauth_sessoes
    ADD CONSTRAINT ifood_oauth_sessoes_pkey PRIMARY KEY (id);


--
-- Name: importacoes_vendas importacoes_vendas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.importacoes_vendas
    ADD CONSTRAINT importacoes_vendas_pkey PRIMARY KEY (id);


--
-- Name: insights_ia insights_ia_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insights_ia
    ADD CONSTRAINT insights_ia_pkey PRIMARY KEY (id);


--
-- Name: insumo_historico insumo_historico_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insumo_historico
    ADD CONSTRAINT insumo_historico_pkey PRIMARY KEY (id);


--
-- Name: insumos insumos_organizacao_id_codigo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insumos
    ADD CONSTRAINT insumos_organizacao_id_codigo_key UNIQUE (organizacao_id, codigo);


--
-- Name: insumos insumos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insumos
    ADD CONSTRAINT insumos_pkey PRIMARY KEY (id);


--
-- Name: lancamentos_financeiros_auditoria lancamentos_financeiros_auditoria_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_auditoria
    ADD CONSTRAINT lancamentos_financeiros_auditoria_pkey PRIMARY KEY (id);


--
-- Name: lancamentos_financeiros_diarios lancamentos_financeiros_diarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_diarios
    ADD CONSTRAINT lancamentos_financeiros_diarios_pkey PRIMARY KEY (id);


--
-- Name: lancamentos_financeiros_diarios lancamentos_financeiros_diarios_unidade_id_data_lancamento_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_diarios
    ADD CONSTRAINT lancamentos_financeiros_diarios_unidade_id_data_lancamento_key UNIQUE (unidade_id, data_lancamento);


--
-- Name: lancamentos_financeiros_distribuicao_mensal_auditoria lancamentos_financeiros_distribuicao_mensal_auditoria_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_distribuicao_mensal_auditoria
    ADD CONSTRAINT lancamentos_financeiros_distribuicao_mensal_auditoria_pkey PRIMARY KEY (id);


--
-- Name: lancamentos_financeiros_distribuicao_mensal lancamentos_financeiros_distribuicao_mensal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_distribuicao_mensal
    ADD CONSTRAINT lancamentos_financeiros_distribuicao_mensal_pkey PRIMARY KEY (id);


--
-- Name: lancamentos_financeiros_exclusoes lancamentos_financeiros_exclusoes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_exclusoes
    ADD CONSTRAINT lancamentos_financeiros_exclusoes_pkey PRIMARY KEY (id);


--
-- Name: lotes lotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lotes
    ADD CONSTRAINT lotes_pkey PRIMARY KEY (id);


--
-- Name: martin_brower_filtros martin_brower_filtros_organizacao_id_unidade_id_tipo_valor_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_filtros
    ADD CONSTRAINT martin_brower_filtros_organizacao_id_unidade_id_tipo_valor_key UNIQUE (organizacao_id, unidade_id, tipo, valor);


--
-- Name: martin_brower_filtros martin_brower_filtros_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_filtros
    ADD CONSTRAINT martin_brower_filtros_pkey PRIMARY KEY (id);


--
-- Name: martin_brower_integracoes martin_brower_integracoes_organizacao_id_unidade_id_client__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_integracoes
    ADD CONSTRAINT martin_brower_integracoes_organizacao_id_unidade_id_client__key UNIQUE (organizacao_id, unidade_id, client_id);


--
-- Name: martin_brower_integracoes martin_brower_integracoes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_integracoes
    ADD CONSTRAINT martin_brower_integracoes_pkey PRIMARY KEY (id);


--
-- Name: martin_brower_precos_historico martin_brower_precos_historico_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_precos_historico
    ADD CONSTRAINT martin_brower_precos_historico_pkey PRIMARY KEY (id);


--
-- Name: martin_brower_produtos martin_brower_produtos_organizacao_id_unidade_id_client_id__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_produtos
    ADD CONSTRAINT martin_brower_produtos_organizacao_id_unidade_id_client_id__key UNIQUE (organizacao_id, unidade_id, client_id, codigo);


--
-- Name: martin_brower_produtos martin_brower_produtos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_produtos
    ADD CONSTRAINT martin_brower_produtos_pkey PRIMARY KEY (id);


--
-- Name: martin_brower_sincronizacoes martin_brower_sincronizacoes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_sincronizacoes
    ADD CONSTRAINT martin_brower_sincronizacoes_pkey PRIMARY KEY (id);


--
-- Name: martin_brower_vinculos martin_brower_vinculos_mb_produto_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_vinculos
    ADD CONSTRAINT martin_brower_vinculos_mb_produto_id_key UNIQUE (mb_produto_id);


--
-- Name: martin_brower_vinculos martin_brower_vinculos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_vinculos
    ADD CONSTRAINT martin_brower_vinculos_pkey PRIMARY KEY (id);


--
-- Name: metas_indicadores metas_indicadores_org_uni_ind_modelo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metas_indicadores
    ADD CONSTRAINT metas_indicadores_org_uni_ind_modelo_key UNIQUE (organizacao_id, unidade_id, indicador, modelo_logistico);


--
-- Name: metas_indicadores metas_indicadores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metas_indicadores
    ADD CONSTRAINT metas_indicadores_pkey PRIMARY KEY (id);


--
-- Name: modulos modulos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modulos
    ADD CONSTRAINT modulos_pkey PRIMARY KEY (id);


--
-- Name: movimentacoes_estoque movimentacoes_estoque_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimentacoes_estoque
    ADD CONSTRAINT movimentacoes_estoque_pkey PRIMARY KEY (id);


--
-- Name: notas_fiscais notas_fiscais_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notas_fiscais
    ADD CONSTRAINT notas_fiscais_pkey PRIMARY KEY (id);


--
-- Name: notificacoes notificacoes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notificacoes
    ADD CONSTRAINT notificacoes_pkey PRIMARY KEY (id);


--
-- Name: organizacao_modulos organizacao_modulos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizacao_modulos
    ADD CONSTRAINT organizacao_modulos_pkey PRIMARY KEY (organizacao_id, modulo_id);


--
-- Name: organizacoes organizacoes_cnpj_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizacoes
    ADD CONSTRAINT organizacoes_cnpj_key UNIQUE (cnpj);


--
-- Name: organizacoes organizacoes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizacoes
    ADD CONSTRAINT organizacoes_pkey PRIMARY KEY (id);


--
-- Name: painel_administrativo_usuarios painel_administrativo_usuarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.painel_administrativo_usuarios
    ADD CONSTRAINT painel_administrativo_usuarios_pkey PRIMARY KEY (usuario_id);


--
-- Name: parametros parametros_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parametros
    ADD CONSTRAINT parametros_pkey PRIMARY KEY (id);


--
-- Name: parametros parametros_unidade_id_chave_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parametros
    ADD CONSTRAINT parametros_unidade_id_chave_key UNIQUE (unidade_id, chave);


--
-- Name: parser_fd_auditoria parser_fd_auditoria_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_fd_auditoria
    ADD CONSTRAINT parser_fd_auditoria_pkey PRIMARY KEY (id);


--
-- Name: parser_fd_importacoes parser_fd_importacoes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_fd_importacoes
    ADD CONSTRAINT parser_fd_importacoes_pkey PRIMARY KEY (id);


--
-- Name: parser_fd_pedidos parser_fd_pedidos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_fd_pedidos
    ADD CONSTRAINT parser_fd_pedidos_pkey PRIMARY KEY (id);


--
-- Name: pedidos_compra_itens pedidos_compra_itens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedidos_compra_itens
    ADD CONSTRAINT pedidos_compra_itens_pkey PRIMARY KEY (id);


--
-- Name: pedidos_compra pedidos_compra_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedidos_compra
    ADD CONSTRAINT pedidos_compra_pkey PRIMARY KEY (id);


--
-- Name: perfis_operacionais perfis_operacionais_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perfis_operacionais
    ADD CONSTRAINT perfis_operacionais_pkey PRIMARY KEY (id);


--
-- Name: perfis perfis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perfis
    ADD CONSTRAINT perfis_pkey PRIMARY KEY (id);


--
-- Name: planos planos_codigo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planos
    ADD CONSTRAINT planos_codigo_key UNIQUE (codigo);


--
-- Name: planos planos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planos
    ADD CONSTRAINT planos_pkey PRIMARY KEY (id);


--
-- Name: plataforma_acessos plataforma_acessos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plataforma_acessos
    ADD CONSTRAINT plataforma_acessos_pkey PRIMARY KEY (id);


--
-- Name: plataforma_admins plataforma_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plataforma_admins
    ADD CONSTRAINT plataforma_admins_pkey PRIMARY KEY (usuario_id);


--
-- Name: plataforma_auditoria plataforma_auditoria_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plataforma_auditoria
    ADD CONSTRAINT plataforma_auditoria_pkey PRIMARY KEY (id);


--
-- Name: plataforma_config plataforma_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plataforma_config
    ADD CONSTRAINT plataforma_config_pkey PRIMARY KEY (chave);


--
-- Name: produto_historico produto_historico_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produto_historico
    ADD CONSTRAINT produto_historico_pkey PRIMARY KEY (id);


--
-- Name: produto_precos produto_precos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produto_precos
    ADD CONSTRAINT produto_precos_pkey PRIMARY KEY (id);


--
-- Name: produto_precos produto_precos_produto_id_canal_tabela_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produto_precos
    ADD CONSTRAINT produto_precos_produto_id_canal_tabela_key UNIQUE (produto_id, canal, tabela);


--
-- Name: produtos produtos_organizacao_id_sku_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produtos
    ADD CONSTRAINT produtos_organizacao_id_sku_key UNIQUE (organizacao_id, sku);


--
-- Name: produtos produtos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produtos
    ADD CONSTRAINT produtos_pkey PRIMARY KEY (id);


--
-- Name: sessoes_contexto sessoes_contexto_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessoes_contexto
    ADD CONSTRAINT sessoes_contexto_pkey PRIMARY KEY (id);


--
-- Name: sw_combo_componentes sw_combo_componentes_organizacao_id_codigo_sw_produto_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_combo_componentes
    ADD CONSTRAINT sw_combo_componentes_organizacao_id_codigo_sw_produto_id_key UNIQUE (organizacao_id, codigo_sw, produto_id);


--
-- Name: sw_combo_componentes sw_combo_componentes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_combo_componentes
    ADD CONSTRAINT sw_combo_componentes_pkey PRIMARY KEY (id);


--
-- Name: sw_faturamento_diario sw_faturamento_diario_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_faturamento_diario
    ADD CONSTRAINT sw_faturamento_diario_pkey PRIMARY KEY (id);


--
-- Name: sw_faturamento_diario sw_faturamento_diario_unidade_id_data_movimento_canal_orige_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_faturamento_diario
    ADD CONSTRAINT sw_faturamento_diario_unidade_id_data_movimento_canal_orige_key UNIQUE (unidade_id, data_movimento, canal, origem);


--
-- Name: sw_mapeamento_produtos sw_mapeamento_produtos_organizacao_id_codigo_sw_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_mapeamento_produtos
    ADD CONSTRAINT sw_mapeamento_produtos_organizacao_id_codigo_sw_key UNIQUE (organizacao_id, codigo_sw);


--
-- Name: sw_mapeamento_produtos sw_mapeamento_produtos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_mapeamento_produtos
    ADD CONSTRAINT sw_mapeamento_produtos_pkey PRIMARY KEY (id);


--
-- Name: sw_produtos_vendidos sw_produtos_vendidos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_produtos_vendidos
    ADD CONSTRAINT sw_produtos_vendidos_pkey PRIMARY KEY (id);


--
-- Name: unidade_config unidade_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidade_config
    ADD CONSTRAINT unidade_config_pkey PRIMARY KEY (unidade_id);


--
-- Name: unidade_modelo_logistico_historico unidade_modelo_logistico_historico_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidade_modelo_logistico_historico
    ADD CONSTRAINT unidade_modelo_logistico_historico_pkey PRIMARY KEY (id);


--
-- Name: unidade_modulos unidade_modulos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidade_modulos
    ADD CONSTRAINT unidade_modulos_pkey PRIMARY KEY (unidade_id, modulo_id);


--
-- Name: unidade_tabela_comercial_historico unidade_tabela_comercial_historico_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidade_tabela_comercial_historico
    ADD CONSTRAINT unidade_tabela_comercial_historico_pkey PRIMARY KEY (id);


--
-- Name: unidades unidades_cnpj_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidades
    ADD CONSTRAINT unidades_cnpj_key UNIQUE (cnpj);


--
-- Name: unidades unidades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidades
    ADD CONSTRAINT unidades_pkey PRIMARY KEY (id);


--
-- Name: usuarios_organizacoes uo_perfil_org_unico; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios_organizacoes
    ADD CONSTRAINT uo_perfil_org_unico UNIQUE (perfil_id, organizacao_id);


--
-- Name: usuarios_organizacoes usuarios_organizacoes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios_organizacoes
    ADD CONSTRAINT usuarios_organizacoes_pkey PRIMARY KEY (id);


--
-- Name: usuarios_unidades usuarios_unidades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios_unidades
    ADD CONSTRAINT usuarios_unidades_pkey PRIMARY KEY (id);


--
-- Name: usuarios_unidades uu_perfil_uni_unico; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios_unidades
    ADD CONSTRAINT uu_perfil_uni_unico UNIQUE (perfil_id, unidade_id);


--
-- Name: vendas_itens vendas_itens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendas_itens
    ADD CONSTRAINT vendas_itens_pkey PRIMARY KEY (id);


--
-- Name: vendas vendas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendas
    ADD CONSTRAINT vendas_pkey PRIMARY KEY (id);


--
-- Name: vendas vendas_unidade_id_origem_external_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendas
    ADD CONSTRAINT vendas_unidade_id_origem_external_id_key UNIQUE (unidade_id, origem, external_id);


--
-- Name: idx_agente_conversas_escopo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agente_conversas_escopo ON public.agente_conversas USING btree (usuario_id, organizacao_id, unidade_id);


--
-- Name: idx_agente_conversas_escopo_perfil; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agente_conversas_escopo_perfil ON public.agente_conversas USING btree (perfil_id, organizacao_id, unidade_id);


--
-- Name: idx_agente_conversas_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agente_conversas_org ON public.agente_conversas USING btree (organizacao_id);


--
-- Name: idx_agente_mensagens_conversa; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agente_mensagens_conversa ON public.agente_mensagens USING btree (conversa_id, criado_em);


--
-- Name: idx_agente_uso_conversa; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agente_uso_conversa ON public.agente_uso USING btree (conversa_id);


--
-- Name: idx_agente_uso_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agente_uso_data ON public.agente_uso USING btree (created_at);


--
-- Name: idx_agente_uso_model; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agente_uso_model ON public.agente_uso USING btree (model, created_at);


--
-- Name: idx_agente_uso_organizacao_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agente_uso_organizacao_data ON public.agente_uso USING btree (organizacao_id, created_at);


--
-- Name: idx_alertas_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alertas_status ON public.alertas USING btree (status);


--
-- Name: idx_alertas_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alertas_unidade ON public.alertas USING btree (unidade_id);


--
-- Name: idx_assinaturas_org_viva; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_assinaturas_org_viva ON public.assinaturas USING btree (organizacao_id) WHERE (cancelado_em IS NULL);


--
-- Name: idx_assinaturas_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assinaturas_status ON public.assinaturas USING btree (status);


--
-- Name: idx_audit_acao; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_acao ON public.plataforma_auditoria USING btree (acao);


--
-- Name: idx_audit_ator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_ator ON public.plataforma_auditoria USING btree (ator_id);


--
-- Name: idx_audit_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_data ON public.plataforma_auditoria USING btree (created_at DESC);


--
-- Name: idx_audit_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_org ON public.plataforma_auditoria USING btree (organizacao_id);


--
-- Name: idx_audit_perfil; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_perfil ON public.plataforma_auditoria USING btree (perfil_id);


--
-- Name: idx_bfaixa_meta; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bfaixa_meta ON public.bonificacao_metas_faixas USING btree (meta_id, ordem);


--
-- Name: idx_bimp_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bimp_org ON public.bonificacao_importacoes USING btree (organizacao_id);


--
-- Name: idx_bimp_unidade_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bimp_unidade_data ON public.bonificacao_importacoes USING btree (unidade_id, data_lancamento DESC);


--
-- Name: idx_bld_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bld_org ON public.bonificacao_lancamentos_diarios USING btree (organizacao_id);


--
-- Name: idx_bld_unidade_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bld_unidade_data ON public.bonificacao_lancamentos_diarios USING btree (unidade_id, data DESC);


--
-- Name: idx_ble_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ble_org ON public.bonificacao_lancamentos_exclusoes USING btree (organizacao_id);


--
-- Name: idx_ble_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ble_unidade ON public.bonificacao_lancamentos_exclusoes USING btree (unidade_id, data_lancamento DESC);


--
-- Name: idx_bmeta_unidade_indicador; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bmeta_unidade_indicador ON public.bonificacao_metas USING btree (unidade_id, indicador, valid_from DESC);


--
-- Name: idx_brm_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brm_org ON public.bonificacao_rev_mensal USING btree (organizacao_id);


--
-- Name: idx_brm_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brm_unidade ON public.bonificacao_rev_mensal USING btree (unidade_id, ano DESC, mes DESC);


--
-- Name: idx_categorias_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categorias_org ON public.categorias USING btree (organizacao_id);


--
-- Name: idx_cobrancas_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cobrancas_org ON public.cobrancas USING btree (organizacao_id);


--
-- Name: idx_cobrancas_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cobrancas_status ON public.cobrancas USING btree (status);


--
-- Name: idx_cobrancas_vencimento; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cobrancas_vencimento ON public.cobrancas USING btree (vencimento);


--
-- Name: idx_diverg_pedido; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diverg_pedido ON public.divergencias_compra USING btree (pedido_compra_id);


--
-- Name: idx_divv_import; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_divv_import ON public.divergencias_vendas USING btree (importacao_id);


--
-- Name: idx_divv_nivel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_divv_nivel ON public.divergencias_vendas USING btree (nivel) WHERE (resolvida = false);


--
-- Name: idx_divv_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_divv_unidade ON public.divergencias_vendas USING btree (unidade_id);


--
-- Name: idx_dtrl_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dtrl_org ON public.dashboard_teste_reset_log USING btree (organizacao_id);


--
-- Name: idx_dtrl_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dtrl_unidade ON public.dashboard_teste_reset_log USING btree (unidade_id, created_at DESC);


--
-- Name: idx_estoque_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_estoque_unidade ON public.estoque USING btree (unidade_id);


--
-- Name: idx_ficha_insumo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ficha_insumo ON public.ficha_tecnica USING btree (insumo_id);


--
-- Name: idx_ficha_produto; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ficha_produto ON public.ficha_tecnica USING btree (produto_id);


--
-- Name: idx_ficha_subproduto; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ficha_subproduto ON public.ficha_tecnica USING btree (subproduto_id);


--
-- Name: idx_fornecedores_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fornecedores_org ON public.fornecedores USING btree (organizacao_id);


--
-- Name: idx_ifood_conexoes_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ifood_conexoes_org ON public.ifood_conexoes USING btree (organizacao_id);


--
-- Name: idx_ifood_conexoes_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ifood_conexoes_unidade ON public.ifood_conexoes USING btree (unidade_id, status);


--
-- Name: idx_ifood_cred_conexao; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ifood_cred_conexao ON public.ifood_credenciais USING btree (conexao_id);


--
-- Name: idx_ifood_oauth_expira; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ifood_oauth_expira ON public.ifood_oauth_sessoes USING btree (expira_em) WHERE (status = 'pending'::text);


--
-- Name: idx_ifood_oauth_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ifood_oauth_unidade ON public.ifood_oauth_sessoes USING btree (unidade_id, status);


--
-- Name: idx_impv_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_impv_data ON public.importacoes_vendas USING btree (data_movimento);


--
-- Name: idx_impv_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_impv_unidade ON public.importacoes_vendas USING btree (unidade_id);


--
-- Name: idx_insumo_hist_insumo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_insumo_hist_insumo ON public.insumo_historico USING btree (insumo_id, created_at DESC);


--
-- Name: idx_insumo_hist_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_insumo_hist_org ON public.insumo_historico USING btree (organizacao_id);


--
-- Name: idx_insumos_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_insumos_org ON public.insumos USING btree (organizacao_id);


--
-- Name: idx_insumos_tipo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_insumos_tipo ON public.insumos USING btree (tipo);


--
-- Name: idx_lfa_lancamento; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lfa_lancamento ON public.lancamentos_financeiros_auditoria USING btree (lancamento_id, created_at DESC);


--
-- Name: idx_lfa_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lfa_org ON public.lancamentos_financeiros_auditoria USING btree (organizacao_id);


--
-- Name: idx_lfd_distribuicao; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lfd_distribuicao ON public.lancamentos_financeiros_diarios USING btree (distribuicao_mensal_id) WHERE (distribuicao_mensal_id IS NOT NULL);


--
-- Name: idx_lfd_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lfd_org ON public.lancamentos_financeiros_diarios USING btree (organizacao_id);


--
-- Name: idx_lfd_unidade_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lfd_unidade_data ON public.lancamentos_financeiros_diarios USING btree (unidade_id, data_lancamento DESC);


--
-- Name: idx_lfdm_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lfdm_org ON public.lancamentos_financeiros_distribuicao_mensal USING btree (organizacao_id);


--
-- Name: idx_lfdm_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lfdm_unidade ON public.lancamentos_financeiros_distribuicao_mensal USING btree (unidade_id, ano, mes);


--
-- Name: idx_lfdma_lote; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lfdma_lote ON public.lancamentos_financeiros_distribuicao_mensal_auditoria USING btree (distribuicao_mensal_id);


--
-- Name: idx_lfdma_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lfdma_org ON public.lancamentos_financeiros_distribuicao_mensal_auditoria USING btree (organizacao_id);


--
-- Name: idx_lfdma_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lfdma_unidade ON public.lancamentos_financeiros_distribuicao_mensal_auditoria USING btree (unidade_id, ano, mes);


--
-- Name: idx_lfe_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lfe_org ON public.lancamentos_financeiros_exclusoes USING btree (organizacao_id);


--
-- Name: idx_lfe_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lfe_unidade ON public.lancamentos_financeiros_exclusoes USING btree (unidade_id, data_lancamento DESC);


--
-- Name: idx_lotes_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lotes_unidade ON public.lotes USING btree (unidade_id);


--
-- Name: idx_lotes_validade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lotes_validade ON public.lotes USING btree (data_validade);


--
-- Name: idx_mb_filtros_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mb_filtros_org ON public.martin_brower_filtros USING btree (organizacao_id, ativo);


--
-- Name: idx_mb_hist_produto; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mb_hist_produto ON public.martin_brower_precos_historico USING btree (produto_id, coletado_em DESC);


--
-- Name: idx_mb_hist_sync; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mb_hist_sync ON public.martin_brower_precos_historico USING btree (sincronizacao_id);


--
-- Name: idx_mb_hist_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mb_hist_unidade ON public.martin_brower_precos_historico USING btree (unidade_id, coletado_em DESC);


--
-- Name: idx_mb_integracoes_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mb_integracoes_org ON public.martin_brower_integracoes USING btree (organizacao_id);


--
-- Name: idx_mb_prod_codigo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mb_prod_codigo ON public.martin_brower_produtos USING btree (organizacao_id, codigo);


--
-- Name: idx_mb_prod_grupo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mb_prod_grupo ON public.martin_brower_produtos USING btree (unidade_id, grupo_descricao);


--
-- Name: idx_mb_prod_ignorado; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mb_prod_ignorado ON public.martin_brower_produtos USING btree (unidade_id, ignorado);


--
-- Name: idx_mb_prod_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mb_prod_unidade ON public.martin_brower_produtos USING btree (unidade_id, client_id);


--
-- Name: idx_mb_sync_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mb_sync_org ON public.martin_brower_sincronizacoes USING btree (organizacao_id, iniciado_em DESC);


--
-- Name: idx_mb_sync_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mb_sync_unidade ON public.martin_brower_sincronizacoes USING btree (unidade_id, iniciado_em DESC);


--
-- Name: idx_mb_vinc_insumo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mb_vinc_insumo ON public.martin_brower_vinculos USING btree (insumo_id);


--
-- Name: idx_mb_vinc_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mb_vinc_unidade ON public.martin_brower_vinculos USING btree (unidade_id);


--
-- Name: idx_metas_globais_unicas; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_metas_globais_unicas ON public.metas_indicadores USING btree (indicador, modelo_logistico) WHERE ((organizacao_id IS NULL) AND (unidade_id IS NULL));


--
-- Name: idx_mov_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mov_data ON public.movimentacoes_estoque USING btree (created_at);


--
-- Name: idx_mov_insumo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mov_insumo ON public.movimentacoes_estoque USING btree (insumo_id);


--
-- Name: idx_mov_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mov_unidade ON public.movimentacoes_estoque USING btree (unidade_id);


--
-- Name: idx_nf_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nf_unidade ON public.notas_fiscais USING btree (unidade_id);


--
-- Name: idx_notif_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notif_unidade ON public.notificacoes USING btree (unidade_id);


--
-- Name: idx_organizacao_modulos_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_organizacao_modulos_org ON public.organizacao_modulos USING btree (organizacao_id);


--
-- Name: idx_organizacoes_eh_modelo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_organizacoes_eh_modelo ON public.organizacoes USING btree (eh_modelo) WHERE eh_modelo;


--
-- Name: idx_organizacoes_plano; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_organizacoes_plano ON public.organizacoes USING btree (plano_id);


--
-- Name: idx_organizacoes_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_organizacoes_status ON public.organizacoes USING btree (status);


--
-- Name: idx_pa_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pa_data ON public.plataforma_acessos USING btree (created_at);


--
-- Name: idx_pa_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pa_org ON public.plataforma_acessos USING btree (organizacao_id);


--
-- Name: idx_pa_superadmin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pa_superadmin ON public.plataforma_acessos USING btree (superadmin_id);


--
-- Name: idx_pedidos_itens_pedido; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pedidos_itens_pedido ON public.pedidos_compra_itens USING btree (pedido_compra_id);


--
-- Name: idx_pedidos_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pedidos_unidade ON public.pedidos_compra USING btree (unidade_id);


--
-- Name: idx_perfis_op_conta; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_perfis_op_conta ON public.perfis_operacionais USING btree (conta_id);


--
-- Name: idx_perfis_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_perfis_org ON public.perfis USING btree (organizacao_id);


--
-- Name: idx_perfis_senha_provisoria; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_perfis_senha_provisoria ON public.perfis USING btree (id) WHERE senha_provisoria;


--
-- Name: idx_pfdaud_importacao; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pfdaud_importacao ON public.parser_fd_auditoria USING btree (importacao_id, criado_em DESC);


--
-- Name: idx_pfdaud_pedido; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pfdaud_pedido ON public.parser_fd_auditoria USING btree (pedido_id);


--
-- Name: idx_pfdaud_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pfdaud_unidade ON public.parser_fd_auditoria USING btree (unidade_id, criado_em DESC);


--
-- Name: idx_pfdimp_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pfdimp_org ON public.parser_fd_importacoes USING btree (organizacao_id);


--
-- Name: idx_pfdimp_unidade_periodo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pfdimp_unidade_periodo ON public.parser_fd_importacoes USING btree (unidade_id, periodo_inicio DESC);


--
-- Name: idx_pfdped_classificacao; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pfdped_classificacao ON public.parser_fd_pedidos USING btree (importacao_id, classificacao_cancelamento);


--
-- Name: idx_pfdped_entregador; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pfdped_entregador ON public.parser_fd_pedidos USING btree (importacao_id, entregador);


--
-- Name: idx_pfdped_importacao_numero; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pfdped_importacao_numero ON public.parser_fd_pedidos USING btree (importacao_id, numero_pedido);


--
-- Name: idx_pfdped_operacao; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pfdped_operacao ON public.parser_fd_pedidos USING btree (importacao_id, operacao);


--
-- Name: idx_pfdped_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pfdped_status ON public.parser_fd_pedidos USING btree (importacao_id, status_conciliacao);


--
-- Name: idx_pfdped_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pfdped_unidade ON public.parser_fd_pedidos USING btree (unidade_id, data_hora DESC);


--
-- Name: idx_precos_canal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_precos_canal ON public.produto_precos USING btree (canal, tabela);


--
-- Name: idx_precos_produto; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_precos_produto ON public.produto_precos USING btree (produto_id);


--
-- Name: idx_prod_hist_alteracao; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prod_hist_alteracao ON public.produto_historico USING btree (alteracao_id);


--
-- Name: idx_prod_hist_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prod_hist_org ON public.produto_historico USING btree (organizacao_id);


--
-- Name: idx_prod_hist_produto; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prod_hist_produto ON public.produto_historico USING btree (produto_id, created_at DESC);


--
-- Name: idx_produtos_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_produtos_org ON public.produtos USING btree (organizacao_id);


--
-- Name: idx_produtos_vendavel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_produtos_vendavel ON public.produtos USING btree (vendavel);


--
-- Name: idx_sessoes_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessoes_org ON public.sessoes_contexto USING btree (organizacao_id);


--
-- Name: idx_sessoes_perfil_vivas; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessoes_perfil_vivas ON public.sessoes_contexto USING btree (perfil_id) WHERE (revogada_em IS NULL);


--
-- Name: idx_sessoes_usuario; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessoes_usuario ON public.sessoes_contexto USING btree (usuario_id);


--
-- Name: idx_sessoes_vivas; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessoes_vivas ON public.sessoes_contexto USING btree (ultimo_uso_em DESC) WHERE (revogada_em IS NULL);


--
-- Name: idx_swcombo_org_cod; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swcombo_org_cod ON public.sw_combo_componentes USING btree (organizacao_id, codigo_sw);


--
-- Name: idx_swfat_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swfat_unidade ON public.sw_faturamento_diario USING btree (unidade_id, data_movimento);


--
-- Name: idx_swmap_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swmap_org ON public.sw_mapeamento_produtos USING btree (organizacao_id);


--
-- Name: idx_swmap_produto; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swmap_produto ON public.sw_mapeamento_produtos USING btree (produto_id);


--
-- Name: idx_swpv_codigo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swpv_codigo ON public.sw_produtos_vendidos USING btree (codigo_sw);


--
-- Name: idx_swpv_import; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swpv_import ON public.sw_produtos_vendidos USING btree (importacao_id);


--
-- Name: idx_swpv_produto; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swpv_produto ON public.sw_produtos_vendidos USING btree (produto_id);


--
-- Name: idx_swpv_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swpv_unidade ON public.sw_produtos_vendidos USING btree (unidade_id, data_movimento);


--
-- Name: idx_umlh_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_umlh_org ON public.unidade_modelo_logistico_historico USING btree (organizacao_id);


--
-- Name: idx_umlh_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_umlh_unidade ON public.unidade_modelo_logistico_historico USING btree (unidade_id, created_at DESC);


--
-- Name: idx_unidade_modulos_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_unidade_modulos_unidade ON public.unidade_modulos USING btree (unidade_id);


--
-- Name: idx_unidades_eh_teste; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_unidades_eh_teste ON public.unidades USING btree (eh_teste) WHERE eh_teste;


--
-- Name: idx_unidades_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_unidades_org ON public.unidades USING btree (organizacao_id);


--
-- Name: idx_uo_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uo_org ON public.usuarios_organizacoes USING btree (organizacao_id);


--
-- Name: idx_uo_perfil; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uo_perfil ON public.usuarios_organizacoes USING btree (perfil_id);


--
-- Name: idx_uo_usuario; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uo_usuario ON public.usuarios_organizacoes USING btree (usuario_id);


--
-- Name: idx_utch_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_utch_org ON public.unidade_tabela_comercial_historico USING btree (organizacao_id);


--
-- Name: idx_utch_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_utch_unidade ON public.unidade_tabela_comercial_historico USING btree (unidade_id, canal, created_at DESC);


--
-- Name: idx_uu_perfil; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uu_perfil ON public.usuarios_unidades USING btree (perfil_id);


--
-- Name: idx_uu_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uu_unidade ON public.usuarios_unidades USING btree (unidade_id);


--
-- Name: idx_uu_usuario; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uu_usuario ON public.usuarios_unidades USING btree (usuario_id);


--
-- Name: idx_vendas_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendas_data ON public.vendas USING btree (data_hora);


--
-- Name: idx_vendas_itens_produto; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendas_itens_produto ON public.vendas_itens USING btree (produto_id);


--
-- Name: idx_vendas_itens_venda; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendas_itens_venda ON public.vendas_itens USING btree (venda_id);


--
-- Name: idx_vendas_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendas_unidade ON public.vendas USING btree (unidade_id);


--
-- Name: ix_agente_quota_uso_janela; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agente_quota_uso_janela ON public.agente_quota_uso USING btree (janela_inicio);


--
-- Name: uq_bimp_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_bimp_hash ON public.bonificacao_importacoes USING btree (unidade_id, tipo_relatorio, hash_arquivo) WHERE ((hash_arquivo IS NOT NULL) AND (status = 'concluida'::text));


--
-- Name: uq_bmeta_unidade_indicador_from; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_bmeta_unidade_indicador_from ON public.bonificacao_metas USING btree (unidade_id, indicador, valid_from);


--
-- Name: uq_ficha_insumo; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ficha_insumo ON public.ficha_tecnica USING btree (produto_id, insumo_id) WHERE (insumo_id IS NOT NULL);


--
-- Name: uq_ficha_subproduto; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ficha_subproduto ON public.ficha_tecnica USING btree (produto_id, subproduto_id) WHERE (subproduto_id IS NOT NULL);


--
-- Name: uq_ifood_conexao_merchant_vivo; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ifood_conexao_merchant_vivo ON public.ifood_conexoes USING btree (merchant_id) WHERE ((merchant_id IS NOT NULL) AND (status <> 'revogada'::text));


--
-- Name: uq_ifood_conexao_unidade_viva; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ifood_conexao_unidade_viva ON public.ifood_conexoes USING btree (unidade_id) WHERE (status <> 'revogada'::text);


--
-- Name: uq_impv_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_impv_hash ON public.importacoes_vendas USING btree (unidade_id, tipo_relatorio, hash_arquivo) WHERE (hash_arquivo IS NOT NULL);


--
-- Name: uq_mb_filtros_regra_org; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_mb_filtros_regra_org ON public.martin_brower_filtros USING btree (organizacao_id, tipo, valor) WHERE (unidade_id IS NULL);


--
-- Name: uq_mb_filtros_regra_unidade; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_mb_filtros_regra_unidade ON public.martin_brower_filtros USING btree (organizacao_id, unidade_id, tipo, valor) WHERE (unidade_id IS NOT NULL);


--
-- Name: uq_mb_integracao_unidade_ativa; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_mb_integracao_unidade_ativa ON public.martin_brower_integracoes USING btree (unidade_id) WHERE ativo;


--
-- Name: uq_mb_sync_request; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_mb_sync_request ON public.martin_brower_sincronizacoes USING btree (organizacao_id, unidade_id, request_id) WHERE (request_id IS NOT NULL);


--
-- Name: uq_pfdimp_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_pfdimp_hash ON public.parser_fd_importacoes USING btree (unidade_id, hash_arquivo) WHERE (status = 'concluida'::text);


--
-- Name: uq_sessoes_selecao_nonce; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_sessoes_selecao_nonce ON public.sessoes_contexto USING btree (selecao_nonce) WHERE (selecao_nonce IS NOT NULL);


--
-- Name: agente_conversas trg_agente_conversas_atualizado_em; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_agente_conversas_atualizado_em BEFORE UPDATE ON public.agente_conversas FOR EACH ROW EXECUTE FUNCTION public.agente_conversas_set_atualizado_em();


--
-- Name: assinaturas trg_assinaturas_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_assinaturas_upd BEFORE UPDATE ON public.assinaturas FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: plataforma_auditoria trg_audit_sem_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_sem_delete BEFORE DELETE ON public.plataforma_auditoria FOR EACH ROW EXECUTE FUNCTION public.bloquear_alteracao_auditoria();


--
-- Name: plataforma_auditoria trg_audit_sem_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_sem_truncate BEFORE TRUNCATE ON public.plataforma_auditoria FOR EACH STATEMENT EXECUTE FUNCTION public.bloquear_alteracao_auditoria();


--
-- Name: plataforma_auditoria trg_audit_sem_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_sem_update BEFORE UPDATE ON public.plataforma_auditoria FOR EACH ROW EXECUTE FUNCTION public.bloquear_alteracao_auditoria();


--
-- Name: vendas_itens trg_baixa_estoque_venda; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_baixa_estoque_venda AFTER INSERT ON public.vendas_itens FOR EACH ROW EXECUTE FUNCTION public.fn_baixa_estoque_venda();


--
-- Name: bonificacao_lancamentos_diarios trg_bld_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bld_upd BEFORE UPDATE ON public.bonificacao_lancamentos_diarios FOR EACH ROW EXECUTE FUNCTION public.bonificacao_set_atualizado_em();


--
-- Name: bonificacao_metas trg_bmeta_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bmeta_upd BEFORE UPDATE ON public.bonificacao_metas FOR EACH ROW EXECUTE FUNCTION public.bonificacao_set_atualizado_em();


--
-- Name: bonificacao_rev_mensal trg_brm_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_brm_upd BEFORE UPDATE ON public.bonificacao_rev_mensal FOR EACH ROW EXECUTE FUNCTION public.bonificacao_set_atualizado_em();


--
-- Name: cobrancas trg_cobrancas_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cobrancas_upd BEFORE UPDATE ON public.cobrancas FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ficha_tecnica trg_ficha_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ficha_upd BEFORE UPDATE ON public.ficha_tecnica FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: fornecedores trg_forn_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_forn_upd BEFORE UPDATE ON public.fornecedores FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ifood_conexoes trg_ifood_conexoes_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ifood_conexoes_upd BEFORE UPDATE ON public.ifood_conexoes FOR EACH ROW EXECUTE FUNCTION public.ifood_touch_atualizado_em();


--
-- Name: ifood_credenciais trg_ifood_cred_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ifood_cred_upd BEFORE UPDATE ON public.ifood_credenciais FOR EACH ROW EXECUTE FUNCTION public.ifood_touch_atualizado_em();


--
-- Name: ifood_oauth_sessoes trg_ifood_oauth_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ifood_oauth_upd BEFORE UPDATE ON public.ifood_oauth_sessoes FOR EACH ROW EXECUTE FUNCTION public.ifood_touch_atualizado_em();


--
-- Name: insumos trg_insumos_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_insumos_upd BEFORE UPDATE ON public.insumos FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: lancamentos_financeiros_diarios trg_lfd_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_lfd_upd BEFORE UPDATE ON public.lancamentos_financeiros_diarios FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: martin_brower_filtros trg_mb_filtros_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_mb_filtros_upd BEFORE UPDATE ON public.martin_brower_filtros FOR EACH ROW EXECUTE FUNCTION public.mb_touch_atualizado_em();


--
-- Name: martin_brower_integracoes trg_mb_integracoes_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_mb_integracoes_upd BEFORE UPDATE ON public.martin_brower_integracoes FOR EACH ROW EXECUTE FUNCTION public.mb_touch_atualizado_em();


--
-- Name: martin_brower_produtos trg_mb_produtos_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_mb_produtos_upd BEFORE UPDATE ON public.martin_brower_produtos FOR EACH ROW EXECUTE FUNCTION public.mb_touch_atualizado_em();


--
-- Name: martin_brower_vinculos trg_mb_vinculos_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_mb_vinculos_upd BEFORE UPDATE ON public.martin_brower_vinculos FOR EACH ROW EXECUTE FUNCTION public.mb_touch_atualizado_em();


--
-- Name: metas_indicadores trg_metas_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_metas_upd BEFORE UPDATE ON public.metas_indicadores FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: organizacoes trg_org_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_org_upd BEFORE UPDATE ON public.organizacoes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: plataforma_admins trg_padm_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_padm_upd BEFORE UPDATE ON public.plataforma_admins FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: painel_administrativo_usuarios trg_padmadm_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_padmadm_upd BEFORE UPDATE ON public.painel_administrativo_usuarios FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: parametros trg_param_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_param_upd BEFORE UPDATE ON public.parametros FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: plataforma_config trg_pconfig_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pconfig_upd BEFORE UPDATE ON public.plataforma_config FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: pedidos_compra trg_pedidos_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pedidos_upd BEFORE UPDATE ON public.pedidos_compra FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: perfis_operacionais trg_perfis_op_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_perfis_op_upd BEFORE UPDATE ON public.perfis_operacionais FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: perfis trg_perfis_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_perfis_upd BEFORE UPDATE ON public.perfis FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: parser_fd_importacoes trg_pfdimp_atualizado_em; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pfdimp_atualizado_em BEFORE UPDATE ON public.parser_fd_importacoes FOR EACH ROW EXECUTE FUNCTION public.parser_fd_set_atualizado_em();


--
-- Name: planos trg_planos_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_planos_upd BEFORE UPDATE ON public.planos FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: produtos trg_prod_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_prod_upd BEFORE UPDATE ON public.produtos FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: unidades trg_und_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_und_upd BEFORE UPDATE ON public.unidades FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: unidade_config trg_unidade_config_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_unidade_config_updated_at BEFORE UPDATE ON public.unidade_config FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: usuarios_organizacoes trg_uo_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_uo_upd BEFORE UPDATE ON public.usuarios_organizacoes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: usuarios_unidades trg_uu_upd; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_uu_upd BEFORE UPDATE ON public.usuarios_unidades FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: agente_conversas agente_conversas_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agente_conversas
    ADD CONSTRAINT agente_conversas_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: agente_conversas agente_conversas_perfil_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agente_conversas
    ADD CONSTRAINT agente_conversas_perfil_id_fk FOREIGN KEY (perfil_id) REFERENCES public.perfis_operacionais(id) ON DELETE SET NULL;


--
-- Name: agente_conversas agente_conversas_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agente_conversas
    ADD CONSTRAINT agente_conversas_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: agente_conversas agente_conversas_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agente_conversas
    ADD CONSTRAINT agente_conversas_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: agente_mensagens agente_mensagens_conversa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agente_mensagens
    ADD CONSTRAINT agente_mensagens_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES public.agente_conversas(id) ON DELETE CASCADE;


--
-- Name: agente_uso agente_uso_conversa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agente_uso
    ADD CONSTRAINT agente_uso_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES public.agente_conversas(id) ON DELETE SET NULL;


--
-- Name: agente_uso agente_uso_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agente_uso
    ADD CONSTRAINT agente_uso_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: agente_uso agente_uso_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agente_uso
    ADD CONSTRAINT agente_uso_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE SET NULL;


--
-- Name: agente_uso agente_uso_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agente_uso
    ADD CONSTRAINT agente_uso_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: alertas alertas_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alertas
    ADD CONSTRAINT alertas_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: assinaturas assinaturas_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assinaturas
    ADD CONSTRAINT assinaturas_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: assinaturas assinaturas_plano_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assinaturas
    ADD CONSTRAINT assinaturas_plano_id_fkey FOREIGN KEY (plano_id) REFERENCES public.planos(id) ON DELETE RESTRICT;


--
-- Name: bonificacao_importacoes bonificacao_importacoes_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_importacoes
    ADD CONSTRAINT bonificacao_importacoes_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: bonificacao_importacoes bonificacao_importacoes_substituiu_importacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_importacoes
    ADD CONSTRAINT bonificacao_importacoes_substituiu_importacao_id_fkey FOREIGN KEY (substituiu_importacao_id) REFERENCES public.bonificacao_importacoes(id) ON DELETE SET NULL;


--
-- Name: bonificacao_importacoes bonificacao_importacoes_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_importacoes
    ADD CONSTRAINT bonificacao_importacoes_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: bonificacao_importacoes bonificacao_importacoes_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_importacoes
    ADD CONSTRAINT bonificacao_importacoes_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: bonificacao_lancamentos_diarios bonificacao_lancamentos_diarios_importacao_geral_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_lancamentos_diarios
    ADD CONSTRAINT bonificacao_lancamentos_diarios_importacao_geral_id_fkey FOREIGN KEY (importacao_geral_id) REFERENCES public.bonificacao_importacoes(id) ON DELETE SET NULL;


--
-- Name: bonificacao_lancamentos_diarios bonificacao_lancamentos_diarios_importacao_loja_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_lancamentos_diarios
    ADD CONSTRAINT bonificacao_lancamentos_diarios_importacao_loja_id_fkey FOREIGN KEY (importacao_loja_id) REFERENCES public.bonificacao_importacoes(id) ON DELETE SET NULL;


--
-- Name: bonificacao_lancamentos_diarios bonificacao_lancamentos_diarios_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_lancamentos_diarios
    ADD CONSTRAINT bonificacao_lancamentos_diarios_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: bonificacao_lancamentos_diarios bonificacao_lancamentos_diarios_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_lancamentos_diarios
    ADD CONSTRAINT bonificacao_lancamentos_diarios_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: bonificacao_lancamentos_diarios bonificacao_lancamentos_diarios_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_lancamentos_diarios
    ADD CONSTRAINT bonificacao_lancamentos_diarios_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: bonificacao_lancamentos_exclusoes bonificacao_lancamentos_exclusoes_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_lancamentos_exclusoes
    ADD CONSTRAINT bonificacao_lancamentos_exclusoes_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: bonificacao_lancamentos_exclusoes bonificacao_lancamentos_exclusoes_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_lancamentos_exclusoes
    ADD CONSTRAINT bonificacao_lancamentos_exclusoes_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: bonificacao_lancamentos_exclusoes bonificacao_lancamentos_exclusoes_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_lancamentos_exclusoes
    ADD CONSTRAINT bonificacao_lancamentos_exclusoes_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: bonificacao_metas_faixas bonificacao_metas_faixas_meta_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_metas_faixas
    ADD CONSTRAINT bonificacao_metas_faixas_meta_id_fkey FOREIGN KEY (meta_id) REFERENCES public.bonificacao_metas(id) ON DELETE CASCADE;


--
-- Name: bonificacao_metas bonificacao_metas_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_metas
    ADD CONSTRAINT bonificacao_metas_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: bonificacao_metas bonificacao_metas_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_metas
    ADD CONSTRAINT bonificacao_metas_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: bonificacao_rev_mensal bonificacao_rev_mensal_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_rev_mensal
    ADD CONSTRAINT bonificacao_rev_mensal_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: bonificacao_rev_mensal bonificacao_rev_mensal_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_rev_mensal
    ADD CONSTRAINT bonificacao_rev_mensal_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: bonificacao_rev_mensal bonificacao_rev_mensal_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bonificacao_rev_mensal
    ADD CONSTRAINT bonificacao_rev_mensal_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: canais_venda canais_venda_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canais_venda
    ADD CONSTRAINT canais_venda_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: categorias categorias_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categorias
    ADD CONSTRAINT categorias_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: cobrancas cobrancas_assinatura_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobrancas
    ADD CONSTRAINT cobrancas_assinatura_id_fkey FOREIGN KEY (assinatura_id) REFERENCES public.assinaturas(id) ON DELETE SET NULL;


--
-- Name: cobrancas cobrancas_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cobrancas
    ADD CONSTRAINT cobrancas_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: dashboard_teste_reset_log dashboard_teste_reset_log_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_teste_reset_log
    ADD CONSTRAINT dashboard_teste_reset_log_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: dashboard_teste_reset_log dashboard_teste_reset_log_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_teste_reset_log
    ADD CONSTRAINT dashboard_teste_reset_log_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: dashboard_teste_reset_log dashboard_teste_reset_log_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_teste_reset_log
    ADD CONSTRAINT dashboard_teste_reset_log_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: divergencias_compra divergencias_compra_insumo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.divergencias_compra
    ADD CONSTRAINT divergencias_compra_insumo_id_fkey FOREIGN KEY (insumo_id) REFERENCES public.insumos(id) ON DELETE SET NULL;


--
-- Name: divergencias_compra divergencias_compra_pedido_compra_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.divergencias_compra
    ADD CONSTRAINT divergencias_compra_pedido_compra_id_fkey FOREIGN KEY (pedido_compra_id) REFERENCES public.pedidos_compra(id) ON DELETE CASCADE;


--
-- Name: divergencias_vendas divergencias_vendas_importacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.divergencias_vendas
    ADD CONSTRAINT divergencias_vendas_importacao_id_fkey FOREIGN KEY (importacao_id) REFERENCES public.importacoes_vendas(id) ON DELETE CASCADE;


--
-- Name: divergencias_vendas divergencias_vendas_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.divergencias_vendas
    ADD CONSTRAINT divergencias_vendas_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: estoque estoque_insumo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estoque
    ADD CONSTRAINT estoque_insumo_id_fkey FOREIGN KEY (insumo_id) REFERENCES public.insumos(id) ON DELETE CASCADE;


--
-- Name: estoque estoque_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estoque
    ADD CONSTRAINT estoque_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: ficha_tecnica ficha_tecnica_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ficha_tecnica
    ADD CONSTRAINT ficha_tecnica_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: ficha_tecnica ficha_tecnica_insumo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ficha_tecnica
    ADD CONSTRAINT ficha_tecnica_insumo_id_fkey FOREIGN KEY (insumo_id) REFERENCES public.insumos(id) ON DELETE RESTRICT;


--
-- Name: ficha_tecnica ficha_tecnica_produto_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ficha_tecnica
    ADD CONSTRAINT ficha_tecnica_produto_id_fkey FOREIGN KEY (produto_id) REFERENCES public.produtos(id) ON DELETE CASCADE;


--
-- Name: ficha_tecnica ficha_tecnica_subproduto_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ficha_tecnica
    ADD CONSTRAINT ficha_tecnica_subproduto_id_fkey FOREIGN KEY (subproduto_id) REFERENCES public.produtos(id) ON DELETE RESTRICT;


--
-- Name: fornecedores fornecedores_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fornecedores
    ADD CONSTRAINT fornecedores_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: ifood_conexoes ifood_conexoes_criado_por_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ifood_conexoes
    ADD CONSTRAINT ifood_conexoes_criado_por_fkey FOREIGN KEY (criado_por) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: ifood_conexoes ifood_conexoes_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ifood_conexoes
    ADD CONSTRAINT ifood_conexoes_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: ifood_conexoes ifood_conexoes_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ifood_conexoes
    ADD CONSTRAINT ifood_conexoes_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: ifood_credenciais ifood_credenciais_conexao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ifood_credenciais
    ADD CONSTRAINT ifood_credenciais_conexao_id_fkey FOREIGN KEY (conexao_id) REFERENCES public.ifood_conexoes(id) ON DELETE CASCADE;


--
-- Name: ifood_oauth_sessoes ifood_oauth_sessoes_criado_por_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ifood_oauth_sessoes
    ADD CONSTRAINT ifood_oauth_sessoes_criado_por_fkey FOREIGN KEY (criado_por) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: ifood_oauth_sessoes ifood_oauth_sessoes_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ifood_oauth_sessoes
    ADD CONSTRAINT ifood_oauth_sessoes_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: ifood_oauth_sessoes ifood_oauth_sessoes_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ifood_oauth_sessoes
    ADD CONSTRAINT ifood_oauth_sessoes_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: importacoes_vendas importacoes_vendas_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.importacoes_vendas
    ADD CONSTRAINT importacoes_vendas_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: insights_ia insights_ia_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insights_ia
    ADD CONSTRAINT insights_ia_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: insumo_historico insumo_historico_insumo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insumo_historico
    ADD CONSTRAINT insumo_historico_insumo_id_fkey FOREIGN KEY (insumo_id) REFERENCES public.insumos(id) ON DELETE CASCADE;


--
-- Name: insumo_historico insumo_historico_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insumo_historico
    ADD CONSTRAINT insumo_historico_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: insumo_historico insumo_historico_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insumo_historico
    ADD CONSTRAINT insumo_historico_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE SET NULL;


--
-- Name: insumo_historico insumo_historico_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insumo_historico
    ADD CONSTRAINT insumo_historico_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: insumos insumos_categoria_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insumos
    ADD CONSTRAINT insumos_categoria_id_fkey FOREIGN KEY (categoria_id) REFERENCES public.categorias(id) ON DELETE SET NULL;


--
-- Name: insumos insumos_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insumos
    ADD CONSTRAINT insumos_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: insumos insumos_fornecedor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insumos
    ADD CONSTRAINT insumos_fornecedor_id_fkey FOREIGN KEY (fornecedor_id) REFERENCES public.fornecedores(id) ON DELETE SET NULL;


--
-- Name: insumos insumos_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insumos
    ADD CONSTRAINT insumos_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: lancamentos_financeiros_auditoria lancamentos_financeiros_auditoria_lancamento_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_auditoria
    ADD CONSTRAINT lancamentos_financeiros_auditoria_lancamento_id_fkey FOREIGN KEY (lancamento_id) REFERENCES public.lancamentos_financeiros_diarios(id) ON DELETE CASCADE;


--
-- Name: lancamentos_financeiros_auditoria lancamentos_financeiros_auditoria_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_auditoria
    ADD CONSTRAINT lancamentos_financeiros_auditoria_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: lancamentos_financeiros_auditoria lancamentos_financeiros_auditoria_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_auditoria
    ADD CONSTRAINT lancamentos_financeiros_auditoria_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: lancamentos_financeiros_auditoria lancamentos_financeiros_auditoria_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_auditoria
    ADD CONSTRAINT lancamentos_financeiros_auditoria_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: lancamentos_financeiros_diarios lancamentos_financeiros_diarios_distribuicao_mensal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_diarios
    ADD CONSTRAINT lancamentos_financeiros_diarios_distribuicao_mensal_id_fkey FOREIGN KEY (distribuicao_mensal_id) REFERENCES public.lancamentos_financeiros_distribuicao_mensal(id) ON DELETE SET NULL;


--
-- Name: lancamentos_financeiros_diarios lancamentos_financeiros_diarios_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_diarios
    ADD CONSTRAINT lancamentos_financeiros_diarios_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: lancamentos_financeiros_diarios lancamentos_financeiros_diarios_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_diarios
    ADD CONSTRAINT lancamentos_financeiros_diarios_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: lancamentos_financeiros_diarios lancamentos_financeiros_diarios_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_diarios
    ADD CONSTRAINT lancamentos_financeiros_diarios_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: lancamentos_financeiros_distribuicao_mensal_auditoria lancamentos_financeiros_distribuica_distribuicao_mensal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_distribuicao_mensal_auditoria
    ADD CONSTRAINT lancamentos_financeiros_distribuica_distribuicao_mensal_id_fkey FOREIGN KEY (distribuicao_mensal_id) REFERENCES public.lancamentos_financeiros_distribuicao_mensal(id) ON DELETE SET NULL;


--
-- Name: lancamentos_financeiros_distribuicao_mensal lancamentos_financeiros_distribuicao_men_atualizado_por_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_distribuicao_mensal
    ADD CONSTRAINT lancamentos_financeiros_distribuicao_men_atualizado_por_id_fkey FOREIGN KEY (atualizado_por_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: lancamentos_financeiros_distribuicao_mensal_auditoria lancamentos_financeiros_distribuicao_mensa_organizacao_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_distribuicao_mensal_auditoria
    ADD CONSTRAINT lancamentos_financeiros_distribuicao_mensa_organizacao_id_fkey1 FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: lancamentos_financeiros_distribuicao_mensal_auditoria lancamentos_financeiros_distribuicao_mensal_aud_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_distribuicao_mensal_auditoria
    ADD CONSTRAINT lancamentos_financeiros_distribuicao_mensal_aud_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: lancamentos_financeiros_distribuicao_mensal_auditoria lancamentos_financeiros_distribuicao_mensal_aud_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_distribuicao_mensal_auditoria
    ADD CONSTRAINT lancamentos_financeiros_distribuicao_mensal_aud_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: lancamentos_financeiros_distribuicao_mensal lancamentos_financeiros_distribuicao_mensal_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_distribuicao_mensal
    ADD CONSTRAINT lancamentos_financeiros_distribuicao_mensal_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: lancamentos_financeiros_distribuicao_mensal lancamentos_financeiros_distribuicao_mensal_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_distribuicao_mensal
    ADD CONSTRAINT lancamentos_financeiros_distribuicao_mensal_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: lancamentos_financeiros_distribuicao_mensal lancamentos_financeiros_distribuicao_mensal_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_distribuicao_mensal
    ADD CONSTRAINT lancamentos_financeiros_distribuicao_mensal_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: lancamentos_financeiros_exclusoes lancamentos_financeiros_exclusoes_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_exclusoes
    ADD CONSTRAINT lancamentos_financeiros_exclusoes_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: lancamentos_financeiros_exclusoes lancamentos_financeiros_exclusoes_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_exclusoes
    ADD CONSTRAINT lancamentos_financeiros_exclusoes_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: lancamentos_financeiros_exclusoes lancamentos_financeiros_exclusoes_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lancamentos_financeiros_exclusoes
    ADD CONSTRAINT lancamentos_financeiros_exclusoes_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: lotes lotes_insumo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lotes
    ADD CONSTRAINT lotes_insumo_id_fkey FOREIGN KEY (insumo_id) REFERENCES public.insumos(id) ON DELETE CASCADE;


--
-- Name: lotes lotes_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lotes
    ADD CONSTRAINT lotes_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: martin_brower_filtros martin_brower_filtros_criado_por_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_filtros
    ADD CONSTRAINT martin_brower_filtros_criado_por_fkey FOREIGN KEY (criado_por) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: martin_brower_filtros martin_brower_filtros_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_filtros
    ADD CONSTRAINT martin_brower_filtros_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: martin_brower_filtros martin_brower_filtros_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_filtros
    ADD CONSTRAINT martin_brower_filtros_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: martin_brower_integracoes martin_brower_integracoes_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_integracoes
    ADD CONSTRAINT martin_brower_integracoes_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: martin_brower_integracoes martin_brower_integracoes_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_integracoes
    ADD CONSTRAINT martin_brower_integracoes_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: martin_brower_precos_historico martin_brower_precos_historico_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_precos_historico
    ADD CONSTRAINT martin_brower_precos_historico_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: martin_brower_precos_historico martin_brower_precos_historico_produto_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_precos_historico
    ADD CONSTRAINT martin_brower_precos_historico_produto_id_fkey FOREIGN KEY (produto_id) REFERENCES public.martin_brower_produtos(id) ON DELETE CASCADE;


--
-- Name: martin_brower_precos_historico martin_brower_precos_historico_sincronizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_precos_historico
    ADD CONSTRAINT martin_brower_precos_historico_sincronizacao_id_fkey FOREIGN KEY (sincronizacao_id) REFERENCES public.martin_brower_sincronizacoes(id) ON DELETE SET NULL;


--
-- Name: martin_brower_precos_historico martin_brower_precos_historico_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_precos_historico
    ADD CONSTRAINT martin_brower_precos_historico_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: martin_brower_produtos martin_brower_produtos_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_produtos
    ADD CONSTRAINT martin_brower_produtos_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: martin_brower_produtos martin_brower_produtos_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_produtos
    ADD CONSTRAINT martin_brower_produtos_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: martin_brower_sincronizacoes martin_brower_sincronizacoes_criado_por_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_sincronizacoes
    ADD CONSTRAINT martin_brower_sincronizacoes_criado_por_fkey FOREIGN KEY (criado_por) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: martin_brower_sincronizacoes martin_brower_sincronizacoes_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_sincronizacoes
    ADD CONSTRAINT martin_brower_sincronizacoes_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: martin_brower_sincronizacoes martin_brower_sincronizacoes_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_sincronizacoes
    ADD CONSTRAINT martin_brower_sincronizacoes_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: martin_brower_vinculos martin_brower_vinculos_confirmado_por_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_vinculos
    ADD CONSTRAINT martin_brower_vinculos_confirmado_por_fkey FOREIGN KEY (confirmado_por) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: martin_brower_vinculos martin_brower_vinculos_insumo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_vinculos
    ADD CONSTRAINT martin_brower_vinculos_insumo_id_fkey FOREIGN KEY (insumo_id) REFERENCES public.insumos(id) ON DELETE CASCADE;


--
-- Name: martin_brower_vinculos martin_brower_vinculos_mb_produto_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_vinculos
    ADD CONSTRAINT martin_brower_vinculos_mb_produto_id_fkey FOREIGN KEY (mb_produto_id) REFERENCES public.martin_brower_produtos(id) ON DELETE CASCADE;


--
-- Name: martin_brower_vinculos martin_brower_vinculos_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_vinculos
    ADD CONSTRAINT martin_brower_vinculos_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: martin_brower_vinculos martin_brower_vinculos_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.martin_brower_vinculos
    ADD CONSTRAINT martin_brower_vinculos_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: metas_indicadores metas_indicadores_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metas_indicadores
    ADD CONSTRAINT metas_indicadores_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: metas_indicadores metas_indicadores_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metas_indicadores
    ADD CONSTRAINT metas_indicadores_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: movimentacoes_estoque movimentacoes_estoque_insumo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimentacoes_estoque
    ADD CONSTRAINT movimentacoes_estoque_insumo_id_fkey FOREIGN KEY (insumo_id) REFERENCES public.insumos(id) ON DELETE RESTRICT;


--
-- Name: movimentacoes_estoque movimentacoes_estoque_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimentacoes_estoque
    ADD CONSTRAINT movimentacoes_estoque_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: movimentacoes_estoque movimentacoes_estoque_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimentacoes_estoque
    ADD CONSTRAINT movimentacoes_estoque_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: notas_fiscais notas_fiscais_pedido_compra_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notas_fiscais
    ADD CONSTRAINT notas_fiscais_pedido_compra_id_fkey FOREIGN KEY (pedido_compra_id) REFERENCES public.pedidos_compra(id) ON DELETE SET NULL;


--
-- Name: notas_fiscais notas_fiscais_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notas_fiscais
    ADD CONSTRAINT notas_fiscais_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: notificacoes notificacoes_alerta_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notificacoes
    ADD CONSTRAINT notificacoes_alerta_id_fkey FOREIGN KEY (alerta_id) REFERENCES public.alertas(id) ON DELETE SET NULL;


--
-- Name: notificacoes notificacoes_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notificacoes
    ADD CONSTRAINT notificacoes_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: organizacao_modulos organizacao_modulos_modulo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizacao_modulos
    ADD CONSTRAINT organizacao_modulos_modulo_id_fkey FOREIGN KEY (modulo_id) REFERENCES public.modulos(id) ON DELETE CASCADE;


--
-- Name: organizacao_modulos organizacao_modulos_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizacao_modulos
    ADD CONSTRAINT organizacao_modulos_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: organizacoes organizacoes_modelo_origem_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizacoes
    ADD CONSTRAINT organizacoes_modelo_origem_id_fkey FOREIGN KEY (modelo_origem_id) REFERENCES public.organizacoes(id) ON DELETE SET NULL;


--
-- Name: organizacoes organizacoes_plano_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizacoes
    ADD CONSTRAINT organizacoes_plano_id_fkey FOREIGN KEY (plano_id) REFERENCES public.planos(id) ON DELETE SET NULL;


--
-- Name: painel_administrativo_usuarios painel_administrativo_usuarios_criado_por_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.painel_administrativo_usuarios
    ADD CONSTRAINT painel_administrativo_usuarios_criado_por_fkey FOREIGN KEY (criado_por) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: painel_administrativo_usuarios painel_administrativo_usuarios_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.painel_administrativo_usuarios
    ADD CONSTRAINT painel_administrativo_usuarios_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: parametros parametros_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parametros
    ADD CONSTRAINT parametros_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: parser_fd_auditoria parser_fd_auditoria_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_fd_auditoria
    ADD CONSTRAINT parser_fd_auditoria_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: parser_fd_auditoria parser_fd_auditoria_pedido_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_fd_auditoria
    ADD CONSTRAINT parser_fd_auditoria_pedido_id_fkey FOREIGN KEY (pedido_id) REFERENCES public.parser_fd_pedidos(id) ON DELETE SET NULL;


--
-- Name: parser_fd_auditoria parser_fd_auditoria_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_fd_auditoria
    ADD CONSTRAINT parser_fd_auditoria_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: parser_fd_auditoria parser_fd_auditoria_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_fd_auditoria
    ADD CONSTRAINT parser_fd_auditoria_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: parser_fd_importacoes parser_fd_importacoes_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_fd_importacoes
    ADD CONSTRAINT parser_fd_importacoes_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: parser_fd_importacoes parser_fd_importacoes_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_fd_importacoes
    ADD CONSTRAINT parser_fd_importacoes_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: parser_fd_importacoes parser_fd_importacoes_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_fd_importacoes
    ADD CONSTRAINT parser_fd_importacoes_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: parser_fd_pedidos parser_fd_pedidos_classificacao_override_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_fd_pedidos
    ADD CONSTRAINT parser_fd_pedidos_classificacao_override_usuario_id_fkey FOREIGN KEY (classificacao_override_usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: parser_fd_pedidos parser_fd_pedidos_importacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_fd_pedidos
    ADD CONSTRAINT parser_fd_pedidos_importacao_id_fkey FOREIGN KEY (importacao_id) REFERENCES public.parser_fd_importacoes(id) ON DELETE CASCADE;


--
-- Name: parser_fd_pedidos parser_fd_pedidos_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_fd_pedidos
    ADD CONSTRAINT parser_fd_pedidos_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: parser_fd_pedidos parser_fd_pedidos_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parser_fd_pedidos
    ADD CONSTRAINT parser_fd_pedidos_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: pedidos_compra pedidos_compra_fornecedor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedidos_compra
    ADD CONSTRAINT pedidos_compra_fornecedor_id_fkey FOREIGN KEY (fornecedor_id) REFERENCES public.fornecedores(id) ON DELETE RESTRICT;


--
-- Name: pedidos_compra_itens pedidos_compra_itens_insumo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedidos_compra_itens
    ADD CONSTRAINT pedidos_compra_itens_insumo_id_fkey FOREIGN KEY (insumo_id) REFERENCES public.insumos(id) ON DELETE RESTRICT;


--
-- Name: pedidos_compra_itens pedidos_compra_itens_pedido_compra_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedidos_compra_itens
    ADD CONSTRAINT pedidos_compra_itens_pedido_compra_id_fkey FOREIGN KEY (pedido_compra_id) REFERENCES public.pedidos_compra(id) ON DELETE CASCADE;


--
-- Name: pedidos_compra pedidos_compra_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedidos_compra
    ADD CONSTRAINT pedidos_compra_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: perfis perfis_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perfis
    ADD CONSTRAINT perfis_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: perfis_operacionais perfis_operacionais_conta_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perfis_operacionais
    ADD CONSTRAINT perfis_operacionais_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES public.perfis(id) ON DELETE CASCADE;


--
-- Name: perfis perfis_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perfis
    ADD CONSTRAINT perfis_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: perfis perfis_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perfis
    ADD CONSTRAINT perfis_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE SET NULL;


--
-- Name: plataforma_acessos plataforma_acessos_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plataforma_acessos
    ADD CONSTRAINT plataforma_acessos_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE SET NULL;


--
-- Name: plataforma_acessos plataforma_acessos_superadmin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plataforma_acessos
    ADD CONSTRAINT plataforma_acessos_superadmin_id_fkey FOREIGN KEY (superadmin_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: plataforma_admins plataforma_admins_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plataforma_admins
    ADD CONSTRAINT plataforma_admins_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: produto_historico produto_historico_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produto_historico
    ADD CONSTRAINT produto_historico_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: produto_historico produto_historico_produto_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produto_historico
    ADD CONSTRAINT produto_historico_produto_id_fkey FOREIGN KEY (produto_id) REFERENCES public.produtos(id) ON DELETE CASCADE;


--
-- Name: produto_historico produto_historico_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produto_historico
    ADD CONSTRAINT produto_historico_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: produto_precos produto_precos_produto_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produto_precos
    ADD CONSTRAINT produto_precos_produto_id_fkey FOREIGN KEY (produto_id) REFERENCES public.produtos(id) ON DELETE CASCADE;


--
-- Name: produtos produtos_categoria_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produtos
    ADD CONSTRAINT produtos_categoria_id_fkey FOREIGN KEY (categoria_id) REFERENCES public.categorias(id) ON DELETE SET NULL;


--
-- Name: produtos produtos_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produtos
    ADD CONSTRAINT produtos_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: sessoes_contexto sessoes_contexto_impersonado_por_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessoes_contexto
    ADD CONSTRAINT sessoes_contexto_impersonado_por_fkey FOREIGN KEY (impersonado_por) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: sessoes_contexto sessoes_contexto_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessoes_contexto
    ADD CONSTRAINT sessoes_contexto_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: sessoes_contexto sessoes_contexto_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessoes_contexto
    ADD CONSTRAINT sessoes_contexto_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE SET NULL;


--
-- Name: sessoes_contexto sessoes_contexto_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessoes_contexto
    ADD CONSTRAINT sessoes_contexto_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: sessoes_contexto sessoes_perfil_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessoes_contexto
    ADD CONSTRAINT sessoes_perfil_id_fk FOREIGN KEY (perfil_id) REFERENCES public.perfis_operacionais(id) ON DELETE CASCADE;


--
-- Name: sw_combo_componentes sw_combo_componentes_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_combo_componentes
    ADD CONSTRAINT sw_combo_componentes_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: sw_combo_componentes sw_combo_componentes_produto_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_combo_componentes
    ADD CONSTRAINT sw_combo_componentes_produto_id_fkey FOREIGN KEY (produto_id) REFERENCES public.produtos(id) ON DELETE CASCADE;


--
-- Name: sw_faturamento_diario sw_faturamento_diario_importacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_faturamento_diario
    ADD CONSTRAINT sw_faturamento_diario_importacao_id_fkey FOREIGN KEY (importacao_id) REFERENCES public.importacoes_vendas(id) ON DELETE CASCADE;


--
-- Name: sw_faturamento_diario sw_faturamento_diario_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_faturamento_diario
    ADD CONSTRAINT sw_faturamento_diario_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: sw_mapeamento_produtos sw_mapeamento_produtos_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_mapeamento_produtos
    ADD CONSTRAINT sw_mapeamento_produtos_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: sw_mapeamento_produtos sw_mapeamento_produtos_produto_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_mapeamento_produtos
    ADD CONSTRAINT sw_mapeamento_produtos_produto_id_fkey FOREIGN KEY (produto_id) REFERENCES public.produtos(id) ON DELETE SET NULL;


--
-- Name: sw_produtos_vendidos sw_produtos_vendidos_importacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_produtos_vendidos
    ADD CONSTRAINT sw_produtos_vendidos_importacao_id_fkey FOREIGN KEY (importacao_id) REFERENCES public.importacoes_vendas(id) ON DELETE CASCADE;


--
-- Name: sw_produtos_vendidos sw_produtos_vendidos_produto_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_produtos_vendidos
    ADD CONSTRAINT sw_produtos_vendidos_produto_id_fkey FOREIGN KEY (produto_id) REFERENCES public.produtos(id) ON DELETE SET NULL;


--
-- Name: sw_produtos_vendidos sw_produtos_vendidos_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sw_produtos_vendidos
    ADD CONSTRAINT sw_produtos_vendidos_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: unidade_config unidade_config_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidade_config
    ADD CONSTRAINT unidade_config_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: unidade_modelo_logistico_historico unidade_modelo_logistico_historico_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidade_modelo_logistico_historico
    ADD CONSTRAINT unidade_modelo_logistico_historico_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: unidade_modelo_logistico_historico unidade_modelo_logistico_historico_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidade_modelo_logistico_historico
    ADD CONSTRAINT unidade_modelo_logistico_historico_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: unidade_modelo_logistico_historico unidade_modelo_logistico_historico_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidade_modelo_logistico_historico
    ADD CONSTRAINT unidade_modelo_logistico_historico_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: unidade_modulos unidade_modulos_modulo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidade_modulos
    ADD CONSTRAINT unidade_modulos_modulo_id_fkey FOREIGN KEY (modulo_id) REFERENCES public.modulos(id) ON DELETE CASCADE;


--
-- Name: unidade_modulos unidade_modulos_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidade_modulos
    ADD CONSTRAINT unidade_modulos_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: unidade_tabela_comercial_historico unidade_tabela_comercial_historico_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidade_tabela_comercial_historico
    ADD CONSTRAINT unidade_tabela_comercial_historico_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: unidade_tabela_comercial_historico unidade_tabela_comercial_historico_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidade_tabela_comercial_historico
    ADD CONSTRAINT unidade_tabela_comercial_historico_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: unidade_tabela_comercial_historico unidade_tabela_comercial_historico_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidade_tabela_comercial_historico
    ADD CONSTRAINT unidade_tabela_comercial_historico_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.perfis(id) ON DELETE SET NULL;


--
-- Name: unidades unidades_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unidades
    ADD CONSTRAINT unidades_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: usuarios_organizacoes uo_perfil_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios_organizacoes
    ADD CONSTRAINT uo_perfil_id_fk FOREIGN KEY (perfil_id) REFERENCES public.perfis_operacionais(id) ON DELETE CASCADE;


--
-- Name: usuarios_organizacoes usuarios_organizacoes_organizacao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios_organizacoes
    ADD CONSTRAINT usuarios_organizacoes_organizacao_id_fkey FOREIGN KEY (organizacao_id) REFERENCES public.organizacoes(id) ON DELETE CASCADE;


--
-- Name: usuarios_organizacoes usuarios_organizacoes_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios_organizacoes
    ADD CONSTRAINT usuarios_organizacoes_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: usuarios_unidades usuarios_unidades_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios_unidades
    ADD CONSTRAINT usuarios_unidades_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: usuarios_unidades usuarios_unidades_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios_unidades
    ADD CONSTRAINT usuarios_unidades_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: usuarios_unidades uu_perfil_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios_unidades
    ADD CONSTRAINT uu_perfil_id_fk FOREIGN KEY (perfil_id) REFERENCES public.perfis_operacionais(id) ON DELETE CASCADE;


--
-- Name: vendas_itens vendas_itens_produto_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendas_itens
    ADD CONSTRAINT vendas_itens_produto_id_fkey FOREIGN KEY (produto_id) REFERENCES public.produtos(id) ON DELETE RESTRICT;


--
-- Name: vendas_itens vendas_itens_venda_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendas_itens
    ADD CONSTRAINT vendas_itens_venda_id_fkey FOREIGN KEY (venda_id) REFERENCES public.vendas(id) ON DELETE CASCADE;


--
-- Name: vendas vendas_unidade_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendas
    ADD CONSTRAINT vendas_unidade_id_fkey FOREIGN KEY (unidade_id) REFERENCES public.unidades(id) ON DELETE CASCADE;


--
-- Name: agente_conversas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agente_conversas ENABLE ROW LEVEL SECURITY;

--
-- Name: agente_mensagens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agente_mensagens ENABLE ROW LEVEL SECURITY;

--
-- Name: agente_quota_uso; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agente_quota_uso ENABLE ROW LEVEL SECURITY;

--
-- Name: agente_uso; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agente_uso ENABLE ROW LEVEL SECURITY;

--
-- Name: alertas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.alertas ENABLE ROW LEVEL SECURITY;

--
-- Name: assinaturas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.assinaturas ENABLE ROW LEVEL SECURITY;

--
-- Name: bonificacao_importacoes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bonificacao_importacoes ENABLE ROW LEVEL SECURITY;

--
-- Name: bonificacao_lancamentos_diarios; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bonificacao_lancamentos_diarios ENABLE ROW LEVEL SECURITY;

--
-- Name: bonificacao_lancamentos_exclusoes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bonificacao_lancamentos_exclusoes ENABLE ROW LEVEL SECURITY;

--
-- Name: bonificacao_metas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bonificacao_metas ENABLE ROW LEVEL SECURITY;

--
-- Name: bonificacao_metas_faixas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bonificacao_metas_faixas ENABLE ROW LEVEL SECURITY;

--
-- Name: bonificacao_rev_mensal; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bonificacao_rev_mensal ENABLE ROW LEVEL SECURITY;

--
-- Name: canais_venda; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.canais_venda ENABLE ROW LEVEL SECURITY;

--
-- Name: categorias; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.categorias ENABLE ROW LEVEL SECURITY;

--
-- Name: cobrancas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cobrancas ENABLE ROW LEVEL SECURITY;

--
-- Name: dashboard_teste_reset_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dashboard_teste_reset_log ENABLE ROW LEVEL SECURITY;

--
-- Name: divergencias_compra; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.divergencias_compra ENABLE ROW LEVEL SECURITY;

--
-- Name: divergencias_vendas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.divergencias_vendas ENABLE ROW LEVEL SECURITY;

--
-- Name: estoque; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.estoque ENABLE ROW LEVEL SECURITY;

--
-- Name: ficha_tecnica; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ficha_tecnica ENABLE ROW LEVEL SECURITY;

--
-- Name: fornecedores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fornecedores ENABLE ROW LEVEL SECURITY;

--
-- Name: ifood_conexoes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ifood_conexoes ENABLE ROW LEVEL SECURITY;

--
-- Name: ifood_credenciais; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ifood_credenciais ENABLE ROW LEVEL SECURITY;

--
-- Name: ifood_oauth_sessoes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ifood_oauth_sessoes ENABLE ROW LEVEL SECURITY;

--
-- Name: importacoes_vendas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.importacoes_vendas ENABLE ROW LEVEL SECURITY;

--
-- Name: insights_ia; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.insights_ia ENABLE ROW LEVEL SECURITY;

--
-- Name: insumo_historico; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.insumo_historico ENABLE ROW LEVEL SECURITY;

--
-- Name: insumos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.insumos ENABLE ROW LEVEL SECURITY;

--
-- Name: lancamentos_financeiros_auditoria; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lancamentos_financeiros_auditoria ENABLE ROW LEVEL SECURITY;

--
-- Name: lancamentos_financeiros_diarios; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lancamentos_financeiros_diarios ENABLE ROW LEVEL SECURITY;

--
-- Name: lancamentos_financeiros_distribuicao_mensal; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lancamentos_financeiros_distribuicao_mensal ENABLE ROW LEVEL SECURITY;

--
-- Name: lancamentos_financeiros_distribuicao_mensal_auditoria; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lancamentos_financeiros_distribuicao_mensal_auditoria ENABLE ROW LEVEL SECURITY;

--
-- Name: lancamentos_financeiros_exclusoes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lancamentos_financeiros_exclusoes ENABLE ROW LEVEL SECURITY;

--
-- Name: lotes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lotes ENABLE ROW LEVEL SECURITY;

--
-- Name: martin_brower_filtros; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.martin_brower_filtros ENABLE ROW LEVEL SECURITY;

--
-- Name: martin_brower_integracoes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.martin_brower_integracoes ENABLE ROW LEVEL SECURITY;

--
-- Name: martin_brower_precos_historico; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.martin_brower_precos_historico ENABLE ROW LEVEL SECURITY;

--
-- Name: martin_brower_produtos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.martin_brower_produtos ENABLE ROW LEVEL SECURITY;

--
-- Name: martin_brower_sincronizacoes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.martin_brower_sincronizacoes ENABLE ROW LEVEL SECURITY;

--
-- Name: martin_brower_vinculos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.martin_brower_vinculos ENABLE ROW LEVEL SECURITY;

--
-- Name: metas_indicadores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.metas_indicadores ENABLE ROW LEVEL SECURITY;

--
-- Name: modulos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.modulos ENABLE ROW LEVEL SECURITY;

--
-- Name: movimentacoes_estoque; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.movimentacoes_estoque ENABLE ROW LEVEL SECURITY;

--
-- Name: notas_fiscais; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notas_fiscais ENABLE ROW LEVEL SECURITY;

--
-- Name: notificacoes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notificacoes ENABLE ROW LEVEL SECURITY;

--
-- Name: organizacao_modulos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.organizacao_modulos ENABLE ROW LEVEL SECURITY;

--
-- Name: organizacoes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.organizacoes ENABLE ROW LEVEL SECURITY;

--
-- Name: painel_administrativo_usuarios; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.painel_administrativo_usuarios ENABLE ROW LEVEL SECURITY;

--
-- Name: parametros; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.parametros ENABLE ROW LEVEL SECURITY;

--
-- Name: parser_fd_auditoria; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.parser_fd_auditoria ENABLE ROW LEVEL SECURITY;

--
-- Name: parser_fd_importacoes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.parser_fd_importacoes ENABLE ROW LEVEL SECURITY;

--
-- Name: parser_fd_pedidos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.parser_fd_pedidos ENABLE ROW LEVEL SECURITY;

--
-- Name: pedidos_compra; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pedidos_compra ENABLE ROW LEVEL SECURITY;

--
-- Name: pedidos_compra_itens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pedidos_compra_itens ENABLE ROW LEVEL SECURITY;

--
-- Name: perfis; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.perfis ENABLE ROW LEVEL SECURITY;

--
-- Name: perfis_operacionais; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.perfis_operacionais ENABLE ROW LEVEL SECURITY;

--
-- Name: planos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.planos ENABLE ROW LEVEL SECURITY;

--
-- Name: plataforma_acessos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plataforma_acessos ENABLE ROW LEVEL SECURITY;

--
-- Name: plataforma_admins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plataforma_admins ENABLE ROW LEVEL SECURITY;

--
-- Name: plataforma_auditoria; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plataforma_auditoria ENABLE ROW LEVEL SECURITY;

--
-- Name: plataforma_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plataforma_config ENABLE ROW LEVEL SECURITY;

--
-- Name: produto_historico; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.produto_historico ENABLE ROW LEVEL SECURITY;

--
-- Name: produto_precos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.produto_precos ENABLE ROW LEVEL SECURITY;

--
-- Name: produtos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.produtos ENABLE ROW LEVEL SECURITY;

--
-- Name: agente_conversas rls_agente_conversas_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_agente_conversas_tenant ON public.agente_conversas TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())) WITH CHECK (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: agente_mensagens rls_agente_mensagens_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_agente_mensagens_tenant ON public.agente_mensagens TO authenticated USING ((conversa_id IN ( SELECT agente_conversas.id
   FROM public.agente_conversas
  WHERE ((agente_conversas.organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())))) WITH CHECK ((conversa_id IN ( SELECT agente_conversas.id
   FROM public.agente_conversas
  WHERE ((agente_conversas.organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()))));


--
-- Name: agente_uso rls_agente_uso_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_agente_uso_tenant ON public.agente_uso TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())) WITH CHECK (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: alertas rls_alertas_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_alertas_tenant ON public.alertas TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: assinaturas rls_assinaturas_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_assinaturas_tenant ON public.assinaturas TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())) WITH CHECK (public.is_platform_superadmin());


--
-- Name: plataforma_auditoria rls_auditoria_superadmin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_auditoria_superadmin ON public.plataforma_auditoria FOR SELECT TO authenticated USING (public.is_platform_superadmin());


--
-- Name: bonificacao_lancamentos_exclusoes rls_ble_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_ble_tenant ON public.bonificacao_lancamentos_exclusoes FOR SELECT TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: bonificacao_importacoes rls_bonificacao_importacoes_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_bonificacao_importacoes_tenant ON public.bonificacao_importacoes TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: bonificacao_lancamentos_diarios rls_bonificacao_lancamentos_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_bonificacao_lancamentos_tenant ON public.bonificacao_lancamentos_diarios TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: bonificacao_metas_faixas rls_bonificacao_metas_faixas_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_bonificacao_metas_faixas_tenant ON public.bonificacao_metas_faixas TO authenticated USING ((public.is_platform_superadmin() OR (EXISTS ( SELECT 1
   FROM public.bonificacao_metas m
  WHERE ((m.id = bonificacao_metas_faixas.meta_id) AND (m.unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids))))))) WITH CHECK ((public.is_platform_superadmin() OR (EXISTS ( SELECT 1
   FROM public.bonificacao_metas m
  WHERE ((m.id = bonificacao_metas_faixas.meta_id) AND (m.unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)))))));


--
-- Name: bonificacao_metas rls_bonificacao_metas_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_bonificacao_metas_tenant ON public.bonificacao_metas TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: bonificacao_rev_mensal rls_bonificacao_rev_mensal_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_bonificacao_rev_mensal_tenant ON public.bonificacao_rev_mensal TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: canais_venda rls_canais_venda_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_canais_venda_tenant ON public.canais_venda TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())) WITH CHECK (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: categorias rls_categorias_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_categorias_tenant ON public.categorias TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())) WITH CHECK (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: cobrancas rls_cobrancas_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_cobrancas_tenant ON public.cobrancas TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())) WITH CHECK (public.is_platform_superadmin());


--
-- Name: divergencias_compra rls_divergencias_compra_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_divergencias_compra_tenant ON public.divergencias_compra TO authenticated USING ((public.is_platform_superadmin() OR (EXISTS ( SELECT 1
   FROM public.pedidos_compra pc
  WHERE ((pc.id = divergencias_compra.pedido_compra_id) AND (pc.unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids))))))) WITH CHECK ((public.is_platform_superadmin() OR (EXISTS ( SELECT 1
   FROM public.pedidos_compra pc
  WHERE ((pc.id = divergencias_compra.pedido_compra_id) AND (pc.unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)))))));


--
-- Name: divergencias_vendas rls_divergencias_vendas_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_divergencias_vendas_tenant ON public.divergencias_vendas TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: dashboard_teste_reset_log rls_dtrl_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_dtrl_tenant ON public.dashboard_teste_reset_log FOR SELECT TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: estoque rls_estoque_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_estoque_tenant ON public.estoque TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: ficha_tecnica rls_ficha_tecnica_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_ficha_tecnica_tenant ON public.ficha_tecnica TO authenticated USING ((public.is_platform_superadmin() OR (EXISTS ( SELECT 1
   FROM public.produtos p
  WHERE ((p.id = ficha_tecnica.produto_id) AND (p.organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids))))))) WITH CHECK ((public.is_platform_superadmin() OR (EXISTS ( SELECT 1
   FROM public.produtos p
  WHERE ((p.id = ficha_tecnica.produto_id) AND (p.organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)))))));


--
-- Name: fornecedores rls_fornecedores_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_fornecedores_tenant ON public.fornecedores TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())) WITH CHECK (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: ifood_conexoes rls_ifood_conexoes_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_ifood_conexoes_tenant ON public.ifood_conexoes TO authenticated USING ((public.is_platform_superadmin() OR ((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) AND (unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids))))) WITH CHECK ((public.is_platform_superadmin() OR ((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) AND (unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)))));


--
-- Name: importacoes_vendas rls_importacoes_vendas_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_importacoes_vendas_tenant ON public.importacoes_vendas TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: insights_ia rls_insights_ia_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_insights_ia_tenant ON public.insights_ia TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: insumos rls_insumos_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_insumos_tenant ON public.insumos TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())) WITH CHECK (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: lancamentos_financeiros_auditoria rls_lfa_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_lfa_tenant ON public.lancamentos_financeiros_auditoria FOR SELECT TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: lancamentos_financeiros_diarios rls_lfd_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_lfd_tenant ON public.lancamentos_financeiros_diarios FOR SELECT TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: lancamentos_financeiros_distribuicao_mensal rls_lfdm_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_lfdm_tenant ON public.lancamentos_financeiros_distribuicao_mensal FOR SELECT TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: lancamentos_financeiros_distribuicao_mensal_auditoria rls_lfdma_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_lfdma_tenant ON public.lancamentos_financeiros_distribuicao_mensal_auditoria FOR SELECT TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: lancamentos_financeiros_exclusoes rls_lfe_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_lfe_tenant ON public.lancamentos_financeiros_exclusoes FOR SELECT TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: lotes rls_lotes_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_lotes_tenant ON public.lotes TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: martin_brower_filtros rls_martin_brower_filtros_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_martin_brower_filtros_tenant ON public.martin_brower_filtros TO authenticated USING ((public.is_platform_superadmin() OR ((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) AND ((unidade_id IS NULL) OR (unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)))))) WITH CHECK ((public.is_platform_superadmin() OR ((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) AND ((unidade_id IS NULL) OR (unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids))))));


--
-- Name: martin_brower_integracoes rls_martin_brower_integracoes_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_martin_brower_integracoes_tenant ON public.martin_brower_integracoes TO authenticated USING ((public.is_platform_superadmin() OR ((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) AND (unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids))))) WITH CHECK ((public.is_platform_superadmin() OR ((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) AND (unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)))));


--
-- Name: martin_brower_precos_historico rls_martin_brower_precos_historico_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_martin_brower_precos_historico_tenant ON public.martin_brower_precos_historico TO authenticated USING ((public.is_platform_superadmin() OR ((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) AND (unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids))))) WITH CHECK ((public.is_platform_superadmin() OR ((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) AND (unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)))));


--
-- Name: martin_brower_produtos rls_martin_brower_produtos_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_martin_brower_produtos_tenant ON public.martin_brower_produtos TO authenticated USING ((public.is_platform_superadmin() OR ((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) AND (unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids))))) WITH CHECK ((public.is_platform_superadmin() OR ((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) AND (unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)))));


--
-- Name: martin_brower_sincronizacoes rls_martin_brower_sincronizacoes_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_martin_brower_sincronizacoes_tenant ON public.martin_brower_sincronizacoes TO authenticated USING ((public.is_platform_superadmin() OR ((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) AND (unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids))))) WITH CHECK ((public.is_platform_superadmin() OR ((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) AND (unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)))));


--
-- Name: martin_brower_vinculos rls_martin_brower_vinculos_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_martin_brower_vinculos_tenant ON public.martin_brower_vinculos TO authenticated USING ((public.is_platform_superadmin() OR ((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) AND (unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids))))) WITH CHECK ((public.is_platform_superadmin() OR ((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) AND (unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)))));


--
-- Name: metas_indicadores rls_metas_leitura; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_metas_leitura ON public.metas_indicadores FOR SELECT TO authenticated USING ((((organizacao_id IS NULL) AND (unidade_id IS NULL)) OR (organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: modulos rls_modulos_escrita; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_modulos_escrita ON public.modulos TO authenticated USING (public.is_platform_superadmin()) WITH CHECK (public.is_platform_superadmin());


--
-- Name: modulos rls_modulos_leitura; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_modulos_leitura ON public.modulos FOR SELECT TO authenticated USING ((ativo OR public.is_platform_superadmin()));


--
-- Name: movimentacoes_estoque rls_movimentacoes_estoque_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_movimentacoes_estoque_tenant ON public.movimentacoes_estoque TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: notas_fiscais rls_notas_fiscais_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_notas_fiscais_tenant ON public.notas_fiscais TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: notificacoes rls_notificacoes_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_notificacoes_tenant ON public.notificacoes TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: organizacao_modulos rls_organizacao_modulos_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_organizacao_modulos_delete ON public.organizacao_modulos FOR DELETE TO authenticated USING (public.is_platform_superadmin());


--
-- Name: organizacao_modulos rls_organizacao_modulos_escrita; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_organizacao_modulos_escrita ON public.organizacao_modulos FOR INSERT TO authenticated WITH CHECK (public.is_platform_superadmin());


--
-- Name: organizacao_modulos rls_organizacao_modulos_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_organizacao_modulos_tenant ON public.organizacao_modulos FOR SELECT TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: organizacoes rls_organizacoes_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_organizacoes_tenant ON public.organizacoes TO authenticated USING (((id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())) WITH CHECK (((id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: plataforma_acessos rls_pa_superadmin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_pa_superadmin ON public.plataforma_acessos FOR SELECT TO authenticated USING (((superadmin_id = auth.uid()) OR public.is_platform_superadmin()));


--
-- Name: plataforma_admins rls_padm_superadmin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_padm_superadmin ON public.plataforma_admins TO authenticated USING (public.is_platform_superadmin()) WITH CHECK (public.is_platform_superadmin());


--
-- Name: painel_administrativo_usuarios rls_padmadm_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_padmadm_self ON public.painel_administrativo_usuarios FOR SELECT USING (((usuario_id = auth.uid()) OR public.is_platform_superadmin()));


--
-- Name: parametros rls_parametros_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_parametros_tenant ON public.parametros TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: parser_fd_auditoria rls_parser_fd_auditoria_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_parser_fd_auditoria_tenant ON public.parser_fd_auditoria TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: parser_fd_importacoes rls_parser_fd_importacoes_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_parser_fd_importacoes_tenant ON public.parser_fd_importacoes TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: parser_fd_pedidos rls_parser_fd_pedidos_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_parser_fd_pedidos_tenant ON public.parser_fd_pedidos TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: plataforma_config rls_pconfig_superadmin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_pconfig_superadmin ON public.plataforma_config TO authenticated USING (public.is_platform_superadmin()) WITH CHECK (public.is_platform_superadmin());


--
-- Name: pedidos_compra_itens rls_pedidos_compra_itens_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_pedidos_compra_itens_tenant ON public.pedidos_compra_itens TO authenticated USING ((public.is_platform_superadmin() OR (EXISTS ( SELECT 1
   FROM public.pedidos_compra pc
  WHERE ((pc.id = pedidos_compra_itens.pedido_compra_id) AND (pc.unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids))))))) WITH CHECK ((public.is_platform_superadmin() OR (EXISTS ( SELECT 1
   FROM public.pedidos_compra pc
  WHERE ((pc.id = pedidos_compra_itens.pedido_compra_id) AND (pc.unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)))))));


--
-- Name: pedidos_compra rls_pedidos_compra_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_pedidos_compra_tenant ON public.pedidos_compra TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: perfis_operacionais rls_perfis_op_conta; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_perfis_op_conta ON public.perfis_operacionais FOR SELECT TO authenticated USING (((conta_id = auth.uid()) OR public.is_platform_superadmin()));


--
-- Name: perfis rls_perfis_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_perfis_tenant ON public.perfis TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())) WITH CHECK (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: planos rls_planos_escrita; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_planos_escrita ON public.planos TO authenticated USING (public.is_platform_superadmin()) WITH CHECK (public.is_platform_superadmin());


--
-- Name: planos rls_planos_leitura; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_planos_leitura ON public.planos FOR SELECT TO authenticated USING ((ativo OR public.is_platform_superadmin()));


--
-- Name: produto_historico rls_produto_historico_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_produto_historico_tenant ON public.produto_historico TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())) WITH CHECK (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: produto_precos rls_produto_precos_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_produto_precos_tenant ON public.produto_precos TO authenticated USING ((public.is_platform_superadmin() OR (EXISTS ( SELECT 1
   FROM public.produtos p
  WHERE ((p.id = produto_precos.produto_id) AND (p.organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids))))))) WITH CHECK ((public.is_platform_superadmin() OR (EXISTS ( SELECT 1
   FROM public.produtos p
  WHERE ((p.id = produto_precos.produto_id) AND (p.organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)))))));


--
-- Name: produtos rls_produtos_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_produtos_tenant ON public.produtos TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())) WITH CHECK (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: sessoes_contexto rls_sessoes_proprias; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_sessoes_proprias ON public.sessoes_contexto FOR SELECT TO authenticated USING (((usuario_id = auth.uid()) OR public.is_platform_superadmin()));


--
-- Name: sw_combo_componentes rls_sw_combo_componentes_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_sw_combo_componentes_tenant ON public.sw_combo_componentes TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())) WITH CHECK (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: sw_faturamento_diario rls_sw_faturamento_diario_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_sw_faturamento_diario_tenant ON public.sw_faturamento_diario TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: sw_mapeamento_produtos rls_sw_mapeamento_produtos_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_sw_mapeamento_produtos_tenant ON public.sw_mapeamento_produtos TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())) WITH CHECK (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: sw_produtos_vendidos rls_sw_produtos_vendidos_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_sw_produtos_vendidos_tenant ON public.sw_produtos_vendidos TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: unidade_modelo_logistico_historico rls_umlh_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_umlh_tenant ON public.unidade_modelo_logistico_historico FOR SELECT TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: unidade_modulos rls_unidade_modulos_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_unidade_modulos_delete ON public.unidade_modulos FOR DELETE TO authenticated USING (public.is_platform_superadmin());


--
-- Name: unidade_modulos rls_unidade_modulos_escrita; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_unidade_modulos_escrita ON public.unidade_modulos FOR INSERT TO authenticated WITH CHECK (public.is_platform_superadmin());


--
-- Name: unidade_modulos rls_unidade_modulos_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_unidade_modulos_tenant ON public.unidade_modulos FOR SELECT TO authenticated USING (((unidade_id IN ( SELECT u.id
   FROM public.unidades u
  WHERE (u.organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)))) OR public.is_platform_superadmin()));


--
-- Name: unidades rls_unidades_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_unidades_tenant ON public.unidades TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin())) WITH CHECK (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: usuarios_organizacoes rls_uo_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_uo_self ON public.usuarios_organizacoes FOR SELECT TO authenticated USING (((usuario_id = auth.uid()) OR public.is_platform_superadmin()));


--
-- Name: unidade_tabela_comercial_historico rls_utch_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_utch_tenant ON public.unidade_tabela_comercial_historico FOR SELECT TO authenticated USING (((organizacao_id IN ( SELECT public.auth_organizacao_ids() AS auth_organizacao_ids)) OR public.is_platform_superadmin()));


--
-- Name: usuarios_unidades rls_uu_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_uu_self ON public.usuarios_unidades FOR SELECT TO authenticated USING (((usuario_id = auth.uid()) OR public.is_platform_superadmin()));


--
-- Name: vendas_itens rls_vendas_itens_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_vendas_itens_tenant ON public.vendas_itens TO authenticated USING ((public.is_platform_superadmin() OR (EXISTS ( SELECT 1
   FROM public.vendas v
  WHERE ((v.id = vendas_itens.venda_id) AND (v.unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids))))))) WITH CHECK ((public.is_platform_superadmin() OR (EXISTS ( SELECT 1
   FROM public.vendas v
  WHERE ((v.id = vendas_itens.venda_id) AND (v.unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)))))));


--
-- Name: vendas rls_vendas_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_vendas_tenant ON public.vendas TO authenticated USING (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin())) WITH CHECK (((unidade_id IN ( SELECT public.auth_unidade_ids() AS auth_unidade_ids)) OR public.is_platform_superadmin()));


--
-- Name: sessoes_contexto; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sessoes_contexto ENABLE ROW LEVEL SECURITY;

--
-- Name: sw_combo_componentes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sw_combo_componentes ENABLE ROW LEVEL SECURITY;

--
-- Name: sw_faturamento_diario; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sw_faturamento_diario ENABLE ROW LEVEL SECURITY;

--
-- Name: sw_mapeamento_produtos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sw_mapeamento_produtos ENABLE ROW LEVEL SECURITY;

--
-- Name: sw_produtos_vendidos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sw_produtos_vendidos ENABLE ROW LEVEL SECURITY;

--
-- Name: unidade_modelo_logistico_historico; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.unidade_modelo_logistico_historico ENABLE ROW LEVEL SECURITY;

--
-- Name: unidade_modulos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.unidade_modulos ENABLE ROW LEVEL SECURITY;

--
-- Name: unidade_tabela_comercial_historico; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.unidade_tabela_comercial_historico ENABLE ROW LEVEL SECURITY;

--
-- Name: unidades; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.unidades ENABLE ROW LEVEL SECURITY;

--
-- Name: usuarios_organizacoes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.usuarios_organizacoes ENABLE ROW LEVEL SECURITY;

--
-- Name: usuarios_unidades; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.usuarios_unidades ENABLE ROW LEVEL SECURITY;

--
-- Name: vendas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendas ENABLE ROW LEVEL SECURITY;

--
-- Name: vendas_itens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendas_itens ENABLE ROW LEVEL SECURITY;

--
-- Name: FUNCTION agente_reservar_quota(p_reservas jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.agente_reservar_quota(p_reservas jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agente_reservar_quota(p_reservas jsonb) TO service_role;


--


-- ========================================================================
-- SEED ESTRUTURAL (dados que o SISTEMA precisa para funcionar — não negócio)
-- ========================================================================

-- --- Catálogo de módulos (migrations 030/047/059) --------------------------
insert into public.modulos (id, nome, categoria, ordem) values
  ('dashboard','Dashboard','operacao',1),
  ('products_cmv','Produtos / CMV','operacao',2),
  ('ingredients','Insumos','operacao',3),
  ('inventory','Estoque','operacao',4),
  ('sales','Vendas','operacao',5),
  ('ifood_dashboard','Dashboard iFood','operacao',6),
  ('monthly_bonus','Bonificação Mensal','operacao',7),
  ('distributors','Distribuidoras','operacao',8),
  ('martin_brower','Martin Brower','integracao',9),
  ('swfast','SWFast / PDV','integracao',10),
  ('ifood','iFood','integracao',11),
  ('coca_cola','Coca-Cola','integracao',12),
  ('hortifruti','Cláudia Hortifruti','integracao',13),
  ('parser_food_delivery','Parser Food Delivery','operacao',14),
  ('agente_ia','Agente Crescer (IA)','operacao',15),
  ('inteligencia','Inteligência (seção)','operacao',16)
on conflict (id) do nothing;

-- --- Planos do SaaS (migration 020) ---------------------------------------
insert into public.planos (codigo, nome, descricao, preco_mensal, preco_anual, limite_unidades, limite_usuarios, ordem) values
  ('teste','Teste','Avaliação por tempo limitado.',0.00,0.00,1,3,0),
  ('essencial','Essencial','Uma unidade, CMV e vendas.',197.00,1970.00,1,5,1),
  ('pro','Pro','Multiunidade, integrações e relatórios.',397.00,3970.00,5,20,2),
  ('enterprise','Enterprise','Sem limites, com suporte dedicado.',897.00,8970.00,null,null,3)
on conflict (codigo) do nothing;

-- --- Configuração da plataforma (migration 020) — placeholders (secretos = NULL) ---
insert into public.plataforma_config (chave, valor, secreto, descricao) values
  ('saas.nome','"Crescer com Delivery"'::jsonb,false,'Nome da plataforma'),
  ('saas.logo_url','null'::jsonb,false,'Logo da plataforma'),
  ('saas.versao','"0.1.0"'::jsonb,false,'Versão publicada'),
  ('saas.modo_manutencao','false'::jsonb,false,'Bloqueia o acesso dos tenants'),
  ('saas.politica_url','null'::jsonb,false,'URL da política de privacidade'),
  ('smtp.host','null'::jsonb,false,'Servidor SMTP'),
  ('smtp.porta','587'::jsonb,false,'Porta SMTP'),
  ('smtp.usuario','null'::jsonb,false,'Usuário SMTP'),
  ('smtp.senha','null'::jsonb,true,'Senha SMTP'),
  ('api.openai_key','null'::jsonb,true,'Chave da OpenAI'),
  ('api.claude_key','null'::jsonb,true,'Chave da Anthropic'),
  ('api.cloudflare_token','null'::jsonb,true,'Token da Cloudflare'),
  ('backup.frequencia','"diario"'::jsonb,false,'Frequência do backup'),
  ('backup.retencao_dias','30'::jsonb,false,'Retenção do backup em dias')
on conflict (chave) do nothing;

-- --- Metas globais de indicadores (migrations 023/024) — organizacao/unidade NULL ---
insert into public.metas_indicadores (organizacao_id, unidade_id, indicador, meta_ideal, limite, modelo_logistico) values
  (null,null,'servicos_promocoes',0.0500,0.0700,'marketplace'),
  (null,null,'servicos_promocoes',0.1000,0.1450,'full_service'),
  (null,null,'taxas_comissoes',0.1300,0.1300,'marketplace'),
  (null,null,'taxas_comissoes',0.2050,0.2050,'full_service'),
  (null,null,'taxas_entregadores',0.1200,0.1500,'marketplace'),
  (null,null,'taxas_entregadores',0.1500,0.1500,'full_service'),
  (null,null,'total_deducoes',0.3000,0.3200,'marketplace'),
  (null,null,'total_deducoes',0.3050,0.3200,'full_service')
on conflict do nothing;

-- --- Buckets do Supabase Storage (migrations 013/028/037) -----------------
--     `storage.buckets` é gerido pelo Supabase. Em Postgres puro, crie o stub.
insert into storage.buckets (id, name, public) values
  ('vendas-relatorios','vendas-relatorios',false),
  ('bonificacao-visio','bonificacao-visio',false),
  ('parser-food-delivery','parser-food-delivery',false)
on conflict (id) do nothing;

-- ========================================================================
-- MIGRATION 067 — reafirmação explícita dos privilégios da RPC de quota
--   (pg_dump acima já emite o equivalente; repetimos com o texto original
--    da migration para deixar o estado inequívoco e auditável)
-- ========================================================================
revoke all on function public.agente_reservar_quota(jsonb) from public, anon, authenticated;
grant execute on function public.agente_reservar_quota(jsonb) to service_role;

-- ========================================================================
-- FIM — MIGRATION BASE / BOOTSTRAP
-- ========================================================================
