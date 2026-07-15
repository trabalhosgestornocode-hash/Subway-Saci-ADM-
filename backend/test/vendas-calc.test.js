import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classificar, reconciliar, divergenciasDaReconciliacao, consolidarVisao,
} from "../src/modules/vendas/vendas.calc.js";

// ---------- classificação ----------
test("classificar prioriza o mapa de códigos", () => {
  const mapa = new Map([["101", { tipo_item: "combo", produto_id: "p1", ignorar_no_cmv: false, ignorar_no_estoque: false }]]);
  const c = classificar({ codigoSw: "101", nomeSw: "QUALQUER", grupo: "ETAPAS" }, mapa);
  assert.equal(c.tipoItem, "combo");
  assert.equal(c.produtoId, "p1");
  assert.equal(c.viaMapa, true);
});

test("classificar: grupo de taxas/descontos ignora no CMV", () => {
  const c = classificar({ codigoSw: "902", nomeSw: "TX ENTREGA", grupo: "TAXAS E DESCONTOS" }, new Map());
  assert.equal(c.tipoItem, "taxa_desconto");
  assert.equal(c.ignorarCmv, true);
});

test("classificar: grupo COMBOS vira combo comercial", () => {
  const c = classificar({ codigoSw: "700", nomeSw: "COMBO 15CM + BEBIDA", grupo: "COMBOS", valorTotal: 35 }, new Map());
  assert.equal(c.tipoItem, "combo");
  assert.equal(c.ignorarCmv, false);
});

test("classificar: etapa por valor zero ou nome de montagem", () => {
  const zero = classificar({ codigoSw: "501", nomeSw: "ESCOLHA DO PAO", grupo: "ETAPAS", valorTotal: 0 }, new Map());
  assert.equal(zero.tipoItem, "etapa");
  const nome = classificar({ codigoSw: "502", nomeSw: "TOMATE", grupo: "INSUMOS", valorTotal: 5 }, new Map());
  assert.equal(nome.tipoItem, "etapa");
  const comercial = classificar({ codigoSw: "503", nomeSw: "PROMO DUPLA", grupo: "ETAPAS", valorTotal: 25 }, new Map());
  assert.equal(comercial.tipoItem, "produto");
});

// ---------- reconciliação ----------
const FAT = { produtos: 2290.3, combos: 60 };
const LINHAS = [
  { tipo_item: "produto", valor_total: 2290.0 },
  { tipo_item: "combo", valor_total: 60.0 },
  { tipo_item: "etapa", valor_total: 0 },
];
test("reconciliar aprova valores dentro da tolerância (R$1 ou 2%)", () => {
  const checks = reconciliar(FAT, LINHAS, { dataFat: "2026-07-11", dataProd: "2026-07-11" });
  assert.equal(checks.length, 4); // data + produtos + combos + total
  assert.ok(checks.every((c) => c.ok));
});

test("reconciliar reprova datas e valores divergentes", () => {
  const checks = reconciliar({ produtos: 3000, combos: 0 }, LINHAS, { dataFat: "2026-07-10", dataProd: "2026-07-11" });
  const data = checks.find((c) => c.campo === "Data do movimento");
  const prod = checks.find((c) => c.campo === "Produtos (R$)");
  assert.equal(data.ok, false);
  assert.equal(prod.ok, false);
  assert.equal(prod.diferenca, -710);
  const divs = divergenciasDaReconciliacao(checks);
  assert.ok(divs.some((d) => d.tipo === "datas_diferentes" && d.nivel === "critico"));
  assert.ok(divs.some((d) => d.tipo === "valor_incompativel" && d.nivel === "atencao"));
});

test("reconciliar sem os dois relatórios não inventa checagens de valor", () => {
  assert.deepEqual(reconciliar(null, LINHAS), []);
  assert.deepEqual(reconciliar(FAT, []), []);
});

