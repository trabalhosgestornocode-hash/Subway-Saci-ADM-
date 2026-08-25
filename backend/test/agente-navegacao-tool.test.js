// Testes da tool "sugerir_navegacao" (Etapa F.1) — unit, sem rede/Supabase
// (a tool não toca I/O algum, só delega pra agente.acoes.js#resolverAcao,
// já testado exaustivamente em agente-acoes.test.js).
//
// O que estes testes protegem: o CONTRATO da tool (input_schema, formato do
// retorno) e que ela nunca lança — mesmo com input malicioso, o pior
// resultado é `{ sugerida: false }`.
//
// Rodar: node --env-file-if-exists=.env --test test/agente-navegacao-tool.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MODULOS } from "../src/shared/modulos.js";
import { PERMISSOES } from "../src/shared/permissoes.js";
import * as navegacaoTool from "../src/modules/agente/tools/navegacao.tool.js";

const ACESSO_COMPLETO = {
  modulos: [MODULOS.PARSER_FOOD_DELIVERY, MODULOS.PRODUTOS_CMV],
  permissoes: [PERMISSOES.PARSER_FD_VER, PERMISSOES.CMV_VER],
  impersonando: false,
};
const ACESSO_VAZIO = { modulos: [], permissoes: [], impersonando: false };

describe("definicao (contrato da tool)", () => {
  test("schema recusa propriedades fora da lista (additionalProperties: false)", () => {
    assert.equal(navegacaoTool.definicao.input_schema.additionalProperties, false);
  });

  test("target é um enum fechado — Claude não pode mandar string livre", () => {
    const propTarget = navegacaoTool.definicao.input_schema.properties.target;
    assert.ok(Array.isArray(propTarget.enum) && propTarget.enum.length > 0);
  });

  test("target é obrigatório", () => {
    assert.ok(navegacaoTool.definicao.input_schema.required.includes("target"));
  });
});

describe("executar", () => {
  test("target válido + acesso -> { sugerida: true, action }", async () => {
    const r = await navegacaoTool.executar({ target: "parser_cancelamentos" }, { acesso: ACESSO_COMPLETO });
    assert.equal(r.sugerida, true);
    assert.equal(r.action.target, "parser_cancelamentos");
    assert.equal(r.action.type, "navigate");
  });

  test("target válido, produto informado -> action com productName e label com o nome", async () => {
    const r = await navegacaoTool.executar({ target: "product_detail", productName: "BMT 15cm" }, { acesso: ACESSO_COMPLETO });
    assert.equal(r.sugerida, true);
    assert.equal(r.action.params.productName, "BMT 15cm");
    assert.match(r.action.label, /BMT 15cm/);
  });

  test("sem acesso ao destino -> { sugerida: false }, nunca lança", async () => {
    const r = await navegacaoTool.executar({ target: "parser_cancelamentos" }, { acesso: ACESSO_VAZIO });
    assert.deepEqual(r, { sugerida: false });
  });

  test("target inválido/inventado -> { sugerida: false }, nunca lança", async () => {
    const r = await navegacaoTool.executar({ target: "rota-inventada" }, { acesso: ACESSO_COMPLETO });
    assert.deepEqual(r, { sugerida: false });
  });

  test("target ausente -> { sugerida: false }, nunca lança", async () => {
    const r = await navegacaoTool.executar({}, { acesso: ACESSO_COMPLETO });
    assert.deepEqual(r, { sugerida: false });
  });

  test("target que exige parâmetro, sem o parâmetro -> { sugerida: false }", async () => {
    const r = await navegacaoTool.executar({ target: "product_detail" }, { acesso: ACESSO_COMPLETO });
    assert.deepEqual(r, { sugerida: false });
  });

  test("input malicioso (tenta injetar organizacaoId) nunca aparece na action", async () => {
    const r = await navegacaoTool.executar(
      { target: "product_detail", productName: "BMT", organizacaoId: "outro-tenant" },
      { acesso: ACESSO_COMPLETO },
    );
    assert.equal(r.sugerida, true);
    assert.equal("organizacaoId" in r.action.params, false);
  });
});
