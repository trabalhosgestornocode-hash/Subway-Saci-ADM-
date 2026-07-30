-- =====================================================================
-- SEED OPCIONAL — DEMONSTRAÇÃO de Insumos + Fichas técnicas
-- (derivado da planilha "Ficha Técnica - Crescer com Delivery")
--
-- ⚠️  NÃO É EXECUTADO AUTOMATICAMENTE. NÃO RODAR EM PRODUÇÃO.
--     É um apoio de DESENVOLVIMENTO para ver as relações funcionando:
--     cadastra POUCOS insumos representativos e monta 3 fichas reais
--     (Cookie = cookie pronto + saco; Fanta Uva = 1 lata; Sanduíche de
--     Frango = pão + frango + embalagem). Demonstra as RELAÇÕES — não
--     copia a planilha inteira.
--
-- Idempotente: usa códigos/sku 'DEMO-*' e ON CONFLICT DO NOTHING.
-- Escopo: aplica na PRIMEIRA organização encontrada (ajuste v_org se quiser).
-- Rode manualmente no SQL Editor do Supabase de um ambiente de teste.
-- Requer a migration 021 aplicada.
-- =====================================================================
do $$
declare
  v_org uuid;
  v_cookie_pronto uuid; v_saco uuid; v_fanta uuid;
  v_pao uuid; v_frango uuid; v_emb uuid;
  v_p_cookie uuid; v_p_fanta uuid; v_p_sand uuid;
begin
  select id into v_org from organizacoes order by created_at limit 1;
  if v_org is null then
    raise notice 'Nenhuma organização encontrada — seed abortado.';
    return;
  end if;

  -- ---------- INSUMOS (custo por unidade-base = preço ÷ conteúdo) ----------
  -- helper inline: insere e devolve o id (ou reaproveita o existente)
  insert into insumos (organizacao_id, codigo, nome, tipo, unidade_medida, forma_compra,
                       preco_caixa, rendimento, preco_unitario, preco_atualizado_em, ativo, descricao)
  values
    (v_org,'DEMO-COOKIE-CRU','Cookie pronto (chocolate)','doce','un','caixa', 238.14, 120, 238.14/120, now(), true, 'Cookie cru comprado pronto — assar na loja'),
    (v_org,'DEMO-SACO-COOKIE','Saco de cookie','embalagem','un','fardo', 29.48, 500, 29.48/500, now(), true, 'Embalagem do cookie — descartável'),
    (v_org,'DEMO-FANTA-UVA','Fanta Uva lata 350ml','bebida','un','caixa', 13.56, 6, 13.56/6, now(), true, 'Bebida comprada pronta'),
    (v_org,'DEMO-PAO-15','Pão 15 cm branco','pao','un','unidade', 201.03, 140, 201.03/140, now(), true, 'Pão assado na loja (rende 140 de 15cm por caixa de massa)'),
    (v_org,'DEMO-FRANGO','Frango empanado','proteina','kg','caixa', 121.42, 4, 121.42/4, now(), true, 'Proteína — custo por kg'),
    (v_org,'DEMO-EMB-15','Embalagem 15 cm completa','embalagem','un','unidade', 0.78649, 1, 0.78649, now(), true, 'Papel + saco + guardanapo + etiqueta')
  on conflict (organizacao_id, codigo) do nothing;

  select id into v_cookie_pronto from insumos where organizacao_id=v_org and codigo='DEMO-COOKIE-CRU';
  select id into v_saco          from insumos where organizacao_id=v_org and codigo='DEMO-SACO-COOKIE';
  select id into v_fanta         from insumos where organizacao_id=v_org and codigo='DEMO-FANTA-UVA';
  select id into v_pao           from insumos where organizacao_id=v_org and codigo='DEMO-PAO-15';
  select id into v_frango        from insumos where organizacao_id=v_org and codigo='DEMO-FRANGO';
  select id into v_emb           from insumos where organizacao_id=v_org and codigo='DEMO-EMB-15';

  -- ---------- PRODUTOS ----------
  insert into produtos (organizacao_id, sku, nome, tipo, vendavel, ativo)
  values
    (v_org,'DEMO-PROD-COOKIE','Cookie (demo)','sobremesa', true, true),
    (v_org,'DEMO-PROD-FANTA','Fanta Uva lata (demo)','bebida', true, true),
    (v_org,'DEMO-PROD-SAND','Sanduíche de Frango 15cm (demo)','sanduiche', true, true)
  on conflict (organizacao_id, sku) do nothing;

  select id into v_p_cookie from produtos where organizacao_id=v_org and sku='DEMO-PROD-COOKIE';
  select id into v_p_fanta  from produtos where organizacao_id=v_org and sku='DEMO-PROD-FANTA';
  select id into v_p_sand   from produtos where organizacao_id=v_org and sku='DEMO-PROD-SAND';

  -- ---------- PREÇOS DE VENDA (balcão) ----------
  insert into produto_precos (produto_id, canal, tabela, preco) values
    (v_p_cookie,'balcao','A', 7.00),
    (v_p_fanta ,'balcao','A', 10.50),
    (v_p_sand  ,'balcao','A', 23.00)
  on conflict (produto_id, canal, tabela) do nothing;

  -- ---------- FICHAS TÉCNICAS (quantidade SEMPRE na unidade-base) ----------
  -- Cookie = 1 un cookie pronto + 1 un saco  -> 1,98 + 0,06 = 2,04
  insert into ficha_tecnica (produto_id, insumo_id, quantidade, unidade_uso, quantidade_informada) values
    (v_p_cookie, v_cookie_pronto, 1, 'un', 1),
    (v_p_cookie, v_saco,          1, 'un', 1),
  -- Fanta = 1 un da lata -> 2,26
    (v_p_fanta,  v_fanta,         1, 'un', 1),
  -- Sanduíche de Frango = 1 pão + 76 g de frango + 1 embalagem
    (v_p_sand,   v_pao,           1,     'un', 1),
    (v_p_sand,   v_frango,        0.076, 'g',  76),
    (v_p_sand,   v_emb,           1,     'un', 1)
  on conflict do nothing;

  -- Recalcula o cache de custo dos produtos demo.
  perform fn_recalc_custo(v_p_cookie);
  perform fn_recalc_custo(v_p_fanta);
  perform fn_recalc_custo(v_p_sand);

  raise notice 'Seed DEMO aplicado na organização %: Cookie=% Fanta=% Sanduíche=%',
    v_org, fn_custo_produto(v_p_cookie), fn_custo_produto(v_p_fanta), fn_custo_produto(v_p_sand);
end $$;

-- Conferência esperada:
--   Cookie   ≈ R$ 2,04   |  Fanta ≈ R$ 2,26  |  Sanduíche ≈ R$ 4,53
-- Para remover o seed:
--   delete from produtos where organizacao_id = (select id from organizacoes order by created_at limit 1) and sku like 'DEMO-%';
--   delete from insumos  where organizacao_id = (select id from organizacoes order by created_at limit 1) and codigo like 'DEMO-%';
