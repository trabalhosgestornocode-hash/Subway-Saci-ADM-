// Testes das tools de Produtos/CMV do Agente Crescer (Fase 2A) — unit, sem
// rede/Supabase de dados de negócio: todas as dependências são injetadas
// (ver `deps` em cada tool). O que estes testes protegem, na ordem do pedido:
//   * a tool reutiliza o service/view correto (cmv.service.js, produtos.service.js);
//   * organizacaoId/unidadeId vêm SEMPRE do contexto, nunca do input;
//   * ranking nunca faz 1 consulta por produto (2 chamadas de deps, fixas);
//   * limite máximo nunca é ultrapassado, mesmo se solicitado;
//   * módulo/permissão exigidos mesmo com a rota /agente liberada;
//   * nenhuma tool tem efeito de escrita.
//
// Rodar: node --env-file-if-exists=.env --test test/agente-produtos-cmv-tools.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MODULOS } from "../src/shared/modulos.js";
import { PERMISSOES } from "../src/shared/permissoes.js";
import * as produtoCmvTool from "../src/modules/agente/tools/produtoCmv.tool.js";
import * as rankingTool from "../src/modules/agente/tools/produtosCmvRanking.tool.js";
import { montarRanking, MAX_PRODUTOS_TOOL } from "../src/modules/agente/tools/produtosCmvRanking.tool.js";

const ORG_ID = "33333333-3333-4333-8333-333333333333";
const OUTRA_ORG_ID = "77777777-7777-4777-8777-777777777777";
const UNIDADE_ID = "44444444-4444-4444-8444-444444444444";
const OUTRA_UNIDADE_ID = "99999999-9999-4999-8999-999999999999";

const ACESSO_COM_MODULO = { modulos: [MODULOS.PRODUTOS_CMV], permissoes: [PERMISSOES.CMV_VER], impersonando: false };
const ACESSO_SEM_MODULO = { modulos: [], permissoes: [PERMISSOES.CMV_VER], impersonando: false };
const ACESSO_SEM_PERMISSAO = { modulos: [MODULOS.PRODUTOS_CMV], permissoes: [], impersonando: false };

