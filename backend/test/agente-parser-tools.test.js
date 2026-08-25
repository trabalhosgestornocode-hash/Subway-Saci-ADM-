// Testes das tools do Parser Food Delivery do Agente Crescer (Etapa D) —
// unit, sem rede/Supabase: todas as dependências são injetadas (ver `deps`
// em cada tool). A lógica de negócio em si (agregação mensal, desambiguação
// de pedido, explicação do cancelamento) já é testada em
// test/parser-food-delivery-calc.test.js (funções puras) — aqui o foco é a
// CAMADA DA TOOL: acesso, contexto de tenant, validação de input, e o
// contrato com o service.
//
// O que estes testes protegem, na ordem do pedido:
//   * organizacaoId/unidadeId vêm SEMPRE do contexto, nunca do input;
//   * módulo/permissão do Parser são exigidos mesmo com a rota /agente liberada;
//   * unidade obrigatória (o Parser não tem visão consolidada);
//   * mês/ano default pro atual quando omitidos, mesma resolução das demais tools;
//   * filtros inválidos (classificacao/nivelConfianca fora do enum) nunca quebram a consulta;
//   * nenhuma tool tem efeito de escrita.
//
// Rodar: node --env-file-if-exists=.env --test test/agente-parser-tools.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MODULOS } from "../src/shared/modulos.js";
import { PERMISSOES } from "../src/shared/permissoes.js";
import * as resumoTool from "../src/modules/agente/tools/parserResumo.tool.js";
import * as cancelamentosTool from "../src/modules/agente/tools/parserCancelamentos.tool.js";
import * as cancelamentoTool from "../src/modules/agente/tools/parserCancelamento.tool.js";

const ORG_ID = "33333333-3333-4333-8333-333333333333";
const UNIDADE_ID = "44444444-4444-4444-8444-444444444444";

const ACESSO_COM_MODULO = { modulos: [MODULOS.PARSER_FOOD_DELIVERY], permissoes: [PERMISSOES.PARSER_FD_VER], impersonando: false };
const ACESSO_SEM_MODULO = { modulos: [], permissoes: [PERMISSOES.PARSER_FD_VER], impersonando: false };
const ACESSO_SEM_PERMISSAO = { modulos: [MODULOS.PARSER_FOOD_DELIVERY], permissoes: [], impersonando: false };

describe("consultar_parser_resumo", () => {
  test("repassa organizacaoId/unidadeId do CONTEXTO e o período resolvido pro service", async () => {
    let chamadaCom = null;
    const deps = { resumoCancelamentosPeriodo: async (args) => { chamadaCom = args; return { periodo: { ano: 2026, mes: 8 } }; } };
    await resumoTool.executar({ ano: 2026, mes: 8 }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(chamadaCom.organizacaoId, ORG_ID);
    assert.equal(chamadaCom.unidadeId, UNIDADE_ID);
    assert.equal(chamadaCom.ano, 2026);
    assert.equal(chamadaCom.mes, 8);
  });

  test("mês/ano omitidos -> usa o mês atual (mesma resolução das demais tools)", async () => {
    let chamadaCom = null;
    const deps = { resumoCancelamentosPeriodo: async (args) => { chamadaCom = args; return {}; } };
    const agora = new Date();
    await resumoTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(chamadaCom.ano, agora.getFullYear());
  });

  test("mês inválido é rejeitado sem chamar o service", async () => {
    let chamou = false;
    const deps = { resumoCancelamentosPeriodo: async () => { chamou = true; return {}; } };
    await assert.rejects(
      () => resumoTool.executar({ mes: 13, ano: 2026 }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps),
      /Mês deve estar entre 1 e 12/,
    );
    assert.equal(chamou, false);
  });

  test("sem unidade selecionada: rejeita, sem chamar o service (Parser não tem visão consolidada)", async () => {
    let chamou = false;
    const deps = { resumoCancelamentosPeriodo: async () => { chamou = true; return {}; } };
    await assert.rejects(
      () => resumoTool.executar({}, { organizacaoId: ORG_ID, unidadeId: null, acesso: ACESSO_COM_MODULO }, deps),
      /Selecione uma unidade/,
    );
    assert.equal(chamou, false);
  });

  test("módulo Parser Food Delivery desabilitado: nega, sem chamar o service", async () => {
    let chamou = false;
    const deps = { resumoCancelamentosPeriodo: async () => { chamou = true; return {}; } };
    await assert.rejects(
      () => resumoTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_SEM_MODULO }, deps),
      /não contratado/,
    );
    assert.equal(chamou, false);
  });

  test("sem permissão parser_food_delivery.ver: nega, sem chamar o service", async () => {
    let chamou = false;
    const deps = { resumoCancelamentosPeriodo: async () => { chamou = true; return {}; } };
    await assert.rejects(
      () => resumoTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_SEM_PERMISSAO }, deps),
      /Permissão insuficiente/,
    );
    assert.equal(chamou, false);
  });
});

