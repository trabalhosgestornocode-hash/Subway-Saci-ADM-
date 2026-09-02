// Catálogo de integrações que agora vive NO BACKEND, atrás do módulo
// `inteligencia` (antes era constante no bundle do frontend).
//
// Rodar: node --env-file-if-exists=.env --test test/inteligencia-catalogo.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { INTEGRACOES, INTEGRACOES_POR_CHAVE } from "../src/modules/inteligencia/inteligencia.catalogo.js";

const STATUS_VALIDOS = new Set(["conectado", "planejamento", "futuro", "nao_conectado"]);

describe("inteligencia.catalogo", () => {
  test("lista não-vazia e com as integrações estratégicas (Supabase, WhatsApp)", () => {
    assert.ok(INTEGRACOES.length >= 5);
    const chaves = new Set(INTEGRACOES.map((i) => i.chave));
    assert.ok(chaves.has("supabase"), "Supabase deve estar no catálogo do backend");
    assert.ok(chaves.has("whatsapp"), "WhatsApp deve estar no catálogo do backend");
  });

  test("cada item tem os campos que o card do front consome", () => {
    for (const i of INTEGRACOES) {
      assert.equal(typeof i.chave, "string", "chave");
      assert.ok(i.chave.length, `chave vazia em ${JSON.stringify(i)}`);
      assert.equal(typeof i.nome, "string", `nome em ${i.chave}`);
      assert.equal(typeof i.desc, "string", `desc em ${i.chave}`);
      assert.ok(Array.isArray(i.features), `features em ${i.chave}`);
      assert.ok(STATUS_VALIDOS.has(i.status), `status inválido em ${i.chave}: ${i.status}`);
      assert.ok(i.icon || i.logo, `${i.chave} precisa de icon ou logo`);
    }
  });

  test("chaves únicas e índice por chave consistente", () => {
    const chaves = INTEGRACOES.map((i) => i.chave);
    assert.equal(new Set(chaves).size, chaves.length);
    assert.equal(Object.keys(INTEGRACOES_POR_CHAVE).length, chaves.length);
    assert.equal(INTEGRACOES_POR_CHAVE.supabase?.nome, "Supabase");
  });
});
