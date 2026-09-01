// Testes dos construtores de botão do Agente Crescer (agenteBotoes.js) —
// unit, puro (só string, sem DOM). O gate do módulo Inteligência mora na
// camada de agentePainel.js, não aqui.
//
// Rodar: node --test frontend/test/agenteBotoes.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { botaoContextualHtml, botaoDiagnosticoHtml, textoSementeDiagnostico } from "../src/agenteBotoes.js";

describe("botaoDiagnosticoHtml", () => {
  test("carrega o ponto de atenção e, quando dado, a classificação do card", () => {
    const html = botaoDiagnosticoHtml("taxas_entregadores", "CRITICAL");
    assert.match(html, /data-attention-point="taxas_entregadores"/);
    assert.match(html, /data-diagnostico-tipo="CRITICAL"/);
    assert.match(html, /data-agente-contextual="dashboard_diagnostico"/);
  });

  test("sem tipo -> nenhum data-diagnostico-tipo no HTML", () => {
    const html = botaoDiagnosticoHtml("faturamento");
    assert.match(html, /data-attention-point="faturamento"/);
    assert.ok(!/data-diagnostico-tipo/.test(html));
  });
});

describe("botaoContextualHtml", () => {
  test("gera o botão com a chave contextual", () => {
    assert.match(botaoContextualHtml("dashboard_executivo"), /data-agente-contextual="dashboard_executivo"/);
  });
});

describe("textoSementeDiagnostico — varia pela classificação, nunca acusa indicador saudável", () => {
  test("CRITICAL / WARNING / HEALTHY produzem textos DISTINTOS", () => {
    const c = textoSementeDiagnostico("CRITICAL");
    const w = textoSementeDiagnostico("WARNING");
    const h = textoSementeDiagnostico("HEALTHY");
    assert.notEqual(c, w);
    assert.notEqual(w, h);
    assert.notEqual(c, h);
  });

  test("CRITICAL fala em 'acima do limite'", () => {
    assert.match(textoSementeDiagnostico("CRITICAL"), /acima do limite/i);
  });

  test("WARNING fala em sair da faixa ideal, sem linguagem de limite estourado", () => {
    const w = textoSementeDiagnostico("WARNING");
    assert.match(w, /faixa ideal/i);
    assert.ok(!/acima do limite/i.test(w));
  });

  test("HEALTHY reconhece que está dentro da meta e pede PRESERVAÇÃO, nunca 'por que está ruim'", () => {
    const h = textoSementeDiagnostico("HEALTHY");
    assert.match(h, /dentro da meta/i);
    assert.match(h, /preserv/i);
    assert.ok(!/ruim|por que este indicador está (ruim|alto|acima)|problema/i.test(h));
  });

  test("tipo desconhecido/ausente -> texto genérico de investigação", () => {
    assert.equal(textoSementeDiagnostico(), textoSementeDiagnostico("QUALQUER_COISA"));
    assert.match(textoSementeDiagnostico(), /ponto de atenção/i);
  });
});
