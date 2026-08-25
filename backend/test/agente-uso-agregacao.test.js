// Testes das funções de agregação de agente.uso.service.js — puras (operam
// sobre linhas já buscadas), sem rede/banco. A leitura em si
// (buscarUsoNoPeriodo) é I/O e não é testada aqui — mesmo padrão do resto
// do projeto (calc puro tem teste unitário; o SELECT em si é validado pelos
// testes de integração quando a migration está aplicada).
//
// Rodar: node --test test/agente-uso-agregacao.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { intervaloDoFiltro, agregarResumo, agregarPorOrganizacao, agregarPorModelo } from "../src/modules/agente/agente.uso.service.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USUARIO_1 = "33333333-3333-4333-8333-333333333333";
const USUARIO_2 = "44444444-4444-4444-8444-444444444444";
const UNIDADE_X = "55555555-5555-4555-8555-555555555555";
const UNIDADE_Y = "66666666-6666-4666-8666-666666666666";

const linha = (p = {}) => ({
  organizacao_id: ORG_A, unidade_id: UNIDADE_X, usuario_id: USUARIO_1, model: "claude-opus-5",
  input_tokens: 1000, output_tokens: 200, cache_creation_tokens: 0, cache_read_tokens: 0,
  estimated_cost_usd: 0.01, success: true, created_at: new Date().toISOString(),
  ...p,
});

describe("agregarResumo", () => {
  test("soma interações, tokens e custo; calcula custo médio", () => {
    const linhas = [linha({ estimated_cost_usd: 0.01 }), linha({ estimated_cost_usd: 0.02 }), linha({ estimated_cost_usd: 0.03 })];
    const r = agregarResumo(linhas);
    assert.equal(r.interacoes, 3);
    assert.equal(r.inputTokens, 3000);
    assert.equal(r.outputTokens, 600);
    assert.ok(Math.abs(r.custoEstimadoUsd - 0.06) < 1e-9);
    assert.ok(Math.abs(r.custoMedioUsd - 0.02) < 1e-9);
  });

  test("sem linhas: interações 0, custo médio null (não 0/0)", () => {
    const r = agregarResumo([]);
    assert.equal(r.interacoes, 0);
    assert.equal(r.custoEstimadoUsd, 0);
    assert.equal(r.custoMedioUsd, null);
  });

  test("linha com custo null (modelo sem preço) não quebra a soma nem vira NaN", () => {
    const linhas = [linha({ estimated_cost_usd: 0.01 }), linha({ estimated_cost_usd: null })];
    const r = agregarResumo(linhas);
    assert.ok(Math.abs(r.custoEstimadoUsd - 0.01) < 1e-9);
    assert.ok(Number.isFinite(r.custoMedioUsd));
  });

  test("conta falhas separadamente", () => {
    const linhas = [linha({ success: true }), linha({ success: false }), linha({ success: false })];
    assert.equal(agregarResumo(linhas).falhas, 2);
  });
});

describe("agregarPorOrganizacao", () => {
  test("agrupa por organização, soma tokens/custo, conta usuários/unidades DISTINTOS", () => {
    const linhas = [
      linha({ organizacao_id: ORG_A, usuario_id: USUARIO_1, unidade_id: UNIDADE_X, estimated_cost_usd: 0.01 }),
      linha({ organizacao_id: ORG_A, usuario_id: USUARIO_1, unidade_id: UNIDADE_X, estimated_cost_usd: 0.01 }), // mesmo usuário/unidade de novo
      linha({ organizacao_id: ORG_A, usuario_id: USUARIO_2, unidade_id: UNIDADE_Y, estimated_cost_usd: 0.02 }),
      linha({ organizacao_id: ORG_B, usuario_id: USUARIO_1, unidade_id: UNIDADE_X, estimated_cost_usd: 0.05 }),
    ];
    const r = agregarPorOrganizacao(linhas);
    const orgA = r.find((o) => o.organizacaoId === ORG_A);
    const orgB = r.find((o) => o.organizacaoId === ORG_B);

    assert.equal(orgA.interacoes, 3);
    assert.equal(orgA.usuariosAtivos, 2); // USUARIO_1 (2x) + USUARIO_2, mas só 2 distintos
    assert.equal(orgA.unidadesAtivas, 2); // UNIDADE_X + UNIDADE_Y
    assert.ok(Math.abs(orgA.custoEstimadoUsd - 0.04) < 1e-9);

    assert.equal(orgB.interacoes, 1);
    assert.ok(Math.abs(orgB.custoEstimadoUsd - 0.05) < 1e-9);
  });

  test("ordenado por custo desc (organização mais cara primeiro)", () => {
    const linhas = [
      linha({ organizacao_id: ORG_A, estimated_cost_usd: 0.01 }),
      linha({ organizacao_id: ORG_B, estimated_cost_usd: 0.50 }),
    ];
    const r = agregarPorOrganizacao(linhas);
    assert.equal(r[0].organizacaoId, ORG_B);
  });
});

describe("agregarPorModelo", () => {
  test("agrupa por modelo, soma interações/tokens/custo", () => {
    const linhas = [
      linha({ model: "claude-opus-5", estimated_cost_usd: 0.10 }),
      linha({ model: "claude-opus-5", estimated_cost_usd: 0.10 }),
      linha({ model: "claude-haiku-4-5", estimated_cost_usd: 0.01 }),
    ];
    const r = agregarPorModelo(linhas);
    const opus = r.find((m) => m.model === "claude-opus-5");
    const haiku = r.find((m) => m.model === "claude-haiku-4-5");
    assert.equal(opus.interacoes, 2);
    assert.ok(Math.abs(opus.custoEstimadoUsd - 0.20) < 1e-9);
    assert.equal(haiku.interacoes, 1);
  });
});

describe("intervaloDoFiltro", () => {
  test("'hoje' cobre só o dia atual (desde <= ate, mesmo dia)", () => {
    const r = intervaloDoFiltro({ periodo: "hoje" });
    assert.equal(r.desde.slice(0, 10), r.ate.slice(0, 10));
  });

  test("'mes_anterior' nunca inclui o mês atual", () => {
    const r = intervaloDoFiltro({ periodo: "mes_anterior" });
    const agora = new Date();
    const inicioMesAtualIso = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1)).toISOString();
    assert.ok(r.ate <= inicioMesAtualIso);
  });

  test("'personalizado' usa exatamente as datas informadas", () => {
    const r = intervaloDoFiltro({ periodo: "personalizado", desde: "2026-08-01", ate: "2026-08-15" });
    assert.equal(r.desde.slice(0, 10), "2026-08-01");
    assert.equal(r.ate.slice(0, 10), "2026-08-15");
  });

  test("'personalizado' sem desde/ate cai no default (este_mes), nunca quebra", () => {
    const r = intervaloDoFiltro({ periodo: "personalizado" });
    assert.ok(r.desde && r.ate);
  });

  test("período desconhecido/ausente cai em 'este_mes'", () => {
    const r = intervaloDoFiltro({});
    const agora = new Date();
    const inicioMesAtualIso = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1)).toISOString();
    assert.equal(r.desde, inicioMesAtualIso);
  });
});
