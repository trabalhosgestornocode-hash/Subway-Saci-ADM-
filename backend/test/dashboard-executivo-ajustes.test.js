// Ajustes a favor / contra a loja — cobertura dos cenários do item 10 do
// pedido. Puro, sem rede: exercita a normalização de entrada
// (normalizarDadosLancamento) e as fórmulas centrais (calc.js).
// Rodar: node --test test/dashboard-executivo-ajustes.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { normalizarDadosLancamento } from "../src/modules/dashboard-executivo/dashboardExecutivo.service.js";
import { totalDeducoes, receitaLiquida } from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";

const OPCOES = { exigirFinanceiro: true, desempenhoAnterior: null };
const BASE = {
  situacao: "normal", status: "finalizado",
  qtdVendas: 40, valorVendasBruto: 2000, novosClientes: 3,
  valorVendasIfood: 100, taxasComissoes: 10, servicosPromocoes: 5, taxasEntregadores: 0,
};
const norm = (over) => normalizarDadosLancamento({ ...BASE, ...over }, OPCOES);
const totalDe = (d) => totalDeducoes({
  taxasComissoes: d.taxasComissoes, servicosPromocoes: d.servicosPromocoes,
  taxasEntregadores: d.taxasEntregadores, ajustesContraLoja: d.ajustesContraLoja,
});
const receitaDe = (d) => receitaLiquida(d.valorVendasIfood, totalDe(d), d.ajustesFavorLoja);

describe("normalização — ajustes a favor / contra", () => {
  test("1. nenhum ajuste informado -> null/null; total = 15; receita líquida = 85", () => {
    const d = norm({});
    assert.equal(d.ajustesFavorLoja, null);
    assert.equal(d.ajustesContraLoja, null);
    assert.equal(totalDe(d), 15);
    assert.equal(receitaDe(d), 85);
  });

  test("2. só ajuste a favor (8): total continua 15; receita líquida = 93", () => {
    const d = norm({ ajustesFavorLoja: 8 });
    assert.equal(d.ajustesFavorLoja, 8);
    assert.equal(d.ajustesContraLoja, null);
    assert.equal(totalDe(d), 15);
    assert.equal(receitaDe(d), 93);
  });

  test("3. só ajuste contra (3): total = 18; receita líquida = 82", () => {
    const d = norm({ ajustesContraLoja: 3 });
    assert.equal(d.ajustesContraLoja, 3);
    assert.equal(totalDe(d), 18);
    assert.equal(receitaDe(d), 82);
  });

  test("4. ajuste a favor (8) + contra (3): total = 18; receita líquida = 90 (100 - 10 - 5 - 3 + 8)", () => {
    const d = norm({ ajustesFavorLoja: 8, ajustesContraLoja: 3 });
    assert.equal(totalDe(d), 18);
    assert.equal(receitaDe(d), 90);
  });

  test("5. taxas + promoções + entregadores + ajustes: só o ajuste contra entra no total", () => {
    const d = norm({ taxasEntregadores: 7, ajustesFavorLoja: 4, ajustesContraLoja: 6 });
    assert.equal(totalDe(d), 10 + 5 + 7 + 6); // 28
    assert.equal(receitaDe(d), 100 - 28 + 4); // 76
  });

  test("6. Total de deduções NÃO inclui o ajuste a favor (mesmo valor alto)", () => {
    const semFavor = norm({ ajustesContraLoja: 3 });
    const comFavor = norm({ ajustesContraLoja: 3, ajustesFavorLoja: 999 });
    assert.equal(totalDe(semFavor), totalDe(comFavor));
  });

  test("7. Receita líquida inclui o ajuste a favor", () => {
    const semFavor = norm({ ajustesContraLoja: 3 });
    const comFavor = norm({ ajustesContraLoja: 3, ajustesFavorLoja: 12 });
    assert.equal(receitaDe(comFavor) - receitaDe(semFavor), 12);
  });

  test("valores negativos são rejeitados (o usuário nunca digita sinal)", () => {
    assert.throws(() => norm({ ajustesFavorLoja: -5 }), /Ajustes a favor da loja/);
    assert.throws(() => norm({ ajustesContraLoja: -5 }), /Ajustes contra a loja/);
  });

  test("sem_operacao / zero_vendas zeram os dois ajustes", () => {
    const so = normalizarDadosLancamento({ situacao: "sem_operacao", status: "finalizado", motivoSemOperacao: "Feriado" }, OPCOES);
    assert.equal(so.ajustesFavorLoja, 0);
    assert.equal(so.ajustesContraLoja, 0);
    const zv = normalizarDadosLancamento({ situacao: "zero_vendas", status: "finalizado" }, OPCOES);
    assert.equal(zv.ajustesFavorLoja, 0);
    assert.equal(zv.ajustesContraLoja, 0);
  });

  test("11. edição: reenviar sem os ajustes zera para null; reenviar com novos valores atualiza", () => {
    const criado = norm({ ajustesFavorLoja: 8, ajustesContraLoja: 3 });
    assert.deepEqual([criado.ajustesFavorLoja, criado.ajustesContraLoja], [8, 3]);
    const editadoLimpo = norm({}); // não mandou os campos -> voltam a null
    assert.deepEqual([editadoLimpo.ajustesFavorLoja, editadoLimpo.ajustesContraLoja], [null, null]);
    const editadoNovo = norm({ ajustesFavorLoja: 20, ajustesContraLoja: 5 });
    assert.deepEqual([editadoNovo.ajustesFavorLoja, editadoNovo.ajustesContraLoja], [20, 5]);
  });
});

describe("migração de dados históricos de outras_deducoes (semântica da migration 066)", () => {
  // Reproduz o CASE da migration: contra = max(outras, 0); favor = max(-outras, 0).
  const converter = (outras) => outras == null
    ? { favor: null, contra: null }
    : { favor: outras < 0 ? -outras : 0, contra: outras >= 0 ? outras : 0 };

  test("8. positivo histórico (20) -> ajustes_contra_loja = 20, ajustes_favor_loja = 0", () => {
    assert.deepEqual(converter(20), { favor: 0, contra: 20 });
  });

  test("9. negativo histórico (-34,98, o \"Reembolso\") -> ajustes_favor_loja = 34,98, contra = 0", () => {
    assert.deepEqual(converter(-34.98), { favor: 34.98, contra: 0 });
  });

  test("zero histórico -> ambos 0; null histórico -> ambos null", () => {
    assert.deepEqual(converter(0), { favor: 0, contra: 0 });
    assert.deepEqual(converter(null), { favor: null, contra: null });
  });

  test("o total de deduções de um registro migrado bate com o antigo (quando outras era >= 0)", () => {
    // antigo: total = taxas+serviços+entregadores + outras_deducoes(=20)
    // novo:   total = taxas+serviços+entregadores + ajustes_contra_loja(=20)
    const { contra } = converter(20);
    assert.equal(totalDeducoes({ taxasComissoes: 100, servicosPromocoes: 50, taxasEntregadores: 30, ajustesContraLoja: contra }), 200);
  });
});
