// Testes de agente.usage.js — acumulação pura de usage entre múltiplas
// chamadas à Anthropic dentro de UMA interação (tool use). Sem rede/banco.
//
// Rodar: node --test test/agente-usage.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { usageVazio, acumularUsage } from "../src/modules/agente/agente.usage.js";

describe("acumularUsage", () => {
  test("soma correta de uma única chamada", () => {
    const total = acumularUsage(usageVazio(), { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 });
    assert.deepEqual(total, { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 });
  });

  test("soma de múltiplas chamadas (cenário real de tool use: Claude #1 -> tool -> Claude #2 -> tool -> Claude #3)", () => {
    let total = usageVazio();
    total = acumularUsage(total, { inputTokens: 500, outputTokens: 40 }); // Claude #1 (pede tool)
    total = acumularUsage(total, { inputTokens: 620, outputTokens: 35 }); // Claude #2 (pede 2ª tool)
    total = acumularUsage(total, { inputTokens: 700, outputTokens: 180 }); // Claude #3 (resposta final)
    assert.equal(total.inputTokens, 500 + 620 + 700);
    assert.equal(total.outputTokens, 40 + 35 + 180);
  });

  test("zero cache tokens quando o campo vem 0 explicitamente", () => {
    const total = acumularUsage(usageVazio(), { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 });
    assert.equal(total.cacheCreationTokens, 0);
    assert.equal(total.cacheReadTokens, 0);
  });

  test("cache tokens presentes são somados normalmente", () => {
    let total = usageVazio();
    total = acumularUsage(total, { inputTokens: 100, outputTokens: 10, cacheCreationTokens: 2000, cacheReadTokens: 500 });
    total = acumularUsage(total, { inputTokens: 50, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 500 });
    assert.equal(total.cacheCreationTokens, 2000);
    assert.equal(total.cacheReadTokens, 1000);
  });

  test("ausência de campo opcional não derruba o acúmulo (conta como 0)", () => {
    const total = acumularUsage(usageVazio(), { inputTokens: 100, outputTokens: 10 }); // sem cache*
    assert.equal(total.cacheCreationTokens, 0);
    assert.equal(total.cacheReadTokens, 0);
  });

  test("parcial undefined inteiro não derruba o acúmulo", () => {
    const total = acumularUsage({ inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 }, undefined);
    assert.deepEqual(total, { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 });
  });

  test("não muta o objeto `total` recebido (retorna um novo)", () => {
    const original = usageVazio();
    const novo = acumularUsage(original, { inputTokens: 5 });
    assert.equal(original.inputTokens, 0);
    assert.equal(novo.inputTokens, 5);
  });
});
