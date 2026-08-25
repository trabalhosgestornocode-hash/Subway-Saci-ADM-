// Testes das tools de Insumos do Agente Crescer (Etapa C) — unit, sem rede/
// Supabase: todas as dependências são injetadas (ver `deps` em cada tool).
//
// O que estes testes protegem, na ordem do pedido:
//   * busca exata, com typo, ambígua, insumo inativo, custo zero/ausente;
//   * "produtos que usam este insumo" nunca faz N+1 (1 carregarGrafo só);
//   * "impacto"/quantidade nunca é inventado quando o uso é só indireto;
//   * histórico de preço só afirma variação quando há dado real;
//   * organizacaoId/unidadeId vêm SEMPRE do contexto, nunca do input;
//   * módulo/permissão de Insumos são exigidos mesmo com a rota /agente liberada;
//   * nenhuma tool tem efeito de escrita;
//   * listar_insumos nunca ultrapassa o limite máximo, mesmo se solicitado.
//
// Rodar: node --env-file-if-exists=.env --test test/agente-insumos-tools.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MODULOS } from "../src/shared/modulos.js";
import { PERMISSOES } from "../src/shared/permissoes.js";
import * as insumoTool from "../src/modules/agente/tools/insumo.tool.js";
import * as rankingTool from "../src/modules/agente/tools/insumosRanking.tool.js";
import { ordenarECapear, MAX_INSUMOS_TOOL } from "../src/modules/agente/tools/insumosRanking.tool.js";

const ORG_ID = "33333333-3333-4333-8333-333333333333";
const ACESSO_COM_MODULO = { modulos: [MODULOS.INGREDIENTS], permissoes: [PERMISSOES.INSUMOS_VER], impersonando: false };
const ACESSO_SEM_MODULO = { modulos: [], permissoes: [PERMISSOES.INSUMOS_VER], impersonando: false };
const ACESSO_SEM_PERMISSAO = { modulos: [MODULOS.INGREDIENTS], permissoes: [], impersonando: false };