describe("listar_cancelamentos", () => {
  test("repassa ano/mes/classificacao/nivelConfianca/limite pro service", async () => {
    let chamadaCom = null;
    const deps = { listarCancelamentosPeriodo: async (args) => { chamadaCom = args; return { itens: [] }; } };
    await cancelamentosTool.executar(
      { ano: 2026, mes: 8, classificacao: "revisar", nivelConfianca: "inconclusiva", limite: 5 },
      { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO },
      deps,
    );
    assert.equal(chamadaCom.organizacaoId, ORG_ID);
    assert.equal(chamadaCom.unidadeId, UNIDADE_ID);
    assert.equal(chamadaCom.ano, 2026);
    assert.equal(chamadaCom.mes, 8);
    assert.equal(chamadaCom.classificacao, "revisar");
    assert.equal(chamadaCom.nivelConfianca, "inconclusiva");
    assert.equal(chamadaCom.limite, 5);
  });

  test("classificacao/nivelConfianca inválidos são ignorados (undefined), nunca quebram a consulta", async () => {
    let chamadaCom = null;
    const deps = { listarCancelamentosPeriodo: async (args) => { chamadaCom = args; return { itens: [] }; } };
    await cancelamentosTool.executar(
      { classificacao: "valor-inventado", nivelConfianca: "outro-valor-inventado" },
      { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO },
      deps,
    );
    assert.equal(chamadaCom.classificacao, undefined);
    assert.equal(chamadaCom.nivelConfianca, undefined);
  });

  test("sem filtro nenhum: classificacao/nivelConfianca ficam undefined (lista o mês inteiro)", async () => {
    let chamadaCom = null;
    const deps = { listarCancelamentosPeriodo: async (args) => { chamadaCom = args; return { itens: [] }; } };
    await cancelamentosTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(chamadaCom.classificacao, undefined);
    assert.equal(chamadaCom.nivelConfianca, undefined);
  });

  test("sem unidade selecionada: rejeita, sem chamar o service", async () => {
    let chamou = false;
    const deps = { listarCancelamentosPeriodo: async () => { chamou = true; return { itens: [] }; } };
    await assert.rejects(
      () => cancelamentosTool.executar({}, { organizacaoId: ORG_ID, unidadeId: null, acesso: ACESSO_COM_MODULO }, deps),
      /Selecione uma unidade/,
    );
    assert.equal(chamou, false);
  });

  test("módulo desabilitado: nega, sem chamar o service", async () => {
    let chamou = false;
    const deps = { listarCancelamentosPeriodo: async () => { chamou = true; return { itens: [] }; } };
    await assert.rejects(
      () => cancelamentosTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_SEM_MODULO }, deps),
      /não contratado/,
    );
    assert.equal(chamou, false);
  });
});

describe("consultar_cancelamento", () => {
  test("repassa numeroPedido/ano/mes pro service, organizacaoId/unidadeId do CONTEXTO", async () => {
    let chamadaCom = null;
    const deps = { consultarCancelamento: async (args) => { chamadaCom = args; return { encontrado: true }; } };
    await cancelamentoTool.executar(
      { numeroPedido: "123456", ano: 2026, mes: 8 },
      { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO },
      deps,
    );
    assert.equal(chamadaCom.organizacaoId, ORG_ID);
    assert.equal(chamadaCom.unidadeId, UNIDADE_ID);
    assert.equal(chamadaCom.numeroPedido, "123456");
    assert.equal(chamadaCom.ano, 2026);
    assert.equal(chamadaCom.mes, 8);
  });

  test("ano/mes omitidos: repassados como undefined (service decide sozinho, via candidatos)", async () => {
    let chamadaCom = null;
    const deps = { consultarCancelamento: async (args) => { chamadaCom = args; return { encontrado: true }; } };
    await cancelamentoTool.executar({ numeroPedido: "123456" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(chamadaCom.ano, undefined);
    assert.equal(chamadaCom.mes, undefined);
  });

  test("numeroPedido ausente: rejeita sem chamar o service", async () => {
    let chamou = false;
    const deps = { consultarCancelamento: async () => { chamou = true; return {}; } };
    await assert.rejects(() => cancelamentoTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps));
    assert.equal(chamou, false);
  });

  test("tenant correto: tentativa de injeção pelo input é ignorada", async () => {
    let chamadaCom = null;
    const deps = { consultarCancelamento: async (args) => { chamadaCom = args; return { encontrado: true }; } };
    await cancelamentoTool.executar(
      { numeroPedido: "1", organizacaoId: "org-de-outro-tenant", unidadeId: "outra-unidade" },
      { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO },
      deps,
    );
    assert.equal(chamadaCom.organizacaoId, ORG_ID);
    assert.equal(chamadaCom.unidadeId, UNIDADE_ID);
  });

  test("sem unidade selecionada: rejeita, sem chamar o service", async () => {
    let chamou = false;
    const deps = { consultarCancelamento: async () => { chamou = true; return {}; } };
    await assert.rejects(
      () => cancelamentoTool.executar({ numeroPedido: "1" }, { organizacaoId: ORG_ID, unidadeId: null, acesso: ACESSO_COM_MODULO }, deps),
      /Selecione uma unidade/,
    );
    assert.equal(chamou, false);
  });

  test("módulo desabilitado: nega, sem chamar o service", async () => {
    let chamou = false;
    const deps = { consultarCancelamento: async () => { chamou = true; return {}; } };
    await assert.rejects(
      () => cancelamentoTool.executar({ numeroPedido: "1" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_SEM_MODULO }, deps),
      /não contratado/,
    );
    assert.equal(chamou, false);
  });

  test("sem permissão: nega, sem chamar o service", async () => {
    let chamou = false;
    const deps = { consultarCancelamento: async () => { chamou = true; return {}; } };
    await assert.rejects(
      () => cancelamentoTool.executar({ numeroPedido: "1" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_SEM_PERMISSAO }, deps),
      /Permissão insuficiente/,
    );
    assert.equal(chamou, false);
  });
});
