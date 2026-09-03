import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const frontendUrl = new URL("../src/dashboardExecutivo.js", import.meta.url);
const backendUrl = new URL("../../backend/src/modules/dashboard-executivo/dashboardExecutivo.service.js", import.meta.url);

describe("Dashboard iFood — pendencias de meses anteriores", () => {
  test("nao renderiza o bloco amarelo na Visao Geral nem em Lancamentos", async () => {
    const fonte = await readFile(frontendUrl, "utf8");
    assert.doesNotMatch(fonte, /DADOS PENDENTES/);
    assert.doesNotMatch(fonte, /alertaPendencias\s*\(/);
  });

  test("backend continua calculando e entregando a informacao", async () => {
    const fonte = await readFile(backendUrl, "utf8");
    assert.match(fonte, /calcularPendenciasMesAnterior\s*\(/);
    assert.match(fonte, /pendenciasMesesAnteriores,/);
  });
});
