import { test } from "node:test";
import assert from "node:assert/strict";
import { classificarOperacao, rotuloOperacao, OPERACAO } from "../src/modules/parser-food-delivery/parserFoodDelivery.operacao.js";

// ---------- casos reais do relatório (auditoria feita em 13/08/2026) ----------
test("classificarOperacao: pedido Subway típico vira 'subway'", () => {
  const r = classificarOperacao({ detalhesPedido: "1x Imperdíveis do Subway (15cm) 1x Steak Churrasco\n 1x Alface\n 1x Tomate" });
  assert.equal(r.operacao, OPERACAO.SUBWAY);
  assert.equal(r.motivo, null);
});

test("classificarOperacao: pedido de Açaí no Grau vira 'acai_no_grau' (texto real do relatório)", () => {
  const r = classificarOperacao({ detalhesPedido: "1x Monte seu Açaí & Cremes,1x Açaí Premium 400 ml (Serve muito Bem 1 pessoa),1x Açaí Zero" });
  assert.equal(r.operacao, OPERACAO.ACAI_NO_GRAU);
  assert.match(r.motivo, /Açaí no Grau/);
});

test("classificarOperacao é tolerante a acento/caixa (açaí, Acai, AÇAÍ)", () => {
  assert.equal(classificarOperacao({ detalhesPedido: "1x Copo de acai tradicional" }).operacao, OPERACAO.ACAI_NO_GRAU);
  assert.equal(classificarOperacao({ detalhesPedido: "1x COPO DE AÇAÍ TRADICIONAL" }).operacao, OPERACAO.ACAI_NO_GRAU);
});

test("classificarOperacao não usa termos genéricos isolados como prova de Açaí", () => {
  assert.equal(classificarOperacao({ detalhesPedido: "1x Brownie do Subway" }).operacao, OPERACAO.SUBWAY);
  assert.equal(classificarOperacao({ detalhesPedido: "1x Pote de cookies Subway" }).operacao, OPERACAO.SUBWAY);
  assert.equal(classificarOperacao({ detalhesPedido: "1x Paleta de morango" }).operacao, OPERACAO.REVISAO_NECESSARIA);
  assert.equal(classificarOperacao({ detalhesPedido: "1x Pote de açaí premium com brownie" }).operacao, OPERACAO.ACAI_NO_GRAU);
  assert.equal(classificarOperacao({ detalhesPedido: "1x Paleta Morango com Leite Condesado" }).operacao, OPERACAO.ACAI_NO_GRAU);
});

// ---------- proteção contra falso positivo ----------
test("classificarOperacao não confunde 'sub' dentro de outra palavra (falso positivo)", () => {
  // "substituto" contém "sub" mas não é um termo isolado — não deve contar como sinal de nada
  const r = classificarOperacao({ detalhesPedido: "1x Item substituto qualquer" });
  assert.equal(r.operacao, OPERACAO.SUBWAY); // sem termo nenhum reconhecido -> default seguro
});

test("classificarOperacao: termos de duas operações no mesmo pedido -> revisão necessária (nunca exclui automático)", () => {
  const r = classificarOperacao({ detalhesPedido: "1x Sub Frango 15cm 1x Açaí Premium 300ml" });
  assert.equal(r.operacao, OPERACAO.REVISAO_NECESSARIA);
  assert.match(r.motivo, /mais de uma operação/);
});

test("classificarOperacao: sem descrição nenhuma -> revisão necessária (nunca subway por padrão nem açaí por padrão)", () => {
  assert.equal(classificarOperacao({ detalhesPedido: null }).operacao, OPERACAO.REVISAO_NECESSARIA);
  assert.equal(classificarOperacao({ detalhesPedido: "" }).operacao, OPERACAO.REVISAO_NECESSARIA);
  assert.equal(classificarOperacao({ detalhesPedido: "   " }).operacao, OPERACAO.REVISAO_NECESSARIA);
});

test("classificarOperacao: pedido sem nenhum termo reconhecido de nenhuma operação vira Subway (default seguro)", () => {
  const r = classificarOperacao({ detalhesPedido: "1x Refrigerante Lata 1x Coca-Cola Sem Açúcar" });
  assert.equal(r.operacao, OPERACAO.SUBWAY);
});

test("rotuloOperacao devolve nome em pt-BR", () => {
  assert.equal(rotuloOperacao(OPERACAO.ACAI_NO_GRAU), "Açaí no Grau");
  assert.equal(rotuloOperacao(OPERACAO.SUBWAY), "Subway Saci");
  assert.equal(rotuloOperacao(OPERACAO.REVISAO_NECESSARIA), "Revisão necessária");
});
