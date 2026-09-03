import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { novosClientesAcumulados } from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";

describe("Dashboard Executivo — novos clientes na Visão Geral", () => {
  const dias = ["2026-08-01", "2026-08-02", "2026-08-03"];

  test("usa o último acumulado do período, a mesma regra de Desempenho", () => {
    const linhas = [
      { data_lancamento: dias[0], novos_clientes: 4 },
      { data_lancamento: dias[2], novos_clientes: 9 },
    ];
    assert.equal(novosClientesAcumulados(dias, linhas), 9);
  });

  test("preserva zero informado e distingue ausência de dados", () => {
    assert.equal(novosClientesAcumulados(dias, [{ data_lancamento: dias[0], novos_clientes: 0 }]), 0);
    assert.equal(novosClientesAcumulados(dias, []), null);
  });

  test("não usa fatias estimadas de lançamento mensal", () => {
    const linhas = [{
      data_lancamento: dias[0], novos_clientes: 12,
      origem_lancamento: "distribuicao_mensal",
    }];
    assert.equal(novosClientesAcumulados(dias, linhas), null);
  });

  test("agregado mantém a semântica por unidade e não deduplica clientes", () => {
    const unidadeA = [{ data_lancamento: dias[2], novos_clientes: 7 }];
    const unidadeB = [{ data_lancamento: dias[1], novos_clientes: 5 }];
    const valores = [unidadeA, unidadeB].map((linhas) => novosClientesAcumulados(dias, linhas));
    assert.equal(valores.reduce((soma, valor) => soma + valor, 0), 12);
  });
});
