// Testes do PAGE CONTEXT do Agente Crescer — unit, puro (sem I/O).
//
// O que estes testes protegem, na ordem do pedido:
//   * entrada não confiável (objeto qualquer vindo do frontend) só sobrevive
//     através de uma lista branca de campos;
//   * nenhuma chave que pareça tenant/identidade/permissão (organizacaoId,
//     unidadeId, userId, role, permissoes...) passa, mesmo que venha junto
//     de um `module` válido;
//   * `module` fora do catálogo conhecido -> sem contexto (null), nunca erro;
//   * entrada malformada (não-objeto, array, tipos errados) -> null, nunca lança;
//   * campos fora de faixa (ano/mês/view com caracteres inválidos) são
//     descartados individualmente, sem derrubar o resto do contexto;
//   * o campo de "nome aberto" (productName/ingredientName/orderNumber) só é
//     aceito no módulo correspondente — nunca misturado;
//   * `descreverPageContext` só usa o que já foi sanitizado.
//
// Rodar: node --env-file-if-exists=.env --test test/agente-pageContext.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { sanitizarPageContext, descreverPageContext, PAGINAS_CONHECIDAS, ATTENTION_POINTS_CONHECIDOS } from "../src/modules/agente/agente.pageContext.js";

describe("sanitizarPageContext — entrada malformada", () => {
  for (const bruto of [null, undefined, "string", 42, true, [], ["module", "dashboard_executivo"]]) {
    test(`${JSON.stringify(bruto)} -> null, sem lançar`, () => {
      assert.equal(sanitizarPageContext(bruto), null);
    });
  }

  test("objeto vazio -> null (sem module)", () => {
    assert.equal(sanitizarPageContext({}), null);
  });

  test("module ausente -> null", () => {
    assert.equal(sanitizarPageContext({ view: "mes", year: 2026 }), null);
  });

  test("module desconhecido -> null (nunca inventa uma página)", () => {
    assert.equal(sanitizarPageContext({ module: "modulo-que-nao-existe" }), null);
  });

  test("module de um recurso não elegível (Etapa E: vendas/bonificação/martin_brower) -> null", () => {
    for (const modulo of ["vendas", "sales", "monthly_bonus", "bonificacao_mensal", "martin_brower", "dashboard"]) {
      assert.equal(sanitizarPageContext({ module: modulo }), null, modulo);
    }
  });

  test("module com tipo errado (número) -> null", () => {
    assert.equal(sanitizarPageContext({ module: 123 }), null);
  });
});

