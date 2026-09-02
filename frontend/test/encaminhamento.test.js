// Decisão de encaminhamento pós-login (encaminhamento.js) — PURA, sem DOM.
// Cobre a matriz de casos A–F da Fase D do Painel Administrativo + item 20
// (auto-seleção) + item 12 (usuário administrativo sem vínculos).
//
// Rodar: node --test frontend/test/encaminhamento.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rotaPosAcessos, botaoPainelAdmVisivel } from "../src/encaminhamento.js";

const emp = (id) => ({ organizacaoId: id, unidadeId: null, acessivel: true });

describe("rotaPosAcessos — matriz de casos", () => {
  test("CASO A: 1 empresa, sem Painel Administrativo, não superadmin -> auto-entra", () => {
    const r = rotaPosAcessos({ opcoes: [emp("o1")], superadmin: false, painelAdministrativo: false });
    assert.equal(r.destino, "auto-tenant");
    assert.equal(r.opcao.organizacaoId, "o1");
  });

  test("CASO B: várias empresas, sem Painel Administrativo -> seleção", () => {
    const r = rotaPosAcessos({ opcoes: [emp("o1"), emp("o2")], superadmin: false, painelAdministrativo: false });
    assert.equal(r.destino, "selecao");
  });

  test("CASO C: várias empresas + Painel Administrativo -> seleção (mostra empresas + botão)", () => {
    const r = rotaPosAcessos({ opcoes: [emp("o1"), emp("o2")], superadmin: false, painelAdministrativo: true });
    assert.equal(r.destino, "selecao");
  });

  test("CASO D: 0 empresas + Painel Administrativo -> seleção (NUNCA bloqueia)", () => {
    const r = rotaPosAcessos({ opcoes: [], superadmin: false, painelAdministrativo: true });
    assert.equal(r.destino, "selecao");
  });

  test("CASO E: SuperAdmin sem empresas -> painel SuperAdmin (comportamento atual)", () => {
    const r = rotaPosAcessos({ opcoes: [], superadmin: true, painelAdministrativo: true });
    assert.equal(r.destino, "superadmin");
  });

  test("CASO F: SuperAdmin + Painel Administrativo + empresas -> seleção (oferece os 3)", () => {
    const r = rotaPosAcessos({ opcoes: [emp("o1")], superadmin: true, painelAdministrativo: true });
    assert.equal(r.destino, "selecao");
  });
});

describe("item 20 — auto-seleção de 1 empresa só quando não há outro ambiente global", () => {
  test("1 empresa + Painel Administrativo -> NÃO auto-entra, mostra seleção", () => {
    assert.equal(rotaPosAcessos({ opcoes: [emp("o1")], painelAdministrativo: true }).destino, "selecao");
  });

  test("1 empresa + SuperAdmin (sem preferirAdmin) -> não auto-entra", () => {
    // superadmin com empresas e sem preferirAdmin cai na seleção (comportamento atual)
    assert.equal(rotaPosAcessos({ opcoes: [emp("o1")], superadmin: true }).destino, "selecao");
  });

  test("preferirAdmin=true + superadmin -> painel SuperAdmin mesmo com empresas", () => {
    assert.equal(rotaPosAcessos({ opcoes: [emp("o1")], superadmin: true }, { preferirAdmin: true }).destino, "superadmin");
  });

  test("opções não-acessíveis não contam para a auto-seleção", () => {
    const r = rotaPosAcessos({ opcoes: [{ organizacaoId: "o1", acessivel: false }], painelAdministrativo: false });
    assert.equal(r.destino, "selecao");
  });
});

describe("botaoPainelAdmVisivel", () => {
  test("true só quando painelAdministrativo é true (associação OU superadmin por bypass, resolvido no backend)", () => {
    assert.equal(botaoPainelAdmVisivel({ painelAdministrativo: true }), true);
    assert.equal(botaoPainelAdmVisivel({ painelAdministrativo: false }), false);
    assert.equal(botaoPainelAdmVisivel({}), false);
    assert.equal(botaoPainelAdmVisivel(null), false);
  });

  test("usuário comum não vê", () => {
    assert.equal(botaoPainelAdmVisivel({ superadmin: false, painelAdministrativo: false, opcoes: [emp("o1")] }), false);
  });
});
