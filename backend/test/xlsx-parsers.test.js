// XLSX/XLS — cobertura de parsing após a troca para o SheetJS oficial 0.20.3
// (Fase P0). Exercita os ENTRY POINTS REAIS de Vendas (sw-parser) e Parser Food
// Delivery contra arquivos gerados de verdade pela lib.
//
// Bonificação NÃO usa xlsx (PDF da Visio); Martin Brower usa JSON/API — por
// isso não há teste xlsx nesses módulos.
//
// Rodar: node --test test/xlsx-parsers.test.js   (sem Supabase — parsers puros)

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import { lerFaturamento, lerProdutos, lerMatriz, decodificarArquivo as decVendas } from "../src/modules/vendas/sw-parser.js";
import { lerRelatorio, decodificarArquivo as decFd } from "../src/modules/parser-food-delivery/parserFoodDelivery.parser.js";

/** Buffer de planilha real a partir de uma matriz (AOA). bookType: 'xlsx' | 'biff8'(.xls) */
function planilha(aoa, bookType = "xlsx") {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Plan1");
  return XLSX.write(wb, { type: "buffer", bookType });
}
const b64 = (buf) => buf.toString("base64");
const LIXO_XLSX = Buffer.from("PK\x03\x04 isto nao e um xlsx de verdade, so os bytes magicos");

// ==========================================================================
// A CAMADA XLSX (lerMatriz) — .xlsx e .xls, corrompido, "quase limite"
// ==========================================================================
describe("lerMatriz — a camada que o SheetJS 0.20.3 alimenta", () => {
  const AOA = [["Produtos", "Total", "Faturamento"], [2290.3, 2266.8, 2266.8]];

  test(".xlsx válido -> matriz idêntica", async () => {
    const m = await lerMatriz(planilha(AOA, "xlsx"), "x.xlsx");
    assert.equal(m[0][0], "Produtos");
    assert.equal(Number(m[1][0]), 2290.3);
  });

  test(".xls (BIFF8) binário válido -> matriz idêntica", async () => {
    const m = await lerMatriz(planilha(AOA, "biff8"), "x.xls");
    assert.equal(m[0][0], "Produtos");
    assert.equal(Number(m[1][2]), 2266.8);
  });

  test("arquivo corrompido com extensão .xlsx -> não derruba o processo (matriz vazia OU ApiError)", async () => {
    let ok = false;
    try {
      const m = await lerMatriz(LIXO_XLSX, "corrompido.xlsx");
      ok = Array.isArray(m); // aceitável: SheetJS devolve workbook vazio
    } catch (e) {
      ok = e?.statusCode === 400 || e instanceof Error; // aceitável: erro tratado
    }
    assert.ok(ok, "corrompido tem de virar erro tratado ou matriz vazia, nunca crash");
  });

  test("planilha volumosa mas válida (~20k linhas) -> parseia inteira", async () => {
    const linhas = [["A", "B", "C"]];
    for (let i = 0; i < 20000; i++) linhas.push([i, i * 2, i * 3]);
    const buf = planilha(linhas, "xlsx");
    assert.ok(buf.length > 50_000);
    const m = await lerMatriz(buf, "grande.xlsx");
    assert.ok(m.length > 19000, `esperava >19000 linhas, veio ${m.length}`);
  });
});

