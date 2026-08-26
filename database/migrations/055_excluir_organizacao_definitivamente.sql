-- =====================================================================
-- MIGRATION 055 — Exclusão definitiva de empresa, de verdade
-- =====================================================================
-- CAUSA RAIZ (achado da investigação do bug de exclusão): `excluirEmpresa`
-- fazia um `delete from organizacoes` cru, confiando cegamente no
-- `on delete cascade` de organizacao_id/unidade_id. Mas seis colunas do
-- schema original (schema.sql) são `on delete restrict`, de propósito —
-- protegem contra apagar um insumo/produto/fornecedor que ainda está em
-- uso, mesmo fora do contexto de excluir uma empresa inteira:
--   ficha_tecnica.insumo_id        -> insumos
--   ficha_tecnica.subproduto_id    -> produtos
--   movimentacoes_estoque.insumo_id -> insumos
--   pedidos_compra_itens.insumo_id  -> insumos
--   vendas_itens.produto_id         -> produtos
--   pedidos_compra.fornecedor_id    -> fornecedores
-- O cascade de organizacao_id/unidade_id NÃO ignora essas travas: quando o
-- delete em `organizacoes` cascateia até `insumos`/`produtos`/`fornecedores`,
-- o Postgres ainda checa essas RESTRICT e recusa com um erro 23503 cru
-- sempre que existe QUALQUER catálogo configurado — inclusive uma empresa
-- "vazia" clonada de um Modelo Padrão. Uma correção anterior (não incluída
-- nesta migration) reagiu bloqueando a exclusão física sempre que havia
-- catálogo/histórico — mas isso deixava o SuperAdmin sem saída nenhuma numa
-- empresa de teste/lixo que realmente precisa sumir.
--
-- CORREÇÃO: esta função apaga explicitamente as linhas que travam essas
-- seis colunas — sempre ESCOPADAS a esta organização — ANTES do delete em
-- cascata, na ordem que a própria trava exige. Depois disso o
-- `delete from organizacoes` cascateia sem obstáculo por todo o resto
-- (dezenas de tabelas com organizacao_id/unidade_id em cascade — Dashboard
-- Executivo, Bonificação, Parser FD, Martin Brower, Agente Crescer, SW,
-- vínculos de usuário, sessões — todas já eram cascade e continuam sendo).
--
-- Mesma técnica de transação real das funções da migration 053: tudo dentro
-- de UMA função PL/pgSQL = uma transação do Postgres. Se qualquer passo
-- falhar (inclusive uma referência cruzada anômala entre organizações, que
-- nunca deveria existir), tudo volta atrás sozinho — inclusive a linha de
-- auditoria, que só é gravada se a exclusão realmente aconteceu.
--
-- NÃO mexe na exclusão de UNIDADE (`impactoExclusaoUnidade`/`excluirUnidade`
-- em plataforma.unidades.service.js) nem nas operações estruturais da 053
-- (promover/converter/transferir) — escopo deliberadamente restrito à
-- exclusão de EMPRESA.
-- =====================================================================

create or replace function excluir_organizacao_definitivamente(
  p_organizacao_id uuid,
  p_confirmacao_nome text,
  p_ator_id uuid,
  p_ator_email text default null,
  p_ip text default null,
  p_user_agent text default null
) returns jsonb
language plpgsql
as $$
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
