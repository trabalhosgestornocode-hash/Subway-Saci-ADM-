// Testes de agente.pricing.js — fonte única de preços do Agente Crescer.
// Puro, sem rede/banco.
//
// Rodar: node --test test/agente-pricing.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { calcularCustoUso, precosDoModelo, PRICING_VERSION } from "../src/modules/agente/agente.pricing.js";

const perto = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

describe("calcularCustoUso", () => {
  test("só input", () => {
    const r = calcularCustoUso({ model: "claude-haiku-4-5", inputTokens: 1_000_000 });
    assert.ok(r.precificado);
    assert.ok(perto(r.estimatedCostUsd, 1.0)); // $1,00/1M input do haiku-4-5
  });

  test("só output", () => {
    const r = calcularCustoUso({ model: "claude-haiku-4-5", outputTokens: 1_000_000 });
    assert.ok(perto(r.estimatedCostUsd, 5.0)); // $5,00/1M output do haiku-4-5
  });

  test("input + output combinados", () => {
    const r = calcularCustoUso({ model: "claude-opus-5", inputTokens: 6120, outputTokens: 510 });
    const esperado = (6120 / 1_000_000) * 5.00 + (510 / 1_000_000) * 25.00;
    assert.ok(perto(r.estimatedCostUsd, esperado));
  });

  test("tokens de cache — escrita e leitura têm preço próprio, não o de input comum", () => {
    const r = calcularCustoUso({ model: "claude-opus-5", cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000 });
    const precos = precosDoModelo("claude-opus-5");
    // cache write = 1,25x input; cache read = 0,1x input — nunca o mesmo preço do input comum.
    assert.ok(perto(precos.cacheWrite, 6.25));
    assert.ok(perto(precos.cacheRead, 0.50));
    assert.ok(perto(r.estimatedCostUsd, precos.cacheWrite + precos.cacheRead));
  });

  test("modelo com sufixo de data (snapshot fixo, ex.: CLAUDE_MODEL apontando pra um id datado) usa o preço do modelo base", () => {
    const r = calcularCustoUso({ model: "claude-haiku-4-5-20251001", inputTokens: 1_000_000 });
    assert.ok(r.precificado);
    assert.ok(perto(r.estimatedCostUsd, 1.0)); // mesmo preço de claude-haiku-4-5
  });

  test("modelo desconhecido: não inventa preço, nunca lança exceção", () => {
    const r = calcularCustoUso({ model: "modelo-que-nao-existe", inputTokens: 1000, outputTokens: 500 });
    assert.equal(r.estimatedCostUsd, null);
    assert.equal(r.precificado, false);
    assert.equal(r.pricingVersion, PRICING_VERSION);
  });

  test("precisão decimal preservada — sem arredondamento prematuro", () => {
    // Valor deliberadamente "feio" pra provar que não satura em 2 casas.
    const r = calcularCustoUso({ model: "claude-sonnet-5", inputTokens: 2281, outputTokens: 0 });
    const esperado = (2281 / 1_000_000) * 3.00; // 0.006843
    assert.ok(perto(r.estimatedCostUsd, esperado, 1e-12));
    assert.notEqual(Math.round(r.estimatedCostUsd * 100) / 100, r.estimatedCostUsd); // não virou 0.01 cego
  });

  test("nenhum campo informado -> custo zero, precificado", () => {
    const r = calcularCustoUso({ model: "claude-opus-5" });
    assert.equal(r.estimatedCostUsd, 0);
    assert.equal(r.precificado, true);
  });
});
