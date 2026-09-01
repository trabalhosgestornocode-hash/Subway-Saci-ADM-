// Tela de seleção de ambiente (pós-login) — garante o que a reforma para
// grade de cards precisa manter de pé:
//   * o contador de empresas/unidades reflete as ASSOCIAÇÕES REAIS
//     (nº de empresas = grupos; nº de unidades = opções com unidadeId);
//   * a lista vira um card por empresa (grade), não uma linha por acesso;
//   * empresa com 2+ unidades = card expansível (data-toggle-org), com as
//     unidades reveladas dentro dele;
//   * a busca filtra por empresa, unidade, cidade e cargo e a grade reflui;
//   * o fluxo/permissões não mudam: onEntrar recebe a opção exata clicada.
//
// Sem jsdom no projeto: fake mínimo de `document` indexado por seletor
// (mesma abordagem de configuracoes.test.js).
//
// Rodar: node --test frontend/test/selecaoAmbiente.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// --- fake DOM mínimo -------------------------------------------------------
function fakeEl() {
  return {
    hidden: false,
    value: "",
    textContent: "",
    _html: "",
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    oninput: null,
    onclick: null,
  };
}
let nodes = {};
globalThis.document = {
  querySelector: (sel) => nodes[sel] ?? null,
  querySelectorAll: () => [],
};
globalThis.localStorage = {
  _d: new Map(),
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
};

const { montarSelecao } = await import("../src/selecaoAmbiente.js");

function resetDom() {
  nodes = {
    "#sel-busca-wrap": fakeEl(),
    "#sel-busca": fakeEl(),
    "#sel-recentes": fakeEl(),
    "#sel-contagem": fakeEl(),
    "#sel-lista": fakeEl(),
  };
  localStorage._d.clear();
}

// 3 empresas: uma consolidada (sem unidade), uma com 1 unidade, uma com 3.
const OPCOES = [
  { organizacaoId: "e1", empresaNome: "Alfa Consolidada", logoUrl: null,
    unidadeId: null, unidadeNome: null, papelRotulo: "Administrador",
    cidade: null, cnpj: null, acessivel: true, motivo: null },
  { organizacaoId: "e2", empresaNome: "Caramelle Café", logoUrl: null,
    unidadeId: "u2", unidadeNome: "Vilhena - RO", papelRotulo: "Administrador",
    cidade: "Vilhena", cnpj: "111", acessivel: true, motivo: null },
  { organizacaoId: "e3", empresaNome: "Grupo Saci", logoUrl: null,
    unidadeId: "u3a", unidadeNome: "Saci Centro", papelRotulo: "Gerente",
    cidade: "Cacoal", cnpj: "222", acessivel: true, motivo: null },
  { organizacaoId: "e3", empresaNome: "Grupo Saci", logoUrl: null,
    unidadeId: "u3b", unidadeNome: "Saci Shopping", papelRotulo: "Gerente",
    cidade: "Cacoal", cnpj: "333", acessivel: true, motivo: null },
  { organizacaoId: "e3", empresaNome: "Grupo Saci", logoUrl: null,
    unidadeId: "u3c", unidadeNome: "Saci Aeroporto", papelRotulo: "Gerente",
    cidade: "Ji-Paraná", cnpj: "444", acessivel: true, motivo: null },
];

describe("selecaoAmbiente — contador de empresas/unidades", () => {
  beforeEach(resetDom);

  test("conta empresas pelos grupos e unidades pelas opções com unidadeId", () => {
    montarSelecao({ opcoes: OPCOES, superadmin: false }, { usuarioId: "x", onEntrar() {} });
    const c = nodes["#sel-contagem"];
    assert.equal(c.hidden, false);
    // 3 empresas (e1, e2, e3); 4 unidades (u2, u3a, u3b, u3c) — e1 consolidada não conta.
    assert.match(c.textContent, /associado a 3 empresas/);
    assert.match(c.textContent, /4 unidades disponíveis/);
  });

  test("singular quando é 1 empresa e 1 unidade", () => {
    const uma = [OPCOES[1]];
    montarSelecao({ opcoes: uma, superadmin: false }, { usuarioId: "x", onEntrar() {} });
    assert.match(nodes["#sel-contagem"].textContent, /associado a 1 empresa\b/);
    assert.match(nodes["#sel-contagem"].textContent, /1 unidade disponível\b/);
  });

  test("sem opções: contador escondido", () => {
    montarSelecao({ opcoes: [], superadmin: false }, { usuarioId: "x", onEntrar() {} });
    assert.equal(nodes["#sel-contagem"].hidden, true);
  });
});

