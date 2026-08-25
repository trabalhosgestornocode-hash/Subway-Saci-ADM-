// Testes do Page Context do Agente Crescer (frontend) — unit, puro (sem DOM).
// `derivarPageContext`/`descreverContextoPainel` recebem um retrato já
// coletado do estado real (nunca leem `state`/DOM sozinhas) — mesmo espírito
// das funções puras do backend (agente.pageContext.js).
//
// O que estes testes protegem, na ordem do pedido:
//   * Dashboard gera contexto correto (module + view + year/month reais);
//   * produto aberto gera contexto correto (productName, nunca custo/preço);
//   * insumo aberto gera contexto correto;
//   * Parser gera contexto correto (cancelamentos vs pedido aberto);
//   * rota desconhecida gera contexto neutro (null);
//   * nenhum contexto contém tenant/id técnico.
//
// Rodar: node --test frontend/test/agentePageContext.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { derivarPageContext, descreverContextoPainel, ROTULO_MODULO } from "../src/agentePageContext.js";

describe("derivarPageContext — Dashboard Executivo", () => {
  test("usa o período REAL selecionado na tela, nunca inventa", () => {
    const ctx = derivarPageContext({ rota: "dashboard-executivo", periodoDashboard: { ano: 2026, mes: 8 } });
    assert.deepEqual(ctx, { module: "dashboard_executivo", view: "mes", year: 2026, month: 8 });
  });

  test("sem período disponível (ainda carregando) -> module/view presentes, sem year/month inventados", () => {
    const ctx = derivarPageContext({ rota: "dashboard-executivo", periodoDashboard: null });
    assert.equal(ctx.module, "dashboard_executivo");
    assert.equal("year" in ctx, false);
    assert.equal("month" in ctx, false);
  });

  test("Etapa H — clique em '✦ Diagnosticar...' -> view vira 'diagnostico' + attentionPoint real", () => {
    const ctx = derivarPageContext({
      rota: "dashboard-executivo", periodoDashboard: { ano: 2026, mes: 8 },
      detalheAberto: { attentionPoint: "taxas_entregadores" },
    });
    assert.deepEqual(ctx, { module: "dashboard_executivo", view: "diagnostico", year: 2026, month: 8, attentionPoint: "taxas_entregadores" });
  });

  test("Etapa H — sem attentionPoint (visita normal) -> view continua 'mes', sem o campo", () => {
    const ctx = derivarPageContext({ rota: "dashboard-executivo", periodoDashboard: { ano: 2026, mes: 8 }, detalheAberto: { attentionPoint: null } });
    assert.equal(ctx.view, "mes");
    assert.equal("attentionPoint" in ctx, false);
  });
});

describe("derivarPageContext — Produtos/CMV", () => {
  test("lista (nenhum produto aberto)", () => {
    const ctx = derivarPageContext({ rota: "produtos", detalheAberto: { produto: null } });
    assert.deepEqual(ctx, { module: "products_cmv", view: "lista" });
  });

  test("produto aberto -> productName real, NUNCA custo/preço/id", () => {
    const ctx = derivarPageContext({ rota: "produtos", detalheAberto: { produto: "BMT 15 cm" } });
    assert.deepEqual(ctx, { module: "products_cmv", view: "produto", productName: "BMT 15 cm" });
    assert.equal("custo" in ctx, false);
    assert.equal("preco" in ctx, false);
    assert.equal("id" in ctx, false);
    assert.equal("produtoId" in ctx, false);
  });

  test("tabela oficial (sem comparação) -> channel/viewedTable/comparisonMode:false", () => {
    const ctx = derivarPageContext({
      rota: "produtos", detalheAberto: { produto: null },
      tabelaTela: { canal: "balcao", tabela: "E", comparando: false },
    });
    assert.deepEqual(ctx, { module: "products_cmv", view: "lista", channel: "balcao", viewedTable: "E", comparisonMode: false });
  });

  test("modo de comparação -> comparisonMode:true, viewedTable é a tabela em comparação (nunca a oficial)", () => {
    const ctx = derivarPageContext({
      rota: "produtos", detalheAberto: { produto: "BMT" },
      tabelaTela: { canal: "ifood", tabela: "A", comparando: true },
    });
    assert.equal(ctx.comparisonMode, true);
    assert.equal(ctx.channel, "ifood");
    assert.equal(ctx.viewedTable, "A");
    assert.equal(ctx.productName, "BMT");
  });

  test("sem tabelaTela (tela ainda não resolveu nada) -> sem channel/viewedTable/comparisonMode, nunca inventa", () => {
    const ctx = derivarPageContext({ rota: "produtos", detalheAberto: { produto: null } });
    assert.equal("channel" in ctx, false);
    assert.equal("viewedTable" in ctx, false);
    assert.equal("comparisonMode" in ctx, false);
  });
});

describe("derivarPageContext — Insumos", () => {
  test("lista (nenhum insumo aberto)", () => {
    const ctx = derivarPageContext({ rota: "insumos", detalheAberto: {} });
    assert.deepEqual(ctx, { module: "ingredients", view: "lista" });
  });

  test("insumo aberto -> ingredientName real", () => {
    const ctx = derivarPageContext({ rota: "insumos", detalheAberto: { insumo: "Queijo" } });
    assert.deepEqual(ctx, { module: "ingredients", view: "insumo", ingredientName: "Queijo" });
  });
});

