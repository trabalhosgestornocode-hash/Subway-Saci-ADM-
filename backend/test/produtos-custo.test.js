// Testes de produtos/custo.js#usoDiretoDeInsumo — função pura (sem I/O),
// adicionada na Etapa C para o Agente Crescer ("quanto desse insumo tem no
// produto X"). O grafo é montado à mão aqui, no mesmo formato que
// carregarGrafo() devolveria (Maps), para não depender de Supabase.
//
// Rodar: node --env-file-if-exists=.env --test test/produtos-custo.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { usoDiretoDeInsumo, produtosAfetadosPorInsumo, custoTotalProduto } from "../src/modules/produtos/custo.js";

function grafoDeTeste() {
  const insumoById = new Map([
    ["queijo", { id: "queijo", nome: "Queijo Cheddar", unidade_medida: "g", preco_unitario: 0.05, ativo: true }],
    ["pao", { id: "pao", nome: "Pão Italiano", unidade_medida: "un", preco_unitario: 1.2, ativo: true }],
    ["sem-custo", { id: "sem-custo", nome: "Insumo Sem Custo", unidade_medida: "g", preco_unitario: null, ativo: true }],
  ]);
  const nomeProdById = new Map([
    ["bmt", "BMT 15cm"],
    ["combo-bmt", "Combo BMT"],
  ]);
  const fichaByProd = new Map([
    // BMT usa queijo (30g) e pão (1un) DIRETAMENTE.
    ["bmt", [
      { produto_id: "bmt", insumo_id: "queijo", quantidade: 30, ativo: true },
      { produto_id: "bmt", insumo_id: "pao", quantidade: 1, ativo: true },
    ]],
    // Combo BMT usa o BMT como submontagem -> usa queijo só INDIRETAMENTE.
    ["combo-bmt", [
      { produto_id: "combo-bmt", subproduto_id: "bmt", quantidade: 1, ativo: true },
    ]],
  ]);
  return { insumoById, nomeProdById, fichaByProd, produtos: [] };
}

describe("usoDiretoDeInsumo", () => {
  test("linha direta existente: devolve quantidade/unidade/custoAplicado calculados", () => {
    const grafo = grafoDeTeste();
    const uso = usoDiretoDeInsumo("bmt", "queijo", grafo);
    assert.deepEqual(uso, { quantidade: 30, unidade: "g", custoAplicado: 1.5 }); // 30g * R$0,05/g
  });

  test("insumo usado só INDIRETAMENTE (via submontagem): null, nunca inventa quantidade", () => {
    const grafo = grafoDeTeste();
    assert.equal(usoDiretoDeInsumo("combo-bmt", "queijo", grafo), null);
  });

  test("produto que não usa o insumo de forma alguma: null", () => {
    const grafo = grafoDeTeste();
    assert.equal(usoDiretoDeInsumo("bmt", "insumo-inexistente", grafo), null);
  });

  test("insumo sem custo cadastrado: null (nunca custoAplicado = 0 fingindo que é um custo real)", () => {
    const grafo = grafoDeTeste();
    grafo.fichaByProd.set("bmt", [
      ...grafo.fichaByProd.get("bmt"),
      { produto_id: "bmt", insumo_id: "sem-custo", quantidade: 10, ativo: true },
    ]);
    assert.equal(usoDiretoDeInsumo("bmt", "sem-custo", grafo), null);
  });

  test("linha inativa: não conta como uso direto", () => {
    const grafo = grafoDeTeste();
    grafo.fichaByProd.set("bmt", [
      { produto_id: "bmt", insumo_id: "queijo", quantidade: 30, ativo: false },
    ]);
    assert.equal(usoDiretoDeInsumo("bmt", "queijo", grafo), null);
  });

  test("consistência com produtosAfetadosPorInsumo: o Combo aparece afetado, mas sem uso direto", () => {
    const grafo = grafoDeTeste();
    const afetados = produtosAfetadosPorInsumo("queijo", grafo);
    assert.ok(afetados.includes("bmt"));
    assert.ok(afetados.includes("combo-bmt")); // indireto, via BMT
    assert.equal(usoDiretoDeInsumo("bmt", "queijo", grafo) !== null, true);
    assert.equal(usoDiretoDeInsumo("combo-bmt", "queijo", grafo), null);
    // Mas custoTotalProduto do Combo continua contabilizando o queijo (via explosão recursiva) — só não como "linha direta".
    assert.ok(custoTotalProduto("combo-bmt", grafo) > 0);
  });
});