describe("sanitizarPageContext — caminho feliz", () => {
  test("module sozinho -> contexto mínimo com rótulo", () => {
    const ctx = sanitizarPageContext({ module: "dashboard_executivo" });
    assert.deepEqual(ctx, { module: "dashboard_executivo", rotulo: "Dashboard Executivo" });
  });

  test("Dashboard Executivo: module + view + year + month válidos -> todos presentes", () => {
    const ctx = sanitizarPageContext({ module: "dashboard_executivo", view: "mes", year: 2026, month: 8 });
    assert.equal(ctx.module, "dashboard_executivo");
    assert.equal(ctx.view, "mes");
    assert.equal(ctx.year, 2026);
    assert.equal(ctx.month, 8);
  });

  test("Produtos/CMV: productName trim aplicado", () => {
    const ctx = sanitizarPageContext({ module: "products_cmv", view: "produto", productName: "  BMT 15cm  " });
    assert.equal(ctx.productName, "BMT 15cm");
    assert.equal(ctx.view, "produto");
  });

  test("Insumos: ingredientName trim aplicado", () => {
    const ctx = sanitizarPageContext({ module: "ingredients", view: "insumo", ingredientName: "  Queijo  " });
    assert.equal(ctx.ingredientName, "Queijo");
  });

  test("Parser: orderNumber + year/month", () => {
    const ctx = sanitizarPageContext({ module: "parser_food_delivery", view: "pedido", orderNumber: "5912", year: 2026, month: 8 });
    assert.equal(ctx.orderNumber, "5912");
    assert.equal(ctx.year, 2026);
    assert.equal(ctx.month, 8);
  });

  test("Produtos/CMV: channel/viewedTable/comparisonMode (modo oficial) são aceitos", () => {
    const ctx = sanitizarPageContext({ module: "products_cmv", channel: "balcao", viewedTable: "E", comparisonMode: false });
    assert.equal(ctx.channel, "balcao");
    assert.equal(ctx.viewedTable, "E");
    assert.equal(ctx.comparisonMode, false);
  });

  test("Produtos/CMV: modo comparação true é aceito", () => {
    const ctx = sanitizarPageContext({ module: "products_cmv", channel: "ifood", viewedTable: "A", comparisonMode: true });
    assert.equal(ctx.comparisonMode, true);
    assert.equal(ctx.viewedTable, "A");
  });

  test("Produtos/CMV: officialTable vindo do frontend NUNCA é aceito — backend sempre resolve sozinho", () => {
    const ctx = sanitizarPageContext({ module: "products_cmv", channel: "balcao", viewedTable: "A", officialTable: "Z9" });
    assert.equal("officialTable" in ctx, false);
  });

  test("Produtos/CMV: channel fora do enum é descartado", () => {
    const ctx = sanitizarPageContext({ module: "products_cmv", channel: "uber", viewedTable: "A" });
    assert.equal("channel" in ctx, false);
  });

  test("channel/viewedTable mandados em módulo diferente de products_cmv são ignorados", () => {
    const ctx = sanitizarPageContext({ module: "ingredients", channel: "balcao", viewedTable: "A" });
    assert.equal("channel" in ctx, false);
    assert.equal("viewedTable" in ctx, false);
  });

  test("nome vazio após trim -> campo omitido, resto do contexto sobrevive", () => {
    const ctx = sanitizarPageContext({ module: "products_cmv", productName: "   " });
    assert.equal("productName" in ctx, false);
    assert.equal(ctx.module, "products_cmv");
  });

  test("nome absurdamente longo -> truncado em 120 caracteres", () => {
    const longo = "x".repeat(500);
    const ctx = sanitizarPageContext({ module: "products_cmv", productName: longo });
    assert.equal(ctx.productName.length, 120);
  });

  test("todas as páginas do catálogo resolvem para um rótulo não vazio", () => {
    for (const modulo of Object.keys(PAGINAS_CONHECIDAS)) {
      const ctx = sanitizarPageContext({ module: modulo });
      assert.ok(ctx.rotulo?.length > 0, modulo);
    }
  });

  test("catálogo tem exatamente os 4 módulos com tool (Etapa E não adicionou vendas/bonificação/martin brower)", () => {
    assert.deepEqual(Object.keys(PAGINAS_CONHECIDAS).sort(), [
      "dashboard_executivo", "ingredients", "parser_food_delivery", "products_cmv",
    ]);
  });
});

describe("sanitizarPageContext — campo de 'nome aberto' só vale para o módulo certo", () => {
  test("productName mandado num module diferente de products_cmv é ignorado", () => {
    const ctx = sanitizarPageContext({ module: "ingredients", productName: "BMT" });
    assert.equal("productName" in ctx, false);
  });
  test("ingredientName mandado em products_cmv é ignorado", () => {
    const ctx = sanitizarPageContext({ module: "products_cmv", ingredientName: "Queijo" });
    assert.equal("ingredientName" in ctx, false);
  });
  test("orderNumber mandado em dashboard_executivo é ignorado", () => {
    const ctx = sanitizarPageContext({ module: "dashboard_executivo", orderNumber: "123" });
    assert.equal("orderNumber" in ctx, false);
  });
});

describe("sanitizarPageContext — campos fora de faixa (descartados, não rejeitam o contexto inteiro)", () => {
  test("year fora de 2000-2100 -> omitido", () => {
    const ctx = sanitizarPageContext({ module: "dashboard_executivo", year: 1500 });
    assert.equal("year" in ctx, false);
  });

  test("year não-inteiro -> omitido", () => {
    const ctx = sanitizarPageContext({ module: "dashboard_executivo", year: 2026.5 });
    assert.equal("year" in ctx, false);
  });

  test("month fora de 1-12 -> omitido", () => {
    const ctx = sanitizarPageContext({ module: "dashboard_executivo", month: 13 });
    assert.equal("month" in ctx, false);
  });

  test("month 0 -> omitido", () => {
    const ctx = sanitizarPageContext({ module: "dashboard_executivo", month: 0 });
    assert.equal("month" in ctx, false);
  });

  test("view com espaço/caractere especial -> omitido (só token simples é aceito)", () => {
    const ctx = sanitizarPageContext({ module: "dashboard_executivo", view: "algo; DROP TABLE" });
    assert.equal("view" in ctx, false);
  });

  test("view com token simples válido (hífen/underscore) -> aceito", () => {
    const ctx = sanitizarPageContext({ module: "dashboard_executivo", view: "visao_geral-2" });
    assert.equal(ctx.view, "visao_geral-2");
  });
});