describe("derivarPageContext — Parser Food Delivery", () => {
  test("aba cancelamentos, com período -> view cancelamentos + year/month", () => {
    const ctx = derivarPageContext({ rota: "parser-food-delivery", contextoParser: { aba: "cancelamentos", ano: 2026, mes: 8 } });
    assert.deepEqual(ctx, { module: "parser_food_delivery", view: "cancelamentos", year: 2026, month: 8 });
  });

  test("outra aba (ex.: visão geral) -> view geral", () => {
    const ctx = derivarPageContext({ rota: "parser-food-delivery", contextoParser: { aba: "visao", ano: 2026, mes: 8 } });
    assert.equal(ctx.view, "geral");
  });

  test("pedido aberto -> orderNumber real, prevalece sobre a aba", () => {
    const ctx = derivarPageContext({
      rota: "parser-food-delivery",
      detalheAberto: { pedido: "5912" },
      contextoParser: { aba: "cancelamentos", ano: 2026, mes: 8 },
    });
    assert.deepEqual(ctx, { module: "parser_food_delivery", year: 2026, month: 8, view: "pedido", orderNumber: "5912" });
  });

  test("sem período conhecido -> sem year/month inventados", () => {
    const ctx = derivarPageContext({ rota: "parser-food-delivery", contextoParser: { aba: "visao", ano: null, mes: null } });
    assert.equal("year" in ctx, false);
    assert.equal("month" in ctx, false);
  });
});

describe("derivarPageContext — rota sem integração", () => {
  for (const rota of ["vendas", "bonificacao-mensal", "martinbrower", "configuracoes", "ia", "rota-que-nao-existe", undefined, ""]) {
    test(`rota "${rota}" -> null (contexto neutro), nunca inventa um módulo`, () => {
      assert.equal(derivarPageContext({ rota }), null);
    });
  }
});

describe("derivarPageContext — nunca contém tenant/identidade", () => {
  test("nenhum contexto gerado, em nenhum módulo, tem organizacaoId/unidadeId/userId/role", () => {
    const cenarios = [
      { rota: "dashboard-executivo", periodoDashboard: { ano: 2026, mes: 8 } },
      { rota: "produtos", detalheAberto: { produto: "BMT" } },
      { rota: "insumos", detalheAberto: { insumo: "Queijo" } },
      { rota: "parser-food-delivery", detalheAberto: { pedido: "1" }, contextoParser: { ano: 2026, mes: 8 } },
    ];
    const PROIBIDOS = ["organizacaoId", "unidadeId", "userId", "role", "permissoes", "permissions", "token"];
    for (const retrato of cenarios) {
      const ctx = derivarPageContext(retrato);
      for (const campo of PROIBIDOS) assert.equal(campo in ctx, false, `${retrato.rota}: ${campo}`);
    }
  });
});

describe("descreverContextoPainel", () => {
  test("null -> null (painel não mostra indicador)", () => {
    assert.equal(descreverContextoPainel(null), null);
  });

  test("Dashboard com período -> 'Analisando: Dashboard Executivo · Agosto/2026'", () => {
    const ctx = derivarPageContext({ rota: "dashboard-executivo", periodoDashboard: { ano: 2026, mes: 8 } });
    assert.equal(descreverContextoPainel(ctx), "Analisando: Dashboard Executivo · Agosto/2026");
  });

  test("Etapa H — attentionPoint -> 'Diagnosticando: Taxas de Entregadores · Agosto/2026'", () => {
    const ctx = derivarPageContext({
      rota: "dashboard-executivo", periodoDashboard: { ano: 2026, mes: 8 },
      detalheAberto: { attentionPoint: "taxas_entregadores" },
    });
    assert.equal(descreverContextoPainel(ctx), "Diagnosticando: Taxas de Entregadores · Agosto/2026");
  });

  test("produto aberto -> 'Contexto: BMT 15 cm'", () => {
    const ctx = derivarPageContext({ rota: "produtos", detalheAberto: { produto: "BMT 15 cm" } });
    assert.equal(descreverContextoPainel(ctx), "Contexto: BMT 15 cm");
  });

  test("insumo aberto -> 'Contexto: Queijo'", () => {
    const ctx = derivarPageContext({ rota: "insumos", detalheAberto: { insumo: "Queijo" } });
    assert.equal(descreverContextoPainel(ctx), "Contexto: Queijo");
  });

  test("Parser cancelamentos com período -> 'Contexto: Cancelamentos · Agosto/2026'", () => {
    const ctx = derivarPageContext({ rota: "parser-food-delivery", contextoParser: { aba: "cancelamentos", ano: 2026, mes: 8 } });
    assert.equal(descreverContextoPainel(ctx), "Contexto: Cancelamentos · Agosto/2026");
  });

  test("pedido aberto -> 'Contexto: Pedido #5912'", () => {
    const ctx = derivarPageContext({ rota: "parser-food-delivery", detalheAberto: { pedido: "5912" } });
    assert.equal(descreverContextoPainel(ctx), "Contexto: Pedido #5912");
  });

  test("nunca inclui ids técnicos, mesmo que existam no objeto (indicador só usa campos conhecidos)", () => {
    const texto = descreverContextoPainel({ module: "products_cmv", view: "lista", organizacaoId: "outro-tenant" });
    assert.equal(texto.includes("outro-tenant"), false);
  });
});

describe("ROTULO_MODULO", () => {
  test("cobre os 4 módulos com integração", () => {
    assert.deepEqual(Object.keys(ROTULO_MODULO).sort(), [
      "dashboard_executivo", "ingredients", "parser_food_delivery", "products_cmv",
    ]);
  });
});
