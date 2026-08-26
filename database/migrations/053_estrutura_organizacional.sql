-- =====================================================================
-- MIGRATION 053 — Estrutura Organizacional: promover/converter/transferir
-- =====================================================================
-- OBJETIVO
--   As três alterações estruturais de alto risco do Painel SuperAdmin
--   (promover unidade -> empresa, converter empresa -> unidade, transferir
--   unidade entre empresas) precisam de transação real com rollback
--   completo — o cliente supabase-js do backend faz uma requisição HTTP por
--   `.from(...)`, sem transação entre chamadas. A única forma de garantir
--   atomicidade de verdade é rodar a operação inteira dentro de UMA função
--   PL/pgSQL: se qualquer passo falhar, o Postgres desfaz TUDO sozinho.
--
--   Autorização continua sendo responsabilidade do app (requireSuperadmin
--   no router, mesmo padrão do resto da plataforma) — estas funções não
--   verificam permissão, confiam em quem as chama (o backend com
--   service_role), do mesmo jeito que fn_recalc_custo/fn_custo_produto já
--   confiam.
--
-- REGRA CENTRAL (decisão do usuário, 25/08/2026): a unidade promovida NUNCA
--   é recriada. Todo dado operacional (vendas, estoque, Dashboard
--   Executivo, Bonificação, Parser FD, sessões, vínculos de unidade) já é
--   só `unidade_id` e nenhuma dessas linhas é tocada — a unidade só troca
--   de organizacao_id. A ÚNICA coisa que precisa nascer de novo é o
--   catálogo (categorias/insumos/produtos/ficha_tecnica/produto_precos),
--   porque hoje ele só existe por organizacao_id (compartilhado entre todas
--   as unidades da empresa) — mesmo escopo e mesmas exclusões (fornecedores,
--   canais_venda) de backend/src/shared/clonarCatalogo.js, reescrito aqui em
--   SQL puro para poder correr na mesma transação.
--
-- PRÉ-REQUISITOS: migrations 012, 013, 015, 017, 020, 030, 034 aplicadas.
-- IDEMPOTENTE quanto à criação das funções (create or replace); cada
--   CHAMADA da função, porém, não é reexecutável — promover a mesma
--   unidade duas vezes cria duas empresas.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- =====================================================================
-- 0. HELPER — remapeia organizacao_id em toda tabela que TAMBÉM tem
--    unidade_id (padrão redundante usado por Dashboard Executivo,
--    Bonificação, Parser FD, Agente Crescer, Martin Brower, histórico de
--    tabela comercial/modelo logístico, log de reset de teste...). Sem
--    isto, promover ou transferir uma unidade deixaria essas dezenas de
--    tabelas com unidade_id apontando pra empresa NOVA e organizacao_id
--    ainda na empresa ANTIGA — inconsistência silenciosa em quase todo
--    módulo do sistema (achado na revisão estática desta migration, não
--    fazia parte do desenho original).
--
--    Descoberto DINAMICAMENTE via catálogo do Postgres (information_schema),
--    não por uma lista fixa escrita à mão — cobre também qualquer tabela
--    nova que ganhe essas duas colunas numa migration futura, sem precisar
--    lembrar de atualizar esta função toda vez.
--
--    Exclusões deliberadas (não fazem parte deste padrão genérico):
--      * martin_brower_vinculos — precisa remapear organizacao_id JUNTO
--        com insumo_id (aponta pro catálogo clonado); tratado à parte por
--        quem chama, quando aplicável (só na promoção).
--      * sessoes_contexto — é HISTÓRICO de sessões passadas; a empresa que
--        aparece ali é a empresa de fato naquele momento, não deve mudar.
--      * insumo_historico — unidade_id é só informativo ("unidade ativa no
--        momento"); o organizacao_id ali é do INSUMO (catálogo), que
--        continua existindo intacto na empresa de origem.
--
--    REFERÊNCIA OPERACIONAL vs SNAPSHOT HISTÓRICO (distinção revisada
--    explicitamente antes de aplicar): tabelas de auditoria/exclusão como
--    lancamentos_financeiros_auditoria, lancamentos_financeiros_exclusoes,
--    bonificacao_lancamentos_exclusoes, parser_fd_auditoria e
--    dashboard_teste_reset_log TAMBÉM entram no remapeamento genérico — e
--    isso é proposital, não um descuido. O `organizacao_id`/`unidade_id`
--    delas é só um PONTEIRO DE DONO (pra filtrar "auditoria da unidade X"),
--    igual a qualquer tabela operacional — não é o dado histórico em si.
--    O dado que precisa congelar no tempo (valor_anterior/valor_novo,
--    snapshot, lancamento_snapshot, codigos_antes/depois) fica dentro de
--    colunas JSONB/texto que este UPDATE nunca toca — só a coluna
--    organizacao_id muda. Sem remapear o ponteiro de dono, essas linhas
--    ficariam invisíveis ao consultar "histórico da unidade X" já dentro da
--    empresa nova. As duas exclusões acima (sessoes_contexto, insumo_historico)
--    são as únicas onde organizacao_id É o próprio fato histórico (quem
--    era o dono NAQUELE momento), não um ponteiro de dono atual — por isso,
--    e só nelas, o remapeamento fica de fora.
create or replace function remapear_organizacao_em_tabelas_de_unidade(
  p_unidade_id uuid, p_org_antiga_id uuid, p_org_nova_id uuid
) returns jsonb
language plpgsql
as $$
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
    -- Schema qualificado EXPLICITAMENTE (public.%I, não só %I): blinda contra
    -- um search_path diferente do padrão resolver o identificador pra outro
    -- schema por engano. %I faz o quoting correto do nome da tabela (lida com
    -- maiúsculas/palavra reservada/caractere especial); os valores nunca são
    -- interpolados na string — vão sempre via USING (parâmetro ligado, $1/$2/$3),
    -- então não há superfície de injeção nem no identificador (vem só do
    -- catálogo do Postgres, nunca de parâmetro da função) nem nos valores.
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
$$;

-- =====================================================================
-- 1. PROMOVER UNIDADE -> EMPRESA
-- =====================================================================
create or replace function promover_unidade_para_empresa(
  p_unidade_id uuid,
  p_nome_empresa text,
  p_ator_id uuid,
  p_ator_email text default null,
  p_ip text default null,
  p_user_agent text default null
) returns jsonb
language plpgsql
as $$
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

-- =====================================================================
-- 2. TRANSFERIR UNIDADE ENTRE EMPRESAS
-- =====================================================================
-- Deliberadamente NÃO mexe em catálogo/sw_mapeamento_produtos/
-- martin_brower_vinculos: a empresa de destino já tem (ou não) o próprio
-- catálogo independente, e não existe forma segura de "adivinhar" a
-- correspondência entre os dois catálogos sem risco de vincular errado.
-- O histórico da unidade (vendas, dashboard, bonificação, parser fd)
-- continua 100% legível — os `produto_id`/`insumo_id` antigos continuam
-- existindo no catálogo da empresa ANTERIOR (nada é apagado). Reconfigurar
-- o mapeamento SW/PDV para a empresa nova é uma tarefa manual normal do
-- painel, não algo que a transferência deva inventar sozinha.
create or replace function transferir_unidade_organizacao(
  p_unidade_id uuid,
  p_nova_organizacao_id uuid,
  p_ator_id uuid,
  p_ator_email text default null,
  p_ip text default null,
  p_user_agent text default null
) returns jsonb
language plpgsql
as $$
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

-- =====================================================================
-- 3. CONVERTER EMPRESA -> UNIDADE
-- =====================================================================
-- Restrito a empresas com ZERO unidades próprias: uma "unidade" não pode
-- conter outras unidades, então uma empresa com 1+ unidades precisa ter
-- essas unidades promovidas/transferidas ANTES de a empresa em si virar
-- uma unidade. Empresa com zero unidades também nunca teve dado
-- operacional (toda tabela operacional exige unidade_id not null), então
-- não há histórico de vendas/dashboard/bonificação em risco aqui — só o
-- catálogo (se existir), que fica preservado mas NÃO é mesclado
-- automaticamente ao catálogo da empresa-mãe (mesclar dois catálogos
-- exigiria casar produtos por nome, que é ambíguo e arriscado — melhor
-- deixar explícito do que inventar um vínculo errado).
create or replace function converter_empresa_para_unidade(
  p_organizacao_id uuid,
  p_empresa_mae_id uuid,
  p_ator_id uuid,
  p_ator_email text default null,
  p_ip text default null,
  p_user_agent text default null
) returns jsonb
language plpgsql
as $$
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