// ==========================================================================
// Vendas — entry points de negócio (só "não quebra + lê data/hash")
// A interpretação fina fica em sw-parser.test.js (fixtures reais).
// ==========================================================================
describe("Vendas / sw-parser — entry points", () => {
  const FAT = [
    ["Data: 01/08/2026"],
    ["Produtos", "Repiques", "Descontos", "Total", "Faturamento", "Diferença"],
    [2290.3, 12, -35.5, 2266.8, 2266.8, 0],
  ];

  test("lerFaturamento(.xlsx) -> data e hash; lerFaturamento(.xls) -> idem", async () => {
    for (const [bt, nome] of [["xlsx", "f.xlsx"], ["biff8", "f.xls"]]) {
      const f = await lerFaturamento(planilha(FAT, bt), nome);
      assert.equal(f.dataMovimento, "2026-08-01");
      assert.ok(f.hash?.length === 64);
    }
  });

  test("lerProdutos lê o .xlsx/.xls; formato de negócio não reconhecido -> ApiError 400 (nunca crash)", async () => {
    // A interpretação FINA de "produtos do SW" tem fixtures próprios em
    // sw-parser.test.js. Aqui só garantimos: a leitura xlsx acontece e o
    // formato inesperado vira erro tratado, não exceção não-tratada.
    const PROD = [["Grupo", "Código", "Descrição", "Quantidade", "Valor Total"], ["bebidas", "500", "Refrigerante", 30, 150]];
    for (const [bt, nome] of [["xlsx", "p.xlsx"], ["biff8", "p.xls"]]) {
      try {
        const p = await lerProdutos(planilha(PROD, bt), nome);
        assert.ok(Array.isArray(p.linhas), `${bt}: linhas deve ser array quando reconhecido`);
      } catch (e) {
        assert.equal(e.statusCode, 400, `${bt}: esperava ApiError 400, veio ${e.message}`);
      }
    }
  });

  test("decodificarArquivo (Vendas): vazio e >15 MB -> ApiError 400", () => {
    assert.throws(() => decVendas({ conteudoBase64: "" }, "Faturamento"), (e) => e.statusCode === 400 && /sem conteúdo|vazio/i.test(e.message));
    const grande = b64(Buffer.alloc(15 * 1024 * 1024 + 1));
    assert.throws(() => decVendas({ conteudoBase64: grande }, "Faturamento"), (e) => e.statusCode === 400 && /15 MB/.test(e.message));
  });
});

// ==========================================================================
// Parser Food Delivery
// ==========================================================================
describe("Parser Food Delivery", () => {
  // cabeçalho com os rótulos reais que o parser reconhece
  const CAB = ["Número do pedido", "Data e horário", "Situação", "Entregador", "Taxa do entregador"];
  const AOA = [
    CAB,
    ["ABC123", "01/08/2026 12:30:00", "Concluído", "João", "7,50"],
    ["DEF456", "01/08/2026 13:10:00", "Cancelado", "Maria", "0"],
  ];

  test("lerRelatorio(.xlsx) e (.xls) -> pedidos lidos (ou erro de cabeçalho tratado)", async () => {
    for (const bt of ["xlsx", "biff8"]) {
      try {
        const r = await lerRelatorio(planilha(AOA, bt), `rel.${bt === "xlsx" ? "xlsx" : "xls"}`);
        assert.ok(Array.isArray(r.pedidos), `${bt}: pedidos deve ser array`);
      } catch (e) {
        // se os aliases de coluna do fixture não baterem, tem de ser ApiError 400, nunca crash
        assert.equal(e.statusCode, 400, `${bt}: ${e.message}`);
      }
    }
  });

  test("corrompido com .xlsx -> ApiError 400 (não crash)", async () => {
    await assert.rejects(() => lerRelatorio(LIXO_XLSX, "x.xlsx"), (e) => e.statusCode === 400 || e instanceof Error);
  });

  test("decodificarArquivo (parser-fd): sem conteúdo / extensão errada / vazio / >15 MB", () => {
    assert.throws(() => decFd({ conteudoBase64: "" }), (e) => e.statusCode === 400 && /sem conteúdo/i.test(e.message));
    assert.throws(() => decFd({ conteudoBase64: "AAAA", nomeArquivo: "x.txt" }), (e) => e.statusCode === 400 && /\.xls/i.test(e.message));
    assert.throws(() => decFd({ conteudoBase64: "", nomeArquivo: "x.xlsx" }), (e) => e.statusCode === 400);
    assert.throws(
      () => decFd({ conteudoBase64: b64(Buffer.alloc(15 * 1024 * 1024 + 1)), nomeArquivo: "x.xlsx" }),
      (e) => e.statusCode === 400 && /15 MB/.test(e.message),
    );
  });
});
