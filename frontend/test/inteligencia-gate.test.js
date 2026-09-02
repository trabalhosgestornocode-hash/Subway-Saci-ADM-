// Gate-pai da seção "INTELIGÊNCIA" do menu (Agente Crescer · Relatórios ·
// Integrações) via o módulo `inteligencia`.
//
// Cobre:
//   1. o catálogo de integrações (Supabase, WhatsApp, arquitetura) NÃO está
//      mais no bundle do frontend — nem constante, nem JSON, nem fallback;
//   2. config.js expõe SECAO_MODULO ligando "INTELIGÊNCIA" -> "inteligencia";
//   3. a regra de visibilidade (mesma de app.js#montarMenu / router.js#acessivel):
//      seção oculta sem `inteligencia`; Agente exige `inteligencia` E `agente_ia`.
//
// Rodar: node --test frontend/test/inteligencia-gate.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const config = await import("../src/config.js");

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const CONFIG_SRC = readFileSync(new URL("../src/config.js", import.meta.url), "utf8");
const lerTodoOFonte = () =>
  readdirSync(SRC_DIR)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"))
    .join("\n");

describe("catálogo de integrações fora do bundle", () => {
  test("config.js não exporta mais INTEGRACOES (só o mapa de logos)", () => {
    assert.equal(config.INTEGRACOES, undefined);
    assert.equal(typeof config.INTEGRACOES_LOGOS, "object");
  });

  test("INTEGRACOES_LOGOS só tem caminhos /assets — nada de descrição/arquitetura", () => {
    for (const v of Object.values(config.INTEGRACOES_LOGOS)) {
      assert.match(v, /^\/assets\//, `logo inesperado: ${v}`);
    }
  });

  test("nenhum arquivo do frontend contém o texto estratégico do catálogo", () => {
    const fonte = lerTodoOFonte();
    // Trechos que só existiam no catálogo antigo (agora backend-only).
    for (const marcador of [
      "Evolution API",
      "Base para RLS multi-loja",
      "PostgreSQL. Já conectado",
      "Distribuidora oficial: fonte do custo real",
    ]) {
      assert.ok(!fonte.includes(marcador), `"${marcador}" ainda está no bundle do frontend`);
    }
  });
});

describe("SECAO_MODULO — gate-pai de seção", () => {
  test("liga INTELIGÊNCIA -> inteligencia", () => {
    assert.equal(config.SECAO_MODULO["INTELIGÊNCIA"], "inteligencia");
  });

  test("os 3 itens da seção INTELIGÊNCIA existem no MENU", () => {
    const itens = config.MENU.filter((m) => m.secao === "INTELIGÊNCIA").map((m) => m.id);
    assert.deepEqual(itens.sort(), ["ia", "integracoes", "relatorios"]);
  });

  test("o item do Agente (`ia`) mantém o módulo próprio `agente_ia`", () => {
    assert.equal(config.MENU.find((m) => m.id === "ia").modulo, "agente_ia");
  });

  test("Relatórios e Integrações não têm módulo próprio (dependem só do gate de seção)", () => {
    assert.equal(config.MENU.find((m) => m.id === "relatorios").modulo, undefined);
    assert.equal(config.MENU.find((m) => m.id === "integracoes").modulo, undefined);
  });
});

// Réplica pura da regra de app.js#montarMenu / router.js#acessivel, para
// travar a matriz de aceite sem montar DOM.
function itemVisivel(item, modulos) {
  const gateSecao = config.SECAO_MODULO[item.secao];
  if (gateSecao && !modulos.includes(gateSecao)) return false;
  return !item.modulo || modulos.includes(item.modulo);
}
const secaoVisivel = (secao, modulos) => {
  const gate = config.SECAO_MODULO[secao];
  return !gate || modulos.includes(gate);
};

describe("matriz de aceite (visibilidade)", () => {
  const ia = config.MENU.find((m) => m.id === "ia");
  const relatorios = config.MENU.find((m) => m.id === "relatorios");

  test("sem inteligencia: seção oculta, nenhum item passa (mesmo com agente_ia)", () => {
    assert.equal(secaoVisivel("INTELIGÊNCIA", []), false);
    assert.equal(secaoVisivel("INTELIGÊNCIA", ["agente_ia"]), false);
    assert.equal(itemVisivel(ia, ["agente_ia"]), false);
    assert.equal(itemVisivel(relatorios, ["agente_ia"]), false);
  });

  test("com inteligencia, sem agente_ia: seção visível, Relatórios/Integrações sim, Agente não", () => {
    assert.equal(secaoVisivel("INTELIGÊNCIA", ["inteligencia"]), true);
    assert.equal(itemVisivel(relatorios, ["inteligencia"]), true);
    assert.equal(itemVisivel(config.MENU.find((m) => m.id === "integracoes"), ["inteligencia"]), true);
    assert.equal(itemVisivel(ia, ["inteligencia"]), false);
  });

  test("com inteligencia e agente_ia: tudo visível", () => {
    const mods = ["inteligencia", "agente_ia"];
    assert.equal(itemVisivel(ia, mods), true);
    assert.equal(itemVisivel(relatorios, mods), true);
  });
});
