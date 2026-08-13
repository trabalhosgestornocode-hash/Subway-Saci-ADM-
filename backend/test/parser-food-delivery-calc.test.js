import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classificarPedido, resumoConciliacao, agruparPorEntregador, validarCodigo, extrairCodigos, temEntregador, STATUS_CONCILIACAO,
} from "../src/modules/parser-food-delivery/parserFoodDelivery.calc.js";

// ---------- a regra de conciliação (item 3 do pedido) ----------
test("classificarPedido: não cancelado é sempre incluído", () => {
  assert.equal(classificarPedido({ numeroPedido: "1", situacao: "Finalizado" }, new Set()), STATUS_CONCILIACAO.INCLUIDO);
});
test("classificarPedido: cancelado, COM entregador, sem código informado mantém a taxa válida", () => {
  assert.equal(classificarPedido({ numeroPedido: "1", situacao: "Cancelado", entregador: "Ana" }, new Set(["2"])), STATUS_CONCILIACAO.CANCELADO_COM_TAXA);
});
test("classificarPedido: cancelado, COM entregador, com código informado descarta a taxa", () => {
  assert.equal(classificarPedido({ numeroPedido: "1", situacao: "Cancelado", entregador: "Ana" }, new Set(["1"])), STATUS_CONCILIACAO.EXCLUIDO);
});
test("classificarPedido: situação é comparada sem acento/caixa", () => {
  assert.equal(classificarPedido({ numeroPedido: "1", situacao: "CANCELADO", entregador: "Ana" }, new Set(["1"])), STATUS_CONCILIACAO.EXCLUIDO);
});

// ---------- complemento: pedido sem entregador não entra em NADA da conta ----------
// (o filtro em si mora no service.js, ANTES de classificarPedido — aqui só
// testamos o critério puro que o service usa pra decidir isso).
test("temEntregador: null/vazio/só espaço/campo ausente contam como SEM entregador", () => {
  assert.equal(temEntregador(null), false);
  assert.equal(temEntregador(undefined), false);
  assert.equal(temEntregador(""), false);
  assert.equal(temEntregador("   "), false);
});
test("temEntregador: nome de verdade conta como COM entregador", () => {
  assert.equal(temEntregador("Carlos"), true);
  assert.equal(temEntregador("  Ana  "), true);
});

// ---------- resumo financeiro ----------
test("resumoConciliacao soma taxas brutas/descartadas/válidas corretamente", () => {
  const pedidos = [
    { situacao: "Finalizado", taxaEntregador: 10, statusConciliacao: "incluido" },
    { situacao: "Cancelado", taxaEntregador: 15, statusConciliacao: "cancelado_com_taxa" },
    { situacao: "Cancelado", taxaEntregador: 8, statusConciliacao: "excluido" },
  ];
  const r = resumoConciliacao(pedidos);
  assert.equal(r.totalPedidos, 3);
  assert.equal(r.entregues, 1);
  assert.equal(r.cancelados, 2);
  assert.equal(r.canceladosComTaxa, 1);
  assert.equal(r.canceladosSemTaxa, 1);
  assert.equal(r.taxasBrutas, 33);
  assert.equal(r.taxasDescartadas, 8);
  assert.equal(r.taxasValidas, 25);
});

// ---------- agrupamento por entregador ----------
test("agruparPorEntregador conta por entregador e só soma taxa válida", () => {
  const pedidos = [
    { entregador: "Ana", situacao: "Finalizado", taxaEntregador: 10, statusConciliacao: "incluido" },
    { entregador: "Ana", situacao: "Cancelado", taxaEntregador: 5, statusConciliacao: "excluido" },
    { entregador: "Bruno", situacao: "Cancelado", taxaEntregador: 7, statusConciliacao: "cancelado_com_taxa" },
  ];
  const g = agruparPorEntregador(pedidos);
  const ana = g.find((e) => e.entregador === "Ana");
  const bruno = g.find((e) => e.entregador === "Bruno");
  assert.equal(ana.totalPedidos, 2);
  assert.equal(ana.entregues, 1);
  assert.equal(ana.canceladosSemTaxa, 1);
  assert.equal(ana.taxasValidas, 10); // a taxa do cancelado sem taxa NÃO entra
  assert.equal(bruno.canceladosComTaxa, 1);
  assert.equal(bruno.taxasValidas, 7); // cancelado com taxa MANTÉM a taxa
});

test("agruparPorEntregador: pedido sem entregador não aparece no ranking de taxas", () => {
  const pedidos = [
    { entregador: "Ana", situacao: "Finalizado", taxaEntregador: 10, statusConciliacao: "incluido" },
    { entregador: null, situacao: "Cancelado", taxaEntregador: 12, statusConciliacao: "excluido" },
    { entregador: "", situacao: "Cancelado", taxaEntregador: 9, statusConciliacao: "excluido" },
    { situacao: "Cancelado", taxaEntregador: 5, statusConciliacao: "excluido" }, // entregador nem existe no objeto
  ];
  const g = agruparPorEntregador(pedidos);
  assert.equal(g.length, 1); // só a Ana — nenhuma linha "—" pros sem entregador
  assert.equal(g[0].entregador, "Ana");
  assert.equal(g.some((e) => e.entregador === "—"), false);
});

// ---------- validação de código digitado (item 2 do pedido) ----------
test("validarCodigo cobre encontrado/não encontrado/não cancelado", () => {
  const mapa = new Map([["1", { situacao: "Cancelado", entregador: "Ana" }], ["2", { situacao: "Finalizado", entregador: "Ana" }]]);
  assert.equal(validarCodigo("1", mapa).encontrado, true);
  assert.equal(validarCodigo("1", mapa).alerta, null);
  assert.notEqual(validarCodigo("2", mapa).alerta, null); // encontrado mas não cancelado -> aviso
  assert.equal(validarCodigo("9", mapa).encontrado, false);
});

// ---------- validação de código de outra operação (complemento: filtro Subway) ----------
test("validarCodigo avisa quando o código pertence a outra operação, em vez de 'não encontrado'", () => {
  const mapa = new Map([["6222", { situacao: "Cancelado", operacao: "acai_no_grau" }]]);
  const r = validarCodigo("6222", mapa);
  assert.equal(r.encontrado, true);
  assert.equal(r.operacao, "acai_no_grau");
  assert.match(r.alerta, /outra operação/);
});
test("validarCodigo funciona normalmente para pedido explicitamente marcado 'subway'", () => {
  const mapa = new Map([["1", { situacao: "Cancelado", operacao: "subway", entregador: "Ana" }]]);
  const r = validarCodigo("1", mapa);
  assert.equal(r.encontrado, true);
  assert.equal(r.alerta, null);
});

// ---------- validação de código sem entregador (complemento: não entra na conta) ----------
test("validarCodigo avisa quando o pedido não tem entregador, em vez de tratar como cancelamento normal", () => {
  const mapa = new Map([["9", { situacao: "Cancelado", operacao: "subway", entregador: null }]]);
  const r = validarCodigo("9", mapa);
  assert.equal(r.encontrado, true);
  assert.match(r.alerta, /não tem entregador/);
});

test("extrairCodigos separa por vírgula, espaço e quebra de linha, sem duplicar", () => {
  assert.deepEqual(extrairCodigos("111, 222 333\n111"), ["111", "222", "333"]);
});