describe("sanitizarPageContext — NUNCA deixa passar campo de tenant/identidade/permissão", () => {
  const TENTATIVAS_MALICIOSAS = {
    module: "dashboard_executivo",
    organizacaoId: "org-de-outro-tenant",
    organizacao_id: "org-de-outro-tenant",
    unidadeId: "unidade-de-outro-tenant",
    unidade_id: "unidade-de-outro-tenant",
    userId: "outro-usuario",
    usuarioId: "outro-usuario",
    role: "organization_admin",
    papel: "organization_admin",
    permissoes: ["dashboard_executivo.excluir"],
    permissions: ["dashboard_executivo.excluir"],
    sessionId: "sid-forjado",
    token: "token-forjado",
  };

  test("nenhuma das chaves maliciosas sobrevive, mesmo junto de um module válido", () => {
    const ctx = sanitizarPageContext(TENTATIVAS_MALICIOSAS);
    assert.ok(ctx, "contexto deveria existir (module é válido)");
    for (const chave of Object.keys(TENTATIVAS_MALICIOSAS)) {
      if (chave === "module") continue;
      assert.equal(chave in ctx, false, `campo "${chave}" não deveria sobreviver à sanitização`);
    }
    // Só os campos da lista branca podem estar presentes.
    const CAMPOS_PERMITIDOS = new Set(["module", "rotulo", "view", "year", "month", "productName", "ingredientName", "orderNumber"]);
    for (const chave of Object.keys(ctx)) assert.ok(CAMPOS_PERMITIDOS.has(chave), `campo inesperado: ${chave}`);
  });

  test("chave maliciosa disfarçada de campo válido (ex.: 'productName' contendo um id) ainda é só texto — nunca interpretada como id", () => {
    const ctx = sanitizarPageContext({ module: "products_cmv", productName: "'; DROP TABLE produtos; --" });
    assert.equal(typeof ctx.productName, "string");
    assert.equal(Object.keys(ctx).includes("id"), false);
  });
});

describe("descreverPageContext", () => {
  test("null -> null", () => {
    assert.equal(descreverPageContext(null), null);
  });

  test("só module -> uma frase com o rótulo", () => {
    const ctx = sanitizarPageContext({ module: "ingredients" });
    assert.equal(descreverPageContext(ctx), "Página atual: Insumos.");
  });

  test("Dashboard Executivo com year+month -> inclui o período formatado", () => {
    const ctx = sanitizarPageContext({ module: "dashboard_executivo", year: 2026, month: 8 });
    const texto = descreverPageContext(ctx);
    assert.ok(texto.includes("Página atual: Dashboard Executivo."));
    assert.ok(texto.includes("08/2026"));
  });

  test("Produtos/CMV com productName -> nome entre aspas", () => {
    const ctx = sanitizarPageContext({ module: "products_cmv", productName: "BMT 15cm" });
    assert.ok(descreverPageContext(ctx).includes('"BMT 15cm"'));
  });

  test("Insumos com ingredientName -> nome entre aspas", () => {
    const ctx = sanitizarPageContext({ module: "ingredients", ingredientName: "Queijo Cheddar" });
    assert.ok(descreverPageContext(ctx).includes('"Queijo Cheddar"'));
  });

  test("Parser com orderNumber -> menciona o número e orienta a chamar consultar_cancelamento", () => {
    const ctx = sanitizarPageContext({ module: "parser_food_delivery", orderNumber: "5912" });
    const texto = descreverPageContext(ctx);
    assert.ok(texto.includes('"5912"'));
    assert.ok(/consultar_cancelamento/.test(texto));
  });

  test("Produtos/CMV em modo comparação -> avisa explicitamente que NÃO é a tabela oficial", () => {
    const ctx = sanitizarPageContext({ module: "products_cmv", channel: "balcao", viewedTable: "A", comparisonMode: true });
    const texto = descreverPageContext(ctx);
    assert.ok(/MODO DE COMPARAÇÃO/.test(texto));
    assert.ok(texto.includes("Tabela A"));
    assert.ok(/NÃO é a tabela oficial/.test(texto));
  });

  test("Produtos/CMV fora do modo comparação -> descreve como tabela oficial, sem alerta de comparação", () => {
    const ctx = sanitizarPageContext({ module: "products_cmv", channel: "ifood", viewedTable: "Z4", comparisonMode: false });
    const texto = descreverPageContext(ctx);
    assert.ok(texto.includes("iFood"));
    assert.ok(texto.includes("Tabela Z4"));
    assert.ok(/tabela oficial da unidade/.test(texto));
    assert.equal(/MODO DE COMPARAÇÃO/.test(texto), false);
  });

  test("nunca inclui texto fora do que o contexto sanitizado carrega", () => {
    const ctx = sanitizarPageContext({ module: "products_cmv", productName: "BMT", organizacaoId: "outro-tenant" });
    assert.equal(descreverPageContext(ctx).includes("outro-tenant"), false);
  });

  test("Dashboard Executivo com attentionPoint -> orienta a consultar_diagnostico, nunca assume o valor", () => {
    const ctx = sanitizarPageContext({ module: "dashboard_executivo", attentionPoint: "taxas_entregadores" });
    const texto = descreverPageContext(ctx);
    assert.ok(/Taxas de Entregadores/.test(texto));
    assert.ok(/consultar_diagnostico/.test(texto));
  });
});

