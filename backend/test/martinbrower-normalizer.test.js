import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  normalizarItem, normalizarCatalogo, normalizarPedido, normalizarDataHora,
} from "../src/modules/martinbrower/martinbrower.normalizer.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const fixture = (nome) => JSON.parse(readFileSync(join(aqui, "fixtures/martinbrower", nome), "utf8"));

const CATALOGO = fixture("load-itens.json");
const PEDIDO = fixture("prox-pedido.json");

test("normaliza um item real preservando todos os campos confirmados", () => {
  const item = CATALOGO.data.groups[0].itens[0];
  const r = normalizarItem(item, "ALIMENTOS - CONGELADOS - CONGELADOS");
  assert.equal(r.ok, true);

  assert.deepEqual(r.produto, {
    orderId: 612694,
    clientProductId: 2208537,
    productId: 6095,
    codigo: "1001088",
    codigoInterno: "2664329",
    descricao: "BACON TIRAS CX 4 PCT X 1 KG",
    preco: 486.01,
    peso: 4.62,
    volume: 0.026,
    unidade: "CX",
    unidadeDescricao: "CAIXA",
    familia: "CON",
    familiaDescricao: "Congelados",
    grupoId: 246,
    grupoDescricao: "ALIMENTOS - CONGELADOS",
    multiplo: 1,
    quantidadeMedia: 1,
    quantidadePedido: 0,
    statusItemId: 1,
    tipoProduto: "W",
  });
});

test("código é sempre string — zeros à esquerda preservados", () => {
  const { produtos } = normalizarCatalogo(CATALOGO);
  const guardanapo = produtos.find((p) => p.descricao.includes("GUARDANAPO"));
  assert.equal(guardanapo.codigo, "0002045");
  assert.equal(typeof guardanapo.codigo, "string");
});

test("descrição tem espaços colapsados e aparados", () => {
  const { produtos } = normalizarCatalogo(CATALOGO);
  const frango = produtos.find((p) => p.codigo === "1000891");
  assert.equal(frango.descricao, "FRANGO DEFUMADO CX 2 X 2,5 KG");
});

test("item sem código é rejeitado sem derrubar a sincronização", () => {
  const r = normalizarItem({ appClientProduct: { product: { description: "SEM CODIGO" } } });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /sem código/);
});

test("item sem descrição é rejeitado", () => {
  const r = normalizarItem({ appClientProduct: { product: { code: "123" } } });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /sem descrição/);
});

test("item sem preço é ACEITO — preço ausente não invalida o produto", () => {
  const { produtos } = normalizarCatalogo(CATALOGO);
  const copo = produtos.find((p) => p.codigo === "0002046");
  assert.ok(copo, "copo sem preço deveria estar no catálogo");
  assert.equal(copo.preco, null);
  assert.equal(copo.multiplo, 2);
});

test("grupo ausente cai para o rótulo do grupo pai", () => {
  const { produtos } = normalizarCatalogo(CATALOGO);
  const copo = produtos.find((p) => p.codigo === "0002046");
  assert.equal(copo.grupoId, null);
  assert.equal(copo.grupoDescricao, "EMBALAGENS - DESCARTAVEIS");
});

test("item totalmente vazio e código duplicado viram rejeitados, não exceções", () => {
  const { produtos, rejeitados, totalBruto } = normalizarCatalogo(CATALOGO);
  assert.equal(totalBruto, 10);
  assert.equal(produtos.length, 6);
  assert.equal(rejeitados.length, 4);
  assert.ok(rejeitados.some((r) => /duplicado/.test(r.motivo)));
  // O primeiro 1001088 vence; o duplicado de R$999,99 não sobrescreve.
  assert.equal(produtos.filter((p) => p.codigo === "1001088").length, 1);
  assert.equal(produtos.find((p) => p.codigo === "1001088").preco, 486.01);
});

test("estrutura irreconhecível devolve vazio em vez de estourar", () => {
  for (const entrada of [null, undefined, {}, { data: {} }, { data: { groups: "nope" } }]) {
    const r = normalizarCatalogo(entrada);
    assert.deepEqual(r.produtos, []);
    assert.equal(r.totalBruto, 0);
  }
});

test("normaliza data e hora numéricas do portal", () => {
  const iso = normalizarDataHora(20260725, 111000);
  assert.match(iso, /^2026-07-25T/);
  const d = new Date(iso);
  assert.equal(d.getHours(), 11);
  assert.equal(d.getMinutes(), 10);
});

test("data inválida vira null em vez de Invalid Date", () => {
  assert.equal(normalizarDataHora(null, null), null);
  assert.equal(normalizarDataHora(2026, 111000), null);
  assert.equal(normalizarDataHora(20261325, 0), null);   // mês 13
  assert.equal(normalizarDataHora(20260725, 995959), null); // hora 99
});

test("normaliza o pedido e mantém perc apenas como informativo", () => {
  const p = normalizarPedido(PEDIDO);
  assert.equal(p.orderId, 612694);
  assert.equal(p.financialRestriction, null);
  assert.equal(p.percBruto, 70);
  assert.match(p.janelaInicio, /^2026-07-25T/);
  assert.match(p.janelaFinal, /^2026-07-31T/);
  // percBruto existe, mas nenhum outro campo derivado dele é exposto.
  assert.equal(Object.keys(p).filter((k) => k.startsWith("perc")).length, 1);
});

test("pedido sem orderId é reportado como ausência, não como zero", () => {
  const p = normalizarPedido({ data: { orderId: null, financialRestriction: "Bloqueio por inadimplência" } });
  assert.equal(p.orderId, null);
  assert.equal(p.financialRestriction, "Bloqueio por inadimplência");
});
