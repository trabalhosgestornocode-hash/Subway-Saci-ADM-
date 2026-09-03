import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { numeroDecimal, numeroDecimalOuIndefinido } from "../src/numeroDecimal.js";

describe("numeroDecimal", () => {
  test("aceita virgula decimal brasileira", () => assert.equal(numeroDecimal("123,45"), 123.45));
  test("aceita ponto decimal canonico", () => assert.equal(numeroDecimal("123.45"), 123.45));
  test("aceita milhar e centavos no formato brasileiro", () => assert.equal(numeroDecimal("1.234,56"), 1234.56));
  test("aceita milhar brasileiro sem centavos", () => assert.equal(numeroDecimal("1.234"), 1234));
  test("aceita valor negativo para ajustes autorizados", () => assert.equal(numeroDecimal("-12,34"), -12.34));
  test("rejeita texto e separadores ambiguos", () => {
    assert.equal(Number.isNaN(numeroDecimal("R$ 12,34")), true);
    assert.equal(Number.isNaN(numeroDecimal("12,3,4")), true);
    assert.equal(Number.isNaN(numeroDecimal("1,234.56")), true);
    assert.equal(Number.isNaN(numeroDecimal("12.34,56")), true);
    assert.equal(Number.isNaN(numeroDecimal("1.2,34")), true);
    assert.equal(Number.isNaN(numeroDecimal("1 2,34")), true);
  });
  test("rejeita mais de duas casas decimais", () => {
    assert.equal(Number.isNaN(numeroDecimal("12,345")), true);
    assert.equal(Number.isNaN(numeroDecimal("12.3456")), true);
  });
  test("preserva numero vindo da API", () => assert.equal(numeroDecimal(19.9), 19.9));
});

test("formularios diario e mensal usam entrada decimal e o parser compartilhado", async () => {
  const { readFile } = await import("node:fs/promises");
  const diario = await readFile(new URL("../src/dashboardExecutivoForm.js", import.meta.url), "utf8");
  const mensal = await readFile(new URL("../src/dashboardExecutivoMensal.js", import.meta.url), "utf8");
  assert.match(diario, /inputmode="decimal"/);
  assert.match(mensal, /inputmode="decimal"/);
  assert.match(diario, /numeroDecimalOuIndefinido\(c\.valorVendasIfood\)/);
  assert.match(mensal, /valorTotalMensal: numeroDecimal\(lm\.valor\)/);
});

describe("numeroDecimalOuIndefinido", () => {
  test("omite campo vazio", () => assert.equal(numeroDecimalOuIndefinido(""), undefined));
  test("converte campo preenchido", () => assert.equal(numeroDecimalOuIndefinido("0,01"), 0.01));
});