describe("selecaoAmbiente — grade de cards", () => {
  beforeEach(resetDom);

  test("um card (article) por empresa, não um por acesso", () => {
    montarSelecao({ opcoes: OPCOES, superadmin: false }, { usuarioId: "x", onEntrar() {} });
    const html = nodes["#sel-lista"].innerHTML;
    assert.equal((html.match(/<article/g) || []).length, 3);
  });

  test("empresa com 2+ unidades vira card expansível com toggle", () => {
    montarSelecao({ opcoes: OPCOES, superadmin: false }, { usuarioId: "x", onEntrar() {} });
    const html = nodes["#sel-lista"].innerHTML;
    assert.match(html, /data-toggle-org="e3"/);
    assert.match(html, /Ver unidades \(3\)/);
  });

  test("expandir revela as unidades e re-render mantém o card aberto", () => {
    montarSelecao({ opcoes: OPCOES, superadmin: false }, { usuarioId: "x", onEntrar() {} });
    const lista = nodes["#sel-lista"];
    // fechado: as unidades ficam num container hidden
    assert.match(lista.innerHTML, /sel-card-unis" hidden/);
    lista.onclick({ target: { closest: (s) => (s === "[data-toggle-org]" ? { dataset: { toggleOrg: "e3" } } : null) } });
    assert.doesNotMatch(lista.innerHTML, /sel-card-unis" hidden/);
    assert.match(lista.innerHTML, /Saci Shopping/);
  });
});

describe("selecaoAmbiente — busca", () => {
  beforeEach(resetDom);

  test("filtra por cidade e reflui a grade", () => {
    montarSelecao({ opcoes: OPCOES, superadmin: false }, { usuarioId: "x", onEntrar() {} });
    const busca = nodes["#sel-busca"];
    busca.value = "vilhena";
    busca.oninput();
    const html = nodes["#sel-lista"].innerHTML;
    assert.match(html, /Caramelle Café/);
    assert.doesNotMatch(html, /Grupo Saci/);
  });

  test("filtra por cargo", () => {
    montarSelecao({ opcoes: OPCOES, superadmin: false }, { usuarioId: "x", onEntrar() {} });
    const busca = nodes["#sel-busca"];
    busca.value = "gerente";
    busca.oninput();
    const html = nodes["#sel-lista"].innerHTML;
    assert.match(html, /Grupo Saci/);
    assert.doesNotMatch(html, /Caramelle Café/);
  });

  test("nada encontrado mostra estado vazio", () => {
    montarSelecao({ opcoes: OPCOES, superadmin: false }, { usuarioId: "x", onEntrar() {} });
    const busca = nodes["#sel-busca"];
    busca.value = "zzzzz";
    busca.oninput();
    assert.match(nodes["#sel-lista"].innerHTML, /Nada encontrado/);
  });
});

describe("selecaoAmbiente — fluxo/permissões inalterados", () => {
  beforeEach(resetDom);

  test("clicar em Acessar entrega a opção exata (org + unidade) ao onEntrar", () => {
    let recebida = null;
    montarSelecao({ opcoes: OPCOES, superadmin: false }, { usuarioId: "x", onEntrar: (o) => { recebida = o; } });
    const lista = nodes["#sel-lista"];
    // abre o Grupo Saci e "clica" em Acessar da unidade u3b
    lista.onclick({ target: { closest: (s) => (s === "[data-toggle-org]" ? { dataset: { toggleOrg: "e3" } } : null) } });
    lista.onclick({ target: { closest: (s) => (s === ".sel-btn" ? { disabled: false, dataset: { org: "e3", uni: "u3b" } } : null) } });
    assert.equal(recebida.organizacaoId, "e3");
    assert.equal(recebida.unidadeId, "u3b");
  });
});