// ---------- consolidação da Visão Geral ----------
const FAT_ROWS = [
  { data_movimento: "2026-07-10", canal: "balcao", total: 2425, faturamento: 2350, descontos: 75, taxas_entrega: 11, diferenca: 0 },
  { data_movimento: "2026-07-11", canal: "ifood", total: 2442.5, faturamento: 2362.3, descontos: 80.2, taxas_entrega: 12, diferenca: -25.5 },
];
const PROD_ROWS_SEM_CUSTO = [
  { data_movimento: "2026-07-10", canal: "balcao", grupo: "SANDUICHES", codigo_sw: "101", nome_sw: "FRANGO", quantidade: 100, valor_total: 1900, custo_teorico: null, ignorar_no_cmv: false, tipo_item: "produto", produto_id: null },
  { data_movimento: "2026-07-11", canal: "balcao", grupo: "ETAPAS", codigo_sw: "501", nome_sw: "TOMATE", quantidade: 50, valor_total: 0, custo_teorico: null, ignorar_no_cmv: true, tipo_item: "etapa", produto_id: null },
];

test("consolidarVisao: sem custo processado, CMV e margem ficam nulos (nunca 0%/100%)", () => {
  const v = consolidarVisao(FAT_ROWS, PROD_ROWS_SEM_CUSTO);
  assert.equal(v.cmvTeorico, null);
  assert.equal(v.margem, null);
  assert.equal(v.semVinculo, 1);
  assert.equal(v.faturamentoLiquido, 4712.3);
  assert.equal(v.faturamentoBruto, 4867.5);
  assert.equal(v.fechamentos, 2);
  assert.equal(v.qtdProdutos, 100);
});

test("consolidarVisao: com custo, CMV/margem/cobertura são calculados", () => {
  const prod = [
    { ...PROD_ROWS_SEM_CUSTO[0], produto_id: "p1", custo_teorico: 600 },
    { data_movimento: "2026-07-11", canal: "ifood", grupo: "BEBIDAS", codigo_sw: "205", nome_sw: "COCA", quantidade: 58, valor_total: 348, custo_teorico: null, ignorar_no_cmv: false, tipo_item: "produto", produto_id: null },
  ];
  const v = consolidarVisao(FAT_ROWS, prod);
  assert.equal(v.cmvTeorico, +(600 / 4712.3 * 100).toFixed(2));
  assert.equal(v.margem, +((4712.3 - 600) / 4712.3 * 100).toFixed(2));
  assert.equal(v.semVinculo, 1);          // só a COCA
  assert.equal(v.semFicha, 0);
  assert.equal(v.coberturaCmv, +(1900 / 2248 * 100).toFixed(1));
});

test("consolidarVisao: combo com custo por componentes não conta como sem vínculo", () => {
  const prod = [{ data_movimento: "2026-07-11", canal: "balcao", grupo: "COMBOS", codigo_sw: "700", nome_sw: "COMBO", quantidade: 10, valor_total: 350, custo_teorico: 120, ignorar_no_cmv: false, tipo_item: "combo", produto_id: null }];
  const v = consolidarVisao(FAT_ROWS, prod);
  assert.equal(v.semVinculo, 0);
  assert.ok(v.cmvTeorico > 0);
});

test("consolidarVisao: sem fechamentos, série por dia usa a venda de produtos", () => {
  const v = consolidarVisao([], PROD_ROWS_SEM_CUSTO);
  assert.equal(v.fechamentos, 0);
  assert.equal(v.temDados, true);
  assert.deepEqual(v.porDia, [{ data: "2026-07-10", valor: 1900 }]);
  assert.equal(v.porCanal[0].canal, "balcao");
});

test("consolidarVisao: vazio de verdade", () => {
  const v = consolidarVisao([], []);
  assert.equal(v.temDados, false);
  assert.equal(v.cmvTeorico, null);
  assert.equal(v.periodo, null);
});
