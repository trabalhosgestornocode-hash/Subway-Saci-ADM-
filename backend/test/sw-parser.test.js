import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBR, acharData, textoParaMatriz, explodirNumerosFinais,
  interpretarFaturamento, interpretarProdutos, lerFaturamento, lerProdutos, sha256,
} from "../src/modules/vendas/sw-parser.js";

// ---------- parseBR ----------
test("parseBR entende os formatos brasileiros do SW", () => {
  assert.equal(parseBR("2.318,00"), 2318);
  assert.equal(parseBR("R$ 1.234,56"), 1234.56);
  assert.equal(parseBR("-25,50"), -25.5);
  assert.equal(parseBR("122"), 122);
  assert.equal(parseBR(19.9), 19.9);
  assert.equal(parseBR(""), 0);
  assert.equal(parseBR("abc"), 0);
});

// ---------- datas ----------
test("acharData reconhece dd/mm/aaaa e aaaa-mm-dd", () => {
  assert.equal(acharData([["Movimento de 11/07/2026"]]), "2026-07-11");
  assert.equal(acharData([["data:", "2026-07-10"]]), "2026-07-10");
  assert.equal(acharData([["sem data aqui"]]), null);
});

// ---------- reconstrução de colunas do PDF ----------
test("explodirNumerosFinais separa números do fim da linha", () => {
  assert.deepEqual(
    explodirNumerosFinais("101 - FRANGO TERIYAKI 15CM 122 2.318,00"),
    ["101 - FRANGO TERIYAKI 15CM", "122", "2.318,00"]);
  assert.deepEqual(explodirNumerosFinais("Produtos + 2.290,30"), ["Produtos +", "2.290,30"]);
  assert.deepEqual(explodirNumerosFinais("SANDUICHES"), ["SANDUICHES"]);
});

test("textoParaMatriz divide por 2+ espaços e explode linhas coladas", () => {
  const m = textoParaMatriz("Produto   Qtd   Total\n101 - COOKIE CHOCOLATE 98 490,00");
  assert.deepEqual(m[0], ["Produto", "Qtd", "Total"]);
  assert.deepEqual(m[1], ["101 - COOKIE CHOCOLATE", "98", "490,00"]);
});

// ---------- Relatório 1: Análise de Faturamento ----------
const MATRIZ_FAT = [
  ["Análise de Faturamento", "", "11/07/2026"],
  ["Produtos +", "Tx. Entregas +", "Descontos -", "Combos +", "Total =", "Faturamento", "Diferença"],
  ["2.290,30", "12,00", "80,20", "60,00", "2.442,50", "2.362,30", "-25,50"],
];
test("interpretarFaturamento lê o layout cabeçalho + linha de valores", () => {
  const f = interpretarFaturamento(MATRIZ_FAT);
  assert.equal(f.produtos, 2290.3);
  assert.equal(f.taxasEntrega, 12);
  assert.equal(f.descontos, 80.2);
  assert.equal(f.combos, 60);
  assert.equal(f.total, 2442.5);
  assert.equal(f.faturamento, 2362.3);
  assert.equal(f.diferenca, -25.5);
});

test("interpretarFaturamento aceita o layout rótulo/valor (PDF)", () => {
  const f = interpretarFaturamento([
    ["Produtos +", "2.290,30"], ["Descontos -", "80,20"], ["Faturamento", "2.362,30"], ["Total =", "2.442,50"],
  ]);
  assert.equal(f.produtos, 2290.3);
  assert.equal(f.faturamento, 2362.3);
});

test("interpretarFaturamento rejeita arquivo que não é o relatório", () => {
  assert.throws(() => interpretarFaturamento([["qualquer", "coisa"], ["1", "2"]]), /Não reconheci/);
});