// ---------------------------------------------------------------------------
// Etapa H — attentionPoint (Diagnóstico Investigativo). Mesmo espírito das
// demais listas brancas por módulo (productName/ingredientName/orderNumber):
// só o campo do módulo certo, só valores de um catálogo fechado.
// ---------------------------------------------------------------------------
describe("sanitizarPageContext — attentionPoint (Etapa H)", () => {
  test("catálogo tem exatamente os achados reais do motor de diagnóstico hoje", () => {
    assert.deepEqual([...ATTENTION_POINTS_CONHECIDOS].sort(), [
      "detalhamento_financeiro_ausente", "dias_pendentes", "faturamento",
      "servicos_promocoes", "taxas_comissoes", "taxas_entregadores", "total_deducoes",
    ]);
  });

  test("cmv e cancelamentos NUNCA entram no catálogo — não são achados determinísticos em nenhum motor hoje", () => {
    assert.equal(ATTENTION_POINTS_CONHECIDOS.includes("cmv"), false);
    assert.equal(ATTENTION_POINTS_CONHECIDOS.includes("cancelamentos"), false);
  });

  test("attentionPoint válido, em dashboard_executivo -> aceito", () => {
    const ctx = sanitizarPageContext({ module: "dashboard_executivo", attentionPoint: "faturamento" });
    assert.equal(ctx.attentionPoint, "faturamento");
  });

  test("attentionPoint fora do catálogo -> omitido, resto do contexto sobrevive", () => {
    const ctx = sanitizarPageContext({ module: "dashboard_executivo", attentionPoint: "cmv" });
    assert.equal("attentionPoint" in ctx, false);
    assert.equal(ctx.module, "dashboard_executivo");
  });

  test("attentionPoint mandado em módulo diferente de dashboard_executivo é ignorado", () => {
    const ctx = sanitizarPageContext({ module: "products_cmv", attentionPoint: "taxas_entregadores" });
    assert.equal("attentionPoint" in ctx, false);
  });

  test("attentionPoint com tipo errado (não-string) -> omitido, nunca lança", () => {
    const ctx = sanitizarPageContext({ module: "dashboard_executivo", attentionPoint: 123 });
    assert.equal("attentionPoint" in ctx, false);
  });

  test("attentionPoint = texto livre/injeção -> nunca aceito (só o catálogo fechado)", () => {
    const ctx = sanitizarPageContext({ module: "dashboard_executivo", attentionPoint: "'; DROP TABLE x; --" });
    assert.equal("attentionPoint" in ctx, false);
  });

  test("todos os pontos do catálogo resolvem para um rótulo no texto descritivo", () => {
    for (const ponto of ATTENTION_POINTS_CONHECIDOS) {
      const ctx = sanitizarPageContext({ module: "dashboard_executivo", attentionPoint: ponto });
      const texto = descreverPageContext(ctx);
      assert.ok(texto.includes("ponto de atenção"), ponto);
    }
  });
});