describe("consultar_produto_cmv", () => {
  const BMT = { id: "p1", nome: "BMT 15cm", tipo: "sanduiche", tamanho: "15cm", ativo: true };
  const LINHA_MARGEM = { canal: "balcao", tabela: "A", preco: 29.9, custo: 8.72, comissao_pct: 0, lucro_liquido: 21.18, cmv_pct: 29.16, desatualizado: false };
  const FICHA_BMT = [
    { ficha_id: "f1", tipo: "insumo", nome: "Pão Italiano", quantidade: 1, unidade: "un", ativo: true },
    { ficha_id: "f2", tipo: "insumo", nome: "Presunto", quantidade: 60, unidade: "g", ativo: true },
    { ficha_id: "f3", tipo: "insumo", nome: "Queijo Cheddar", quantidade: 30, unidade: "g", ativo: false },
  ];
  const DETALHE_COMPLETO = { qtd_componentes: 8, status_ficha: { chave: "completa", label: "Completa", ok: true }, custo_manual: null, ficha: FICHA_BMT };

  test("produto existente: custo, preço e CMV corretos, vindos da view oficial", async () => {
    let chamadaBusca = null, chamadaMargem = null, chamadaDetalhe = null;
    const deps = {
      buscarCandidatos: async (args) => { chamadaBusca = args; return [BMT]; },
      margemProduto: async (args) => { chamadaMargem = args; return [LINHA_MARGEM]; },
      obterProduto: async (args) => { chamadaDetalhe = args; return DETALHE_COMPLETO; },
      resolverTabelas: async () => ({ tabelaBalcao: null, tabelaIfood: null }),
    };
    const r = await produtoCmvTool.executar({ produto: "BMT" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);

    assert.equal(r.encontrado, true);
    assert.equal(r.produto.nome, "BMT 15cm");
    assert.equal(r.produto.precos[0].custoTotal, 8.72);
    assert.equal(r.produto.precos[0].precoVenda, 29.9);
    assert.equal(r.produto.precos[0].cmvPercentual, 29.16);
    assert.equal(chamadaBusca.organizacaoId, ORG_ID);
    assert.equal(chamadaMargem.organizacaoId, ORG_ID);
    assert.equal(chamadaMargem.produtoId, "p1");
    assert.equal(chamadaDetalhe.organizacaoId, ORG_ID);
  });

  // Subway Saci: Balcão = E, iFood = Z4 (exemplo real do pedido original).
  test("marca a linha 'oficial: true' na tabela comercial da unidade — nunca a primeira da lista", async () => {
    const linhaE = { canal: "balcao", tabela: "E", preco: 29.9, custo: 8.72, comissao_pct: 0, lucro_liquido: 21.18, cmv_pct: 29.16, desatualizado: false };
    const linhaA = { ...linhaE, tabela: "A", preco: 25 }; // aparece ANTES na lista, mas não é a oficial
    const linhaZ4 = { canal: "ifood", tabela: "Z4", preco: 34.9, custo: 8.72, comissao_pct: 0.27, lucro_liquido: 15, cmv_pct: 25, desatualizado: false };
    const deps = {
      buscarCandidatos: async () => [BMT],
      margemProduto: async () => [linhaA, linhaE, linhaZ4],
      obterProduto: async () => DETALHE_COMPLETO,
      resolverTabelas: async () => ({ tabelaBalcao: "E", tabelaIfood: "Z4" }),
    };
    const r = await produtoCmvTool.executar({ produto: "BMT" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);

    assert.deepEqual(r.produto.tabelasOficiais, { balcao: "E", ifood: "Z4" });
    const porTabela = Object.fromEntries(r.produto.precos.map((p) => [`${p.canal}:${p.tabela}`, p.oficial]));
    assert.equal(porTabela["balcao:A"], false);
    assert.equal(porTabela["balcao:E"], true);
    assert.equal(porTabela["ifood:Z4"], true);
  });

  test("sem tabela comercial configurada na unidade: nenhuma linha vira 'oficial' por acidente", async () => {
    const deps = {
      buscarCandidatos: async () => [BMT],
      margemProduto: async () => [LINHA_MARGEM],
      obterProduto: async () => DETALHE_COMPLETO,
      resolverTabelas: async () => ({ tabelaBalcao: null, tabelaIfood: null }),
    };
    const r = await produtoCmvTool.executar({ produto: "BMT" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.produto.precos.every((p) => p.oficial === false), true);
  });

  test("ficha técnica (insumos) vem no retorno — 'o que tem no BMT?'", async () => {
    const deps = { buscarCandidatos: async () => [BMT], margemProduto: async () => [LINHA_MARGEM], obterProduto: async () => DETALHE_COMPLETO, resolverTabelas: async () => ({ tabelaBalcao: null, tabelaIfood: null }) };
    const r = await produtoCmvTool.executar({ produto: "BMT" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.produto.fichaTecnica.length, 3);
    assert.deepEqual(r.produto.fichaTecnica.map((c) => c.nome), ["Pão Italiano", "Presunto", "Queijo Cheddar"]);
    assert.equal(r.produto.fichaTecnica[1].quantidade, 60);
    assert.equal(r.produto.fichaTecnica[1].unidade, "g");
    assert.equal(r.produto.fichaTecnica[2].ativo, false); // insumo inativo sinalizado, não escondido
  });

  // Etapa C — composição de custo ("o que mais pesa no custo do BMT?").
  test("fichaTecnica traz custoAplicado/participacaoPctNoCusto, ordenada do que mais pesa pro que menos pesa", async () => {
    const detalheComCusto = {
      qtd_componentes: 3, status_ficha: { chave: "completa", label: "Completa", ok: true }, custo_manual: null,
      custo_calculado: 5, // soma dos custo_aplicado ativos: 1 (pão) + 3 (presunto) = 4... + queijo inativo não conta
      ficha: [
        { ficha_id: "f1", tipo: "insumo", nome: "Pão Italiano", quantidade: 1, unidade: "un", ativo: true, custo_aplicado: 1 },
        { ficha_id: "f2", tipo: "insumo", nome: "Presunto", quantidade: 60, unidade: "g", ativo: true, custo_aplicado: 3 },
        { ficha_id: "f3", tipo: "insumo", nome: "Queijo Cheddar", quantidade: 30, unidade: "g", ativo: false, custo_aplicado: 2 },
      ],
    };
    const deps = { buscarCandidatos: async () => [BMT], margemProduto: async () => [LINHA_MARGEM], obterProduto: async () => detalheComCusto, resolverTabelas: async () => ({ tabelaBalcao: null, tabelaIfood: null }) };
    const r = await produtoCmvTool.executar({ produto: "BMT" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);

    // Ordenado do maior custoAplicado pro menor: Presunto (3) > Queijo (2) > Pão (1).
    assert.deepEqual(r.produto.fichaTecnica.map((c) => c.nome), ["Presunto", "Queijo Cheddar", "Pão Italiano"]);

    const presunto = r.produto.fichaTecnica.find((c) => c.nome === "Presunto");
    assert.equal(presunto.custoAplicado, 3);
    assert.equal(presunto.participacaoPctNoCusto, 60); // 3/5 * 100

    const pao = r.produto.fichaTecnica.find((c) => c.nome === "Pão Italiano");
    assert.equal(pao.custoAplicado, 1);
    assert.equal(pao.participacaoPctNoCusto, 20); // 1/5 * 100

    // Linha INATIVA: custoAplicado mostrado (transparência), mas NUNCA participação
    // (ela não entra em custo_calculado — mostrar uma % aqui somaria mais que 100%).
    const queijo = r.produto.fichaTecnica.find((c) => c.nome === "Queijo Cheddar");
    assert.equal(queijo.custoAplicado, 2);
    assert.equal(queijo.participacaoPctNoCusto, null);
  });

  test("sem custo_calculado (produto com ficha incompleta): participacaoPctNoCusto sempre null, nunca divide por zero/undefined", async () => {
    const detalheIncompleto = {
      qtd_componentes: 1, status_ficha: { chave: "insumo_sem_custo", label: "Insumo sem custo", ok: false }, custo_manual: null,
      custo_calculado: 0,
      ficha: [{ ficha_id: "f1", tipo: "insumo", nome: "Insumo X", quantidade: 1, unidade: "un", ativo: true, custo_aplicado: 0 }],
    };
    const deps = { buscarCandidatos: async () => [BMT], margemProduto: async () => [LINHA_MARGEM], obterProduto: async () => detalheIncompleto, resolverTabelas: async () => ({ tabelaBalcao: null, tabelaIfood: null }) };
    const r = await produtoCmvTool.executar({ produto: "BMT" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.produto.fichaTecnica[0].participacaoPctNoCusto, null);
  });

  test("produto inexistente: encontrado false, motivo nao_encontrado", async () => {
    const deps = { buscarCandidatos: async () => [], margemProduto: async () => [], obterProduto: async () => ({}), resolverTabelas: async () => ({ tabelaBalcao: null, tabelaIfood: null }) };
    const r = await produtoCmvTool.executar({ produto: "produto que não existe" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.encontrado, false);
    assert.equal(r.motivo, "nao_encontrado");
  });

  test("busca ambígua ('cookie' com 2 cookies): devolve candidatos, nunca escolhe sozinho", async () => {
    const cookies = [
      { id: "c1", nome: "Cookie Chocolate", tipo: "sobremesa", tamanho: null, ativo: true },
      { id: "c2", nome: "Cookie Aveia", tipo: "sobremesa", tamanho: null, ativo: true },
    ];
    let chamouMargem = false;
    const deps = { buscarCandidatos: async () => cookies, margemProduto: async () => { chamouMargem = true; return []; }, obterProduto: async () => ({}), resolverTabelas: async () => ({ tabelaBalcao: null, tabelaIfood: null }) };
    const r = await produtoCmvTool.executar({ produto: "cookie" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.encontrado, false);
    assert.equal(r.motivo, "ambiguo");
    assert.equal(r.candidatos.length, 2);
    assert.equal(chamouMargem, false); // ambíguo nunca chega a consultar detalhe/margem
  });

  test("produto inativo: retorno sinaliza ativo: false, sem esconder", async () => {
    const inativo = { ...BMT, ativo: false };
    const deps = { buscarCandidatos: async () => [inativo], margemProduto: async () => [LINHA_MARGEM], obterProduto: async () => DETALHE_COMPLETO, resolverTabelas: async () => ({ tabelaBalcao: null, tabelaIfood: null }) };
    const r = await produtoCmvTool.executar({ produto: "BMT" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.produto.ativo, false);
  });

  test("produto sem ficha técnica completa: nunca vira custo zero, sinaliza a limitação", async () => {
    const detalheIncompleto = { qtd_componentes: 3, status_ficha: { chave: "insumo_sem_custo", label: "Insumo sem custo", ok: false }, custo_manual: null };
    const deps = { buscarCandidatos: async () => [BMT], margemProduto: async () => [LINHA_MARGEM], obterProduto: async () => detalheIncompleto, resolverTabelas: async () => ({ tabelaBalcao: null, tabelaIfood: null }) };
    const r = await produtoCmvTool.executar({ produto: "BMT" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.produto.possuiFichaTecnicaCompleta, false);
    assert.equal(r.produto.statusFicha, "insumo_sem_custo");
  });

  test("custo manual configurado é sinalizado, sem misturar com o custo da view", async () => {
    const detalheComOverride = { qtd_componentes: 8, status_ficha: { chave: "completa", label: "Completa", ok: true }, custo_manual: 12.5 };
    const deps = { buscarCandidatos: async () => [BMT], margemProduto: async () => [LINHA_MARGEM], obterProduto: async () => detalheComOverride, resolverTabelas: async () => ({ tabelaBalcao: null, tabelaIfood: null }) };
    const r = await produtoCmvTool.executar({ produto: "BMT" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.produto.custoManualConfigurado, true);
    assert.equal(r.produto.precos[0].custoTotal, 8.72); // continua vindo da view, nunca misturado
  });

  test("tenant correto: organizacaoId/unidadeId vêm do CONTEXTO, nunca do input", async () => {
    let chamadaBusca = null;
    const deps = { buscarCandidatos: async (a) => { chamadaBusca = a; return [BMT]; }, margemProduto: async () => [LINHA_MARGEM], obterProduto: async () => DETALHE_COMPLETO, resolverTabelas: async () => ({ tabelaBalcao: null, tabelaIfood: null }) };
    await produtoCmvTool.executar(
      { produto: "BMT", organizacaoId: "org-de-outro-tenant", unidadeId: OUTRA_UNIDADE_ID },
      { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO },
      deps,
    );
    assert.equal(chamadaBusca.organizacaoId, ORG_ID);
  });

  test("módulo Produtos/CMV desabilitado nega, sem consultar nada", async () => {
    let chamou = false;
    const deps = { buscarCandidatos: async () => { chamou = true; return [BMT]; }, margemProduto: async () => [], obterProduto: async () => ({}), resolverTabelas: async () => ({ tabelaBalcao: null, tabelaIfood: null }) };
    await assert.rejects(
      () => produtoCmvTool.executar({ produto: "BMT" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_SEM_MODULO }, deps),
      /não contratado/,
    );
    assert.equal(chamou, false);
  });

  test("permissão cmv.ver ausente nega, sem consultar nada", async () => {
    let chamou = false;
    const deps = { buscarCandidatos: async () => { chamou = true; return [BMT]; }, margemProduto: async () => [], obterProduto: async () => ({}), resolverTabelas: async () => ({ tabelaBalcao: null, tabelaIfood: null }) };
    await assert.rejects(
      () => produtoCmvTool.executar({ produto: "BMT" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_SEM_PERMISSAO }, deps),
      /Permissão insuficiente/,
    );
    assert.equal(chamou, false);
  });

  test("mensagem vazia é rejeitada sem chamar o service", async () => {
    let chamou = false;
    const deps = { buscarCandidatos: async () => { chamou = true; return []; }, margemProduto: async () => [], obterProduto: async () => ({}), resolverTabelas: async () => ({ tabelaBalcao: null, tabelaIfood: null }) };
    await assert.rejects(() => produtoCmvTool.executar({ produto: "" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps));
    assert.equal(chamou, false);
  });
});

describe("listar_produtos_cmv — montarRanking (pura)", () => {
  const linha = (p) => ({ produto_id: p.id, nome: p.nome, canal: "balcao", tabela: "A", preco: p.preco, custo: p.custo, lucro_liquido: p.preco - p.custo, cmv_pct: p.cmv, desatualizado: false, ...p.extra });
  const A = linha({ id: "a", nome: "Produto A", preco: 20, custo: 10, cmv: 50 });
  const B = linha({ id: "b", nome: "Produto B", preco: 20, custo: 4, cmv: 20 });
  const C = linha({ id: "c", nome: "Produto C", preco: 20, custo: 16, cmv: 80 });
  const META = [
    { id: "a", tipo: "sanduiche", ativo: true },
    { id: "b", tipo: "bebida", ativo: true },
    { id: "c", tipo: "sanduiche", ativo: false },
  ];

  test("maior CMV primeiro (padrão: cmv_percentual desc)", () => {
    const r = montarRanking({ linhasMargem: [A, B], produtosMeta: META });
    assert.deepEqual(r.itens.map((i) => i.produtoId), ["a", "b"]); // C está inativo, fora por padrão
  });

  test("menor CMV primeiro (ordem asc)", () => {
    const r = montarRanking({ linhasMargem: [A, B], produtosMeta: META, ordem: "asc" });
    assert.deepEqual(r.itens.map((i) => i.produtoId), ["b", "a"]);
  });

  test("maior custo (ordenarPor custo)", () => {
    const r = montarRanking({ linhasMargem: [A, B], produtosMeta: META, ordenarPor: "custo" });
    assert.deepEqual(r.itens.map((i) => i.produtoId), ["a", "b"]); // custo 10 > 4
  });

  test("filtro por categoria", () => {
    const r = montarRanking({ linhasMargem: [A, B], produtosMeta: META, categoria: "bebida" });
    assert.deepEqual(r.itens.map((i) => i.produtoId), ["b"]);
  });

  test("limite máximo nunca ultrapassa MAX_PRODUTOS_TOOL, mesmo pedindo mais", () => {
    const muitosLinha = Array.from({ length: 60 }, (_, i) => linha({ id: `p${i}`, nome: `Produto ${i}`, preco: 20, custo: 5, cmv: 25 }));
    const muitosMeta = muitosLinha.map((l) => ({ id: l.produto_id, tipo: "outro", ativo: true }));
    const r = montarRanking({ linhasMargem: muitosLinha, produtosMeta: muitosMeta, limite: 10000 });
    assert.equal(r.limiteAplicado, MAX_PRODUTOS_TOOL);
    assert.equal(r.itens.length, MAX_PRODUTOS_TOOL);
  });

  test("somente ativos por padrão — inativo (Produto C) fica de fora sem pedir explicitamente", () => {
    const r = montarRanking({ linhasMargem: [A, B, C], produtosMeta: META });
    assert.ok(!r.itens.some((i) => i.produtoId === "c"));
  });

  test("ativo: false traz só os inativos quando pedido explicitamente", () => {
    const r = montarRanking({ linhasMargem: [A, B, C], produtosMeta: META, apenasAtivos: false });
    assert.deepEqual(r.itens.map((i) => i.produtoId), ["c"]);
  });

  test("produto sem CMV (null) nunca é tratado como 0 — vai sempre para o fim, em qualquer ordem", () => {
    const semCmv = linha({ id: "d", nome: "Produto D", preco: 0, custo: 5, cmv: null, extra: { preco: null } });
    const metaComD = [...META, { id: "d", tipo: "outro", ativo: true }];
    const desc = montarRanking({ linhasMargem: [A, B, semCmv], produtosMeta: metaComD, ordem: "desc" });
    const asc = montarRanking({ linhasMargem: [A, B, semCmv], produtosMeta: metaComD, ordem: "asc" });
    assert.equal(desc.itens[desc.itens.length - 1].produtoId, "d");
    assert.equal(asc.itens[asc.itens.length - 1].produtoId, "d");
  });

  test("múltiplas tabelas do mesmo produto viram 1 linha só, sinalizada", () => {
    const outraTabela = { ...A, tabela: "B", cmv_pct: 55 };
    const r = montarRanking({ linhasMargem: [A, outraTabela, B], produtosMeta: META });
    const itemA = r.itens.find((i) => i.produtoId === "a");
    assert.equal(itemA.outrasTabelasDisponiveis, true);
    assert.equal(r.itens.length, 2); // a e b, nunca 3 linhas pro mesmo produto
  });
});

describe("listar_produtos_cmv — executar (I/O injetado)", () => {
  test("nenhuma consulta por produto — sempre 2 chamadas fixas (margens + meta), independente de quantos produtos existam", async () => {
    let chamadasMargens = 0, chamadasMeta = 0;
    const deps = {
      listarMargens: async () => { chamadasMargens++; return []; },
      listarProdutosMeta: async () => { chamadasMeta++; return []; },
      resolverTabela: async () => null,
    };
    await rankingTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(chamadasMargens, 1);
    assert.equal(chamadasMeta, 1);
  });

  test("tenant correto: organizacaoId/unidadeId do CONTEXTO chegam às dependências", async () => {
    let argsMargens = null, argsTabela = null;
    const deps = {
      listarMargens: async (a) => { argsMargens = a; return []; },
      listarProdutosMeta: async () => [],
      resolverTabela: async (a) => { argsTabela = a; return null; },
    };
    await rankingTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(argsMargens.organizacaoId, ORG_ID);
    assert.equal(argsTabela.unidadeId, UNIDADE_ID);
  });

  test("módulo desabilitado nega, sem consultar nada", async () => {
    let chamou = false;
    const deps = { listarMargens: async () => { chamou = true; return []; }, listarProdutosMeta: async () => [], resolverTabela: async () => null };
    await assert.rejects(
      () => rankingTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_SEM_MODULO }, deps),
      /não contratado/,
    );
    assert.equal(chamou, false);
  });

  test("permissão ausente nega, sem consultar nada", async () => {
    let chamou = false;
    const deps = { listarMargens: async () => { chamou = true; return []; }, listarProdutosMeta: async () => [], resolverTabela: async () => null };
    await assert.rejects(
      () => rankingTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_SEM_PERMISSAO }, deps),
      /Permissão insuficiente/,
    );
    assert.equal(chamou, false);
  });

  test("categoria fora do enum válido é ignorada silenciosamente, nunca vira SQL/erro", async () => {
    let argsMeta = null;
    const deps = {
      listarMargens: async () => [{ produto_id: "a", nome: "A", canal: "balcao", tabela: "A", preco: 10, custo: 5, cmv_pct: 50 }],
      listarProdutosMeta: async (a) => { argsMeta = a; return [{ id: "a", tipo: "sanduiche", ativo: true }]; },
      resolverTabela: async () => null,
    };
    const r = await rankingTool.executar({ categoria: "'; DROP TABLE produtos; --" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(argsMeta.organizacaoId, ORG_ID); // consulta normal, nada injetado
    assert.equal(r.itens.length, 1); // filtro de categoria inválida foi ignorado, não zerou nem quebrou
  });
});