// ---------- Relatório 2: Venda de Produtos por Grupo ----------
const MATRIZ_PROD = [
  ["Venda de Produtos por Grupo", "", "11/07/2026"],
  ["Produto", "Qtd", "Total"],
  ["SANDUICHES"],
  ["101 - FRANGO TERIYAKI 15CM", "122", "2.318,00"],
  ["(122) subtotal", "10%", "2.318,00"],
  ["ETAPAS"],
  ["501 - TOMATE", "80", "0,00"],
  ["BEBIDAS"],
  ["205 - COCA-COLA LATA", "58", "348,00"],
];
test("interpretarProdutos lê hierarquia de grupos e ignora subtotais", () => {
  const linhas = interpretarProdutos(MATRIZ_PROD);
  assert.equal(linhas.length, 3);
  assert.deepEqual(linhas[0], { codigoSw: "101", nomeSw: "FRANGO TERIYAKI 15CM", grupo: "SANDUICHES", quantidade: 122, valorTotal: 2318 });
  assert.equal(linhas[1].grupo, "ETAPAS");
  assert.equal(linhas[2].grupo, "BEBIDAS");
  assert.equal(linhas[2].valorTotal, 348);
});

test("interpretarProdutos rejeita arquivo sem produtos", () => {
  assert.throws(() => interpretarProdutos([["nada", "a ver"]]), /Não encontrei produtos/);
});

// ---------- caminho completo CSV (buffer -> relatório) ----------
test("lerFaturamento processa um CSV real do início ao fim", async () => {
  const csv = "Análise de Faturamento;;11/07/2026\nProdutos +;Tx. Entregas +;Total =;Faturamento;Diferença\n2.290,30;12,00;2.442,50;2.362,30;-25,50";
  const buf = Buffer.from(csv, "utf8");
  const f = await lerFaturamento(buf, "analise.csv");
  assert.equal(f.produtos, 2290.3);
  assert.equal(f.dataMovimento, "2026-07-11");
  assert.equal(f.hash, sha256(buf));
  assert.equal(f.nomeArquivo, "analise.csv");
});

test("lerProdutos processa um CSV real do início ao fim", async () => {
  const csv = "Venda de Produtos por Grupo;;11/07/2026\nProduto;Qtd;Total\nSANDUICHES;;\n101 - FRANGO TERIYAKI 15CM;122;2.318,00";
  const p = await lerProdutos(Buffer.from(csv, "utf8"), "produtos.csv");
  assert.equal(p.linhas.length, 1);
  assert.equal(p.linhas[0].codigoSw, "101");
  assert.equal(p.dataMovimento, "2026-07-11");
});

// ---------- caminho completo PDF (fixtures geradas por impressão real no Chrome) ----------
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

test("lerFaturamento lê um PDF real (impressão do relatório)", async () => {
  const f = await lerFaturamento(readFileSync(join(FIXTURES, "rel-fat.pdf")), "rel-fat.pdf");
  assert.equal(f.produtos, 2290.3);
  assert.equal(f.taxasEntrega, 12);
  assert.equal(f.descontos, 80.2);
  assert.equal(f.combos, 60);
  assert.equal(f.total, 2442.5);
  assert.equal(f.faturamento, 2362.3);
  assert.equal(f.diferenca, -25.5);
  assert.equal(f.dataMovimento, "2026-07-11");
});

test("lerProdutos lê um PDF real com grupos e linhas de produto", async () => {
  const p = await lerProdutos(readFileSync(join(FIXTURES, "rel-prod.pdf")), "rel-prod.pdf");
  assert.deepEqual(p.linhas, [
    { codigoSw: "101", nomeSw: "FRANGO TERIYAKI 15CM", grupo: "SANDUICHES", quantidade: 122, valorTotal: 2318 },
    { codigoSw: "205", nomeSw: "COCA-COLA LATA", grupo: "BEBIDAS", quantidade: 58, valorTotal: 348 },
  ]);
  assert.equal(p.dataMovimento, "2026-07-11");
});
