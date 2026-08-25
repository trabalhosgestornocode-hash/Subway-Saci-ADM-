// Testes do Action Registry de navegação do Agente Crescer (Etapa F.1) —
// unit, puro (sem I/O). `resolverAcao` é a ÚNICA porta de saída de uma
// sugestão de navegação — testar exaustivamente aqui cobre a tool
// (navegacao.tool.js) e o loop (agente.service.js) por baixo.
//
// O que estes testes protegem, na ordem do pedido:
//   * target válido / inválido;
//   * parâmetros permitidos / proibidos (por target, nunca misturados);
//   * módulo sem acesso / permissão ausente -> nunca sugere;
//   * impersonação bypassa, mesmo padrão do resto do sistema;
//   * segurança: URL/rota livre como target, injeção de tenant nos params.
//
// Rodar: node --env-file-if-exists=.env --test test/agente-acoes.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MODULOS } from "../src/shared/modulos.js";
import { PERMISSOES } from "../src/shared/permissoes.js";
import { ACOES_NAVEGACAO, TARGETS_VALIDOS, resolverAcao } from "../src/modules/agente/agente.acoes.js";

const ACESSO_COMPLETO = {
  modulos: [MODULOS.IFOOD_DASHBOARD, MODULOS.PRODUTOS_CMV, MODULOS.INGREDIENTS, MODULOS.PARSER_FOOD_DELIVERY],
  permissoes: [PERMISSOES.DASHBOARD_EXECUTIVO_VER, PERMISSOES.CMV_VER, PERMISSOES.INSUMOS_VER, PERMISSOES.PARSER_FD_VER],
  impersonando: false,
};
const ACESSO_VAZIO = { modulos: [], permissoes: [], impersonando: false };
const ACESSO_IMPERSONANDO = { modulos: [], permissoes: [], impersonando: true };

describe("ACOES_NAVEGACAO — catálogo", () => {
  test("expõe exatamente os 8 targets do pedido", () => {
    assert.deepEqual([...TARGETS_VALIDOS].sort(), [
      "dashboard_executivo", "ingredient_detail", "ingredients", "parser",
      "parser_cancelamentos", "parser_order", "product_detail", "products_cmv",
    ]);
  });

  test("todo target declara módulo, permissão e rótulo — nenhum vazio", () => {
    for (const [target, def] of Object.entries(ACOES_NAVEGACAO)) {
      assert.ok(def.modulo, target);
      assert.ok(def.permissao, target);
      assert.equal(typeof def.rotulo, "function", target);
      assert.ok(Array.isArray(def.paramsPermitidos), target);
      assert.ok(Array.isArray(def.paramsObrigatorios), target);
    }
  });
});

describe("resolverAcao — target", () => {
  test("target válido, com acesso -> resolve", () => {
    const acao = resolverAcao({ target: "dashboard_executivo", acesso: ACESSO_COMPLETO });
    assert.deepEqual(acao, { type: "navigate", target: "dashboard_executivo", label: "Abrir Dashboard Executivo", params: {} });
  });

  test("target inexistente -> null, nunca lança", () => {
    assert.equal(resolverAcao({ target: "target_que_nao_existe", acesso: ACESSO_COMPLETO }), null);
  });

  test("target ausente/undefined -> null", () => {
    assert.equal(resolverAcao({ acesso: ACESSO_COMPLETO }), null);
  });

  test("todos os 8 targets resolvem com acesso completo e params válidos", () => {
    const casos = [
      ["dashboard_executivo", {}], ["products_cmv", {}], ["ingredients", {}], ["parser", {}], ["parser_cancelamentos", {}],
      ["product_detail", { productName: "BMT 15cm" }],
      ["ingredient_detail", { ingredientName: "Queijo" }],
      ["parser_order", { orderNumber: "5912" }],
    ];
    for (const [target, params] of casos) {
      const acao = resolverAcao({ target, params, acesso: ACESSO_COMPLETO });
      assert.ok(acao, target);
      assert.equal(acao.target, target);
      assert.ok(acao.label.length > 0, target);
    }
  });
});

