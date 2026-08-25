// Testes do registro de resolvers de navegação do Agente Crescer (Etapa
// F.1) — unit, puro (sem DOM). Mesmo padrão de contextoEscopo.js.
//
// Rodar: node --test frontend/test/agenteAcoesResolvedores.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { registrarResolverAcao, obterResolverAcao, targetsRegistrados } from "../src/agenteAcoesResolvedores.js";

describe("registrarResolverAcao / obterResolverAcao", () => {
  test("target sem resolver registrado -> undefined, nunca lança", () => {
    assert.equal(obterResolverAcao("target-nunca-registrado"), undefined);
  });

  test("registra e recupera o MESMO resolver", () => {
    const fn = () => "abriu";
    registrarResolverAcao("teste_alvo_1", fn);
    assert.equal(obterResolverAcao("teste_alvo_1"), fn);
  });

  test("registrar de novo o mesmo target substitui o resolver anterior (sem acumular)", () => {
    registrarResolverAcao("teste_alvo_2", () => "primeiro");
    registrarResolverAcao("teste_alvo_2", () => "segundo");
    assert.equal(obterResolverAcao("teste_alvo_2")(), "segundo");
  });

  test("targetsRegistrados inclui os targets já registrados neste teste", () => {
    registrarResolverAcao("teste_alvo_3", () => {});
    assert.ok(targetsRegistrados().includes("teste_alvo_3"));
  });
});
