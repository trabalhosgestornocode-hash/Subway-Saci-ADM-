// Testes da tabela comercial no frontend — unit, sem DOM (mesmo espírito do
// resto da suíte). Cobre:
//   * state.js#tabelaAtiva/emComparacao — qual tabela a tela mostra agora;
//   * comparacaoTabela.js — persistência em sessionStorage NUNCA atravessa
//     unidade (mockada aqui, já que Node puro não tem `sessionStorage`).
//
// Rodar: node --test frontend/test/tabelaComercial.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// sessionStorage não existe em Node puro — mock mínimo ANTES de importar
// comparacaoTabela.js (o módulo só toca `sessionStorage` dentro de funções,
// nunca no top-level, então importar antes/depois de definir o mock tanto
// faz — mas define primeiro por clareza).
function criarSessionStorageFake() {
  const dados = new Map();
  return {
    getItem: (k) => (dados.has(k) ? dados.get(k) : null),
    setItem: (k, v) => { dados.set(k, String(v)); },
    removeItem: (k) => { dados.delete(k); },
  };
}
globalThis.sessionStorage = criarSessionStorageFake();

const { state, tabelaAtiva, emComparacao } = await import("../src/state.js");
const { comparacaoSalvaDaUnidade, salvarComparacao, limparComparacaoSalva } = await import("../src/comparacaoTabela.js");

describe("state.js — tabelaAtiva / emComparacao", () => {
  beforeEach(() => {
    state.canal = "balcao";
    state.tabelasOficiais = { balcao: "E", ifood: "Z4" };
    state.tabelaComparacao = null;
  });

  test("sem comparação: tabelaAtiva é a oficial do canal atual", () => {
    assert.equal(tabelaAtiva(), "E");
    assert.equal(emComparacao(), false);
  });

  test("trocar de canal muda a tabela ativa pra oficial do canal novo", () => {
    state.canal = "ifood";
    assert.equal(tabelaAtiva(), "Z4");
  });

  test("com comparação: tabelaAtiva é a tabela em comparação, nunca a oficial", () => {
    state.tabelaComparacao = "A";
    assert.equal(tabelaAtiva(), "A");
    assert.equal(emComparacao(), true);
  });

  test("comparação igual à oficial NÃO conta como comparação de verdade", () => {
    state.tabelaComparacao = "E"; // mesma tabela que já é a oficial do balcão
    assert.equal(emComparacao(), false);
  });

  test("sem tabela oficial configurada e sem comparação: tabelaAtiva é null (nunca inventa)", () => {
    state.tabelasOficiais = { balcao: null, ifood: null };
    assert.equal(tabelaAtiva(), null);
  });
});

describe("comparacaoTabela.js — sessionStorage, nunca atravessa unidade", () => {
  beforeEach(() => { limparComparacaoSalva(); });

  test("salva e lê de volta, para a MESMA unidade", () => {
    salvarComparacao({ unidadeId: "u1", canal: "balcao", tabela: "A" });
    assert.deepEqual(comparacaoSalvaDaUnidade("u1"), { canal: "balcao", tabela: "A" });
  });

  test("unidade DIFERENTE nunca recebe a comparação salva de outra", () => {
    salvarComparacao({ unidadeId: "u1", canal: "balcao", tabela: "A" });
    assert.equal(comparacaoSalvaDaUnidade("u2"), null);
  });

  test("nada salvo: retorna null, nunca lança", () => {
    assert.equal(comparacaoSalvaDaUnidade("u1"), null);
  });

  test("limparComparacaoSalva remove — nenhuma unidade mais recebe nada", () => {
    salvarComparacao({ unidadeId: "u1", canal: "ifood", tabela: "Z1" });
    limparComparacaoSalva();
    assert.equal(comparacaoSalvaDaUnidade("u1"), null);
  });
});