describe("resolverAcao — módulo/permissão", () => {
  test("sem o módulo do destino -> null, nunca sugere", () => {
    assert.equal(resolverAcao({ target: "parser_cancelamentos", acesso: ACESSO_VAZIO }), null);
  });

  test("com o módulo mas sem a permissão -> null", () => {
    const acesso = { modulos: [MODULOS.PARSER_FOOD_DELIVERY], permissoes: [], impersonando: false };
    assert.equal(resolverAcao({ target: "parser_cancelamentos", acesso }), null);
  });

  test("acesso ausente (undefined) -> null, nunca lança", () => {
    assert.equal(resolverAcao({ target: "dashboard_executivo", acesso: undefined }), null);
  });

  test("impersonando -> bypassa módulo/permissão, mesmo padrão de agenteAcesso.js", () => {
    const acao = resolverAcao({ target: "parser_cancelamentos", acesso: ACESSO_IMPERSONANDO });
    assert.ok(acao);
    assert.equal(acao.target, "parser_cancelamentos");
  });

  test("cada módulo dá acesso SÓ aos seus próprios targets, nunca aos de outro módulo", () => {
    const acesso = { modulos: [MODULOS.PRODUTOS_CMV], permissoes: [PERMISSOES.CMV_VER], impersonando: false };
    assert.ok(resolverAcao({ target: "products_cmv", acesso }));
    assert.ok(resolverAcao({ target: "product_detail", params: { productName: "BMT" }, acesso }));
    assert.equal(resolverAcao({ target: "ingredients", acesso }), null);
    assert.equal(resolverAcao({ target: "parser_cancelamentos", acesso }), null);
  });
});

describe("resolverAcao — parâmetros", () => {
  test("product_detail SEM productName (obrigatório ausente) -> null", () => {
    assert.equal(resolverAcao({ target: "product_detail", params: {}, acesso: ACESSO_COMPLETO }), null);
  });

  test("product_detail com productName vazio/só espaço -> null (mesma regra de obrigatório ausente)", () => {
    assert.equal(resolverAcao({ target: "product_detail", params: { productName: "   " }, acesso: ACESSO_COMPLETO }), null);
  });

  test("parâmetro de OUTRO target é descartado, nunca misturado", () => {
    const acao = resolverAcao({
      target: "product_detail",
      params: { productName: "BMT 15cm", orderNumber: "5912", ingredientName: "Queijo" },
      acesso: ACESSO_COMPLETO,
    });
    assert.deepEqual(acao.params, { productName: "BMT 15cm" });
  });

  test("target sem parâmetros (ex.: products_cmv) ignora qualquer params mandado", () => {
    const acao = resolverAcao({ target: "products_cmv", params: { productName: "BMT" }, acesso: ACESSO_COMPLETO });
    assert.deepEqual(acao.params, {});
  });

  test("productName absurdamente longo -> truncado, nunca rejeita a ação inteira", () => {
    const acao = resolverAcao({ target: "product_detail", params: { productName: "x".repeat(500) }, acesso: ACESSO_COMPLETO });
    assert.equal(acao.params.productName.length, 120);
  });

  test("label do botão é SEMPRE do registry (nunca aceita um label vindo de fora)", () => {
    const acao = resolverAcao({
      target: "product_detail",
      params: { productName: "BMT 15cm", label: "Clique aqui pra ganhar um prêmio" },
      acesso: ACESSO_COMPLETO,
    });
    assert.equal(acao.label, "Abrir BMT 15cm");
  });
});

describe("resolverAcao — segurança", () => {
  test("target = URL javascript: -> null (não existe no catálogo, nunca vira action)", () => {
    assert.equal(resolverAcao({ target: "javascript:alert(1)", acesso: ACESSO_COMPLETO }), null);
  });

  test("target = URL externa -> null", () => {
    assert.equal(resolverAcao({ target: "https://evil.example.com", acesso: ACESSO_COMPLETO }), null);
  });

  test("target = rota inventada -> null", () => {
    assert.equal(resolverAcao({ target: "/admin/excluir-tudo", acesso: ACESSO_COMPLETO }), null);
  });

  test("organizacaoId/unidadeId/userId nos params são descartados (nunca chegam em action.params)", () => {
    const acao = resolverAcao({
      target: "product_detail",
      params: { productName: "BMT 15cm", organizacaoId: "outro-tenant", unidadeId: "outra-unidade", userId: "outro-usuario", role: "organization_admin" },
      acesso: ACESSO_COMPLETO,
    });
    assert.deepEqual(acao.params, { productName: "BMT 15cm" });
  });

  test("action nunca contém campo 'url' ou 'href' — só type/target/label/params", () => {
    const acao = resolverAcao({ target: "dashboard_executivo", acesso: ACESSO_COMPLETO });
    assert.deepEqual(Object.keys(acao).sort(), ["label", "params", "target", "type"]);
  });
});
