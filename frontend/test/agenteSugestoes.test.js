// Testes do catálogo de sugestões contextuais do Agente Crescer — unit,
// puro (sem DOM).
//
// Rodar: node --test frontend/test/agenteSugestoes.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { obterSugestoes, MAX_SUGESTOES, rotuloBotaoContextual } from "../src/agenteSugestoes.js";

describe("obterSugestoes", () => {
  test("sem pageContext (null) -> sugestões genéricas", () => {
    const s = obterSugestoes(null);
    assert.ok(s.length > 0);
    assert.ok(s.length <= MAX_SUGESTOES);
  });

  test("Dashboard Executivo -> sugestões do módulo", () => {
    const s = obterSugestoes({ module: "dashboard_executivo", view: "mes" });
    assert.ok(s.includes("Analise meu mês"));
  });

  test("Etapa H — Dashboard Executivo com view 'diagnostico' -> sugestões DIFERENTES da visão normal, máx. 4", () => {
    const normal = obterSugestoes({ module: "dashboard_executivo", view: "mes" });
    const diagnostico = obterSugestoes({ module: "dashboard_executivo", view: "diagnostico" });
    assert.notDeepEqual(normal, diagnostico);
    assert.ok(diagnostico.length <= MAX_SUGESTOES);
    assert.ok(diagnostico.includes("O que devo fazer primeiro?"));
  });

  test("Produtos/CMV lista vs produto aberto -> conjuntos DIFERENTES", () => {
    const lista = obterSugestoes({ module: "products_cmv", view: "lista" });
    const produto = obterSugestoes({ module: "products_cmv", view: "produto" });
    assert.notDeepEqual(lista, produto);
    assert.ok(produto.includes("Analise este produto"));
    assert.ok(lista.includes("Quais produtos têm maior CMV?"));
  });

  test("Insumos lista vs insumo aberto -> conjuntos DIFERENTES", () => {
    const lista = obterSugestoes({ module: "ingredients", view: "lista" });
    const insumo = obterSugestoes({ module: "ingredients", view: "insumo" });
    assert.notDeepEqual(lista, insumo);
    assert.ok(insumo.includes("Quais produtos usam este insumo?"));
  });

  test("Parser: cancelamentos vs pedido aberto -> conjuntos DIFERENTES", () => {
    const cancelamentos = obterSugestoes({ module: "parser_food_delivery", view: "cancelamentos" });
    const pedido = obterSugestoes({ module: "parser_food_delivery", view: "pedido" });
    assert.notDeepEqual(cancelamentos, pedido);
    assert.ok(cancelamentos.includes("Quais precisam de revisão?"));
  });

  test("módulo conhecido mas view desconhecida -> cai num fallback, nunca lança", () => {
    assert.doesNotThrow(() => obterSugestoes({ module: "products_cmv", view: "view-que-nao-existe" }));
  });

  test("módulo desconhecido -> genéricas, nunca lança", () => {
    assert.doesNotThrow(() => obterSugestoes({ module: "modulo-inventado" }));
  });

  test("NUNCA mais que MAX_SUGESTOES (4), em nenhum contexto do catálogo", () => {
    const contextos = [
      null, { module: "dashboard_executivo" },
      { module: "products_cmv", view: "lista" }, { module: "products_cmv", view: "produto" },
      { module: "ingredients", view: "lista" }, { module: "ingredients", view: "insumo" },
      { module: "parser_food_delivery", view: "cancelamentos" }, { module: "parser_food_delivery", view: "pedido" },
      { module: "dashboard_executivo", view: "diagnostico" },
    ];
    for (const ctx of contextos) assert.ok(obterSugestoes(ctx).length <= 4, JSON.stringify(ctx));
  });
});

describe("rotuloBotaoContextual", () => {
  test("chaves conhecidas devolvem o rótulo esperado do pedido", () => {
    assert.equal(rotuloBotaoContextual("dashboard_executivo"), "Analisar com Agente Crescer");
    assert.equal(rotuloBotaoContextual("products_cmv_lista"), "Analisar Produtos / CMV");
    assert.equal(rotuloBotaoContextual("products_cmv_produto"), "Analisar este produto");
    assert.equal(rotuloBotaoContextual("ingredients_lista"), "Analisar Insumos");
    assert.equal(rotuloBotaoContextual("ingredients_insumo"), "Analisar este insumo");
    assert.equal(rotuloBotaoContextual("parser_food_delivery"), "Investigar cancelamentos");
    assert.equal(rotuloBotaoContextual("dashboard_diagnostico"), "Diagnosticar com Agente Crescer");
  });
});