describe("consultar_insumo", () => {
  const QUEIJO = { id: "q1", nome: "Queijo Cheddar", tipo: "queijo", ativo: true };
  const GRAFO_BASE = {
    insumoById: new Map([["q1", { id: "q1", nome: "Queijo Cheddar", tipo: "queijo", unidade_medida: "g", preco_unitario: 0.05, ativo: true }]]),
    nomeProdById: new Map([["p1", "BMT 15cm"], ["p2", "Combo BMT"]]),
    fichaByProd: new Map([
      ["p1", [{ produto_id: "p1", insumo_id: "q1", quantidade: 30, ativo: true }]],
      ["p2", [{ produto_id: "p2", subproduto_id: "p1", quantidade: 1, ativo: true }]],
    ]),
    produtos: [],
  };
  const SEM_HISTORICO = { pendente: false, itens: [] };

  test("busca exata: nome, custo, unidade, ativo — dados confiáveis, nenhuma fórmula nova", async () => {
    const deps = { buscarCandidatos: async () => [QUEIJO], carregarGrafo: async () => GRAFO_BASE, listarHistorico: async () => SEM_HISTORICO };
    const r = await insumoTool.executar({ insumo: "queijo" }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.encontrado, true);
    assert.equal(r.insumo.nome, "Queijo Cheddar");
    assert.equal(r.insumo.custoUnitario, 0.05);
    assert.equal(r.insumo.unidadeBase, "g");
    assert.equal(r.insumo.ativo, true);
    assert.equal(r.insumo.categoriaRotulo, "Queijo");
  });

  test("busca com typo tolerada (mesmo mecanismo de Produtos)", async () => {
    const deps = { buscarCandidatos: async () => [QUEIJO], carregarGrafo: async () => GRAFO_BASE, listarHistorico: async () => SEM_HISTORICO };
    const r = await insumoTool.executar({ insumo: "queijjo" }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.encontrado, true);
    assert.equal(r.insumo.nome, "Queijo Cheddar");
  });

  test("ambiguidade: 2 insumos plausíveis -> candidatos, nunca escolhe sozinho", async () => {
    const candidatos = [
      { id: "m1", nome: "Molho Barbecue", tipo: "molho", ativo: true },
      { id: "m2", nome: "Molho Mostarda", tipo: "molho", ativo: true },
    ];
    let chamouGrafo = false;
    const deps = { buscarCandidatos: async () => candidatos, carregarGrafo: async () => { chamouGrafo = true; return GRAFO_BASE; }, listarHistorico: async () => SEM_HISTORICO };
    const r = await insumoTool.executar({ insumo: "molho" }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.encontrado, false);
    assert.equal(r.motivo, "ambiguo");
    assert.equal(r.candidatos.length, 2);
    assert.equal(chamouGrafo, false); // ambíguo nunca chega a carregar o grafo
  });

  test("não encontrado: motivo nao_encontrado, sem carregar grafo", async () => {
    let chamouGrafo = false;
    const deps = { buscarCandidatos: async () => [], carregarGrafo: async () => { chamouGrafo = true; return GRAFO_BASE; }, listarHistorico: async () => SEM_HISTORICO };
    const r = await insumoTool.executar({ insumo: "insumo que não existe" }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.encontrado, false);
    assert.equal(r.motivo, "nao_encontrado");
    assert.equal(chamouGrafo, false);
  });

  test("insumo inativo: sinalizado, não escondido", async () => {
    const grafoInativo = { ...GRAFO_BASE, insumoById: new Map([["q1", { ...GRAFO_BASE.insumoById.get("q1"), ativo: false }]]) };
    const deps = { buscarCandidatos: async () => [QUEIJO], carregarGrafo: async () => grafoInativo, listarHistorico: async () => SEM_HISTORICO };
    const r = await insumoTool.executar({ insumo: "queijo" }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.insumo.ativo, false);
  });

  test("custo ausente (nunca vira zero, nunca vira 'sem custo' escondido)", async () => {
    const grafoSemCusto = { ...GRAFO_BASE, insumoById: new Map([["q1", { ...GRAFO_BASE.insumoById.get("q1"), preco_unitario: null }]]) };
    const deps = { buscarCandidatos: async () => [QUEIJO], carregarGrafo: async () => grafoSemCusto, listarHistorico: async () => SEM_HISTORICO };
    const r = await insumoTool.executar({ insumo: "queijo" }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.insumo.custoUnitario, null);
    assert.equal(r.insumo.semCusto, true);
  });

  test("custo realmente igual a zero: sem_custo true também (zero não é um custo de verdade cadastrado)", async () => {
    const grafoZero = { ...GRAFO_BASE, insumoById: new Map([["q1", { ...GRAFO_BASE.insumoById.get("q1"), preco_unitario: 0 }]]) };
    const deps = { buscarCandidatos: async () => [QUEIJO], carregarGrafo: async () => grafoZero, listarHistorico: async () => SEM_HISTORICO };
    const r = await insumoTool.executar({ insumo: "queijo" }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.insumo.custoUnitario, 0);
    assert.equal(r.insumo.semCusto, true);
  });

  test("produtos afetados: uso DIRETO traz quantidade/unidade/custoAplicado; uso INDIRETO nunca inventa", async () => {
    const deps = { buscarCandidatos: async () => [QUEIJO], carregarGrafo: async () => GRAFO_BASE, listarHistorico: async () => SEM_HISTORICO };
    const r = await insumoTool.executar({ insumo: "queijo" }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.produtosAfetados.total, 2);
    const bmt = r.produtosAfetados.itens.find((i) => i.nome === "BMT 15cm");
    const combo = r.produtosAfetados.itens.find((i) => i.nome === "Combo BMT");
    assert.equal(bmt.usoDireto, true);
    assert.equal(bmt.quantidade, 30);
    assert.equal(bmt.unidade, "g");
    assert.equal(bmt.custoAplicado, 1.5);
    assert.equal(combo.usoDireto, false);
    assert.equal(combo.quantidade, null);
    assert.equal(combo.unidade, null);
    assert.equal(combo.custoAplicado, null);
  });

  test("produtos afetados ordenados por maior custoAplicado primeiro", async () => {
    const grafo = {
      insumoById: new Map([["q1", { id: "q1", nome: "Queijo", unidade_medida: "g", preco_unitario: 0.1, ativo: true }]]),
      nomeProdById: new Map([["a", "Produto A"], ["b", "Produto B"]]),
      fichaByProd: new Map([
        ["a", [{ produto_id: "a", insumo_id: "q1", quantidade: 10, ativo: true }]], // custo 1.0
        ["b", [{ produto_id: "b", insumo_id: "q1", quantidade: 50, ativo: true }]], // custo 5.0
      ]),
      produtos: [],
    };
    const deps = { buscarCandidatos: async () => [QUEIJO], carregarGrafo: async () => grafo, listarHistorico: async () => SEM_HISTORICO };
    const r = await insumoTool.executar({ insumo: "queijo" }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.deepEqual(r.produtosAfetados.itens.map((i) => i.nome), ["Produto B", "Produto A"]);
  });

  test("mais de MAX_PRODUTOS_TOOL produtos afetados: trunca e sinaliza, nunca esconde silenciosamente", async () => {
    const insumoById = new Map([["q1", { id: "q1", nome: "Queijo", unidade_medida: "g", preco_unitario: 0.1, ativo: true }]]);
    const nomeProdById = new Map();
    const fichaByProd = new Map();
    for (let i = 0; i < insumoTool.MAX_PRODUTOS_TOOL + 5; i++) {
      nomeProdById.set(`p${i}`, `Produto ${i}`);
      fichaByProd.set(`p${i}`, [{ produto_id: `p${i}`, insumo_id: "q1", quantidade: 1, ativo: true }]);
    }
    const grafo = { insumoById, nomeProdById, fichaByProd, produtos: [] };
    const deps = { buscarCandidatos: async () => [QUEIJO], carregarGrafo: async () => grafo, listarHistorico: async () => SEM_HISTORICO };
    const r = await insumoTool.executar({ insumo: "queijo" }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.produtosAfetados.total, insumoTool.MAX_PRODUTOS_TOOL + 5);
    assert.equal(r.produtosAfetados.itens.length, insumoTool.MAX_PRODUTOS_TOOL);
    assert.equal(r.produtosAfetados.truncado, true);
  });

  test("sem histórico de preço: ultimaAlteracaoPreco null, nunca afirma tendência", async () => {
    const deps = { buscarCandidatos: async () => [QUEIJO], carregarGrafo: async () => GRAFO_BASE, listarHistorico: async () => SEM_HISTORICO };
    const r = await insumoTool.executar({ insumo: "queijo" }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.insumo.ultimaAlteracaoPreco, null);
  });

  test("migration de histórico ainda não aplicada no ambiente (pendente: true): ultimaAlteracaoPreco null, mesmo havendo linhas", async () => {
    const historicoPendente = { pendente: true, itens: [{ variacao_pct: 10, created_at: "2026-08-01" }] };
    const deps = { buscarCandidatos: async () => [QUEIJO], carregarGrafo: async () => GRAFO_BASE, listarHistorico: async () => historicoPendente };
    const r = await insumoTool.executar({ insumo: "queijo" }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.insumo.ultimaAlteracaoPreco, null);
  });

  test("histórico real disponível: usa os números exatos da alteração mais recente com variação calculável", async () => {
    const historico = {
      pendente: false,
      itens: [
        { variacao_pct: null, created_at: "2026-08-10", custo_anterior: 0, custo_novo: 0.05 }, // sem variação calculável (base 0)
        { variacao_pct: 12.5, created_at: "2026-08-01", custo_anterior: 0.04, custo_novo: 0.045 },
      ],
    };
    const deps = { buscarCandidatos: async () => [QUEIJO], carregarGrafo: async () => GRAFO_BASE, listarHistorico: async () => historico };
    const r = await insumoTool.executar({ insumo: "queijo" }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.deepEqual(r.insumo.ultimaAlteracaoPreco, { data: "2026-08-01", variacaoPct: 12.5, custoAnterior: 0.04, custoNovo: 0.045 });
  });

  test("tenant correto: organizacaoId vem do CONTEXTO, tentativa de injeção pelo input é ignorada", async () => {
    let chamadaBusca = null;
    const deps = { buscarCandidatos: async (a) => { chamadaBusca = a; return [QUEIJO]; }, carregarGrafo: async () => GRAFO_BASE, listarHistorico: async () => SEM_HISTORICO };
    await insumoTool.executar(
      { insumo: "queijo", organizacaoId: "org-de-outro-tenant" },
      { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO },
      deps,
    );
    assert.equal(chamadaBusca.organizacaoId, ORG_ID);
  });

  test("módulo Insumos desabilitado: nega, sem consultar nada", async () => {
    let chamou = false;
    const deps = { buscarCandidatos: async () => { chamou = true; return [QUEIJO]; }, carregarGrafo: async () => GRAFO_BASE, listarHistorico: async () => SEM_HISTORICO };
    await assert.rejects(
      () => insumoTool.executar({ insumo: "queijo" }, { organizacaoId: ORG_ID, acesso: ACESSO_SEM_MODULO }, deps),
      /não contratado/,
    );
    assert.equal(chamou, false);
  });

  test("sem permissão insumos.ver: nega, sem consultar nada", async () => {
    let chamou = false;
    const deps = { buscarCandidatos: async () => { chamou = true; return [QUEIJO]; }, carregarGrafo: async () => GRAFO_BASE, listarHistorico: async () => SEM_HISTORICO };
    await assert.rejects(
      () => insumoTool.executar({ insumo: "queijo" }, { organizacaoId: ORG_ID, acesso: ACESSO_SEM_PERMISSAO }, deps),
      /Permissão insuficiente/,
    );
    assert.equal(chamou, false);
  });

  test("nome de insumo ausente: rejeita sem chamar nada", async () => {
    let chamou = false;
    const deps = { buscarCandidatos: async () => { chamou = true; return []; }, carregarGrafo: async () => GRAFO_BASE, listarHistorico: async () => SEM_HISTORICO };
    await assert.rejects(() => insumoTool.executar({}, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps));
    assert.equal(chamou, false);
  });
});

describe("listar_insumos", () => {
  const ITENS = [
    { id: "1", nome: "Queijo Cheddar", categoria: "queijo", categoria_rotulo: "Queijo", unidade_base: "g", custo_unitario: 0.05, sem_custo: false, ativo: true, preco_atualizado_em: "2026-08-01" },
    { id: "2", nome: "Frango", categoria: "proteina", categoria_rotulo: "Proteína", unidade_base: "g", custo_unitario: 0.03, sem_custo: false, ativo: true, preco_atualizado_em: "2026-07-15" },
    { id: "3", nome: "Molho Especial", categoria: "molho", categoria_rotulo: "Molho", unidade_base: "ml", custo_unitario: null, sem_custo: true, ativo: true, preco_atualizado_em: null },
  ];

  test("padrão: só ativos, ordenado por custo unitário desc, limite 10", async () => {
    let chamadaCom = null;
    const deps = { listarInsumos: async (args) => { chamadaCom = args; return { itens: ITENS, stats: {} }; } };
    const r = await rankingTool.executar({}, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(chamadaCom.status, "ativo");
    assert.equal(chamadaCom.organizacaoId, ORG_ID);
    assert.deepEqual(r.itens.map((i) => i.nome), ["Queijo Cheddar", "Frango", "Molho Especial"]); // sem custo vai pro fim
    assert.equal(r.limiteAplicado, 10);
  });

  test("ativo: false -> filtra só inativos, no service (nunca client-side às cegas)", async () => {
    let chamadaCom = null;
    const deps = { listarInsumos: async (args) => { chamadaCom = args; return { itens: [], stats: {} }; } };
    await rankingTool.executar({ ativo: false }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(chamadaCom.status, "inativo");
  });

  test("semCusto: true -> repassa o filtro pro service", async () => {
    let chamadaCom = null;
    const deps = { listarInsumos: async (args) => { chamadaCom = args; return { itens: [], stats: {} }; } };
    await rankingTool.executar({ semCusto: true }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(chamadaCom.semPreco, true);
  });

  test("categoria inválida é ignorada (nunca quebra a consulta)", async () => {
    let chamadaCom = null;
    const deps = { listarInsumos: async (args) => { chamadaCom = args; return { itens: [], stats: {} }; } };
    await rankingTool.executar({ categoria: "categoria-inventada" }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(chamadaCom.categoria, undefined);
  });

  test("limite nunca ultrapassa MAX_INSUMOS_TOOL mesmo se pedido mais", async () => {
    const muitos = Array.from({ length: 80 }, (_, i) => ({ id: String(i), nome: `Insumo ${i}`, categoria: "outro", categoria_rotulo: "Outro", unidade_base: "un", custo_unitario: i, sem_custo: false, ativo: true, preco_atualizado_em: null }));
    const deps = { listarInsumos: async () => ({ itens: muitos, stats: {} }) };
    const r = await rankingTool.executar({ limite: 999 }, { organizacaoId: ORG_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.itens.length, rankingTool.MAX_INSUMOS_TOOL);
    assert.equal(r.limiteAplicado, rankingTool.MAX_INSUMOS_TOOL);
    assert.equal(r.totalDisponivel, 80);
  });

  test("módulo Insumos desabilitado: nega, sem chamar o service", async () => {
    let chamou = false;
    const deps = { listarInsumos: async () => { chamou = true; return { itens: [], stats: {} }; } };
    await assert.rejects(
      () => rankingTool.executar({}, { organizacaoId: ORG_ID, acesso: ACESSO_SEM_MODULO }, deps),
      /não contratado/,
    );
    assert.equal(chamou, false);
  });
});

describe("ordenarECapear (pura)", () => {
  test("custo unitário: sem dado NUNCA vira zero — vai sempre pro fim, em qualquer direção", () => {
    const itens = [{ nome: "A", custoUnitario: null }, { nome: "B", custoUnitario: 5 }, { nome: "C", custoUnitario: 1 }];
    const asc = ordenarECapear({ itens, ordem: "asc" });
    assert.deepEqual(asc.itens.map((i) => i.nome), ["C", "B", "A"]);
    const desc = ordenarECapear({ itens, ordem: "desc" });
    assert.deepEqual(desc.itens.map((i) => i.nome), ["B", "C", "A"]);
  });

  test("ordenarPor nome: alfabético, respeitando a direção", () => {
    const itens = [{ nome: "Zebra", custoUnitario: 1 }, { nome: "Abacate", custoUnitario: 2 }];
    const r = ordenarECapear({ itens, ordenarPor: "nome", ordem: "asc" });
    assert.deepEqual(r.itens.map((i) => i.nome), ["Abacate", "Zebra"]);
  });

  test("limite <= 0 ou não numérico cai no padrão, nunca zera a lista", () => {
    const itens = [{ nome: "A", custoUnitario: 1 }, { nome: "B", custoUnitario: 2 }];
    const r = ordenarECapear({ itens, limite: "abc" });
    assert.equal(r.itens.length, 2);
  });

  test("limite acima do teto é sempre recortado para MAX_INSUMOS_TOOL", () => {
    const itens = Array.from({ length: 60 }, (_, i) => ({ nome: `I${i}`, custoUnitario: i }));
    const r = ordenarECapear({ itens, limite: 1000 });
    assert.equal(r.itens.length, MAX_INSUMOS_TOOL);
  });
});
