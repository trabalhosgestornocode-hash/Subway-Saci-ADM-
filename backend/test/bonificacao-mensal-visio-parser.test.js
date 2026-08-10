// Testes A, B, C do item 76 — parser dos relatórios reais da Visio Analytics
// (Geral e Loja). Fixtures = os 2 PDFs fornecidos pelo usuário.
// Rodar: node --test test/bonificacao-mensal-visio-parser.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVisioProductReport } from "../src/modules/bonificacao-mensal/visio-parser.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const perto = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

describe("Teste A — PDF Geral", () => {
  test("extrai faturamento total e PPD corretos", async () => {
    const r = await parseVisioProductReport(readFileSync(join(FIXTURES, "visio-geral.pdf")));
    assert.equal(r.faturamento, 9845.09);
    assert.equal(r.ppd, 168);
    assert.equal(r.estabelecimento, "Subway Teresina Saci");
  });
});

describe("Teste B — PDF Loja", () => {
  test("extrai faturamento, PPD e quantidades corretos", async () => {
    const r = await parseVisioProductReport(readFileSync(join(FIXTURES, "visio-loja.pdf")));
    assert.equal(r.faturamento, 3893.15);
    assert.equal(r.ppd, 73);
    assert.equal(r.sandwichesSalads, 132);
    assert.equal(r.beverages, 56);
    assert.equal(r.additions, 38);
    assert.equal(r.miscellaneous, 19);
    assert.equal(r.estabelecimento, "Subway Teresina Saci");
  });

  test("também guarda o percentual que o PRÓPRIO PDF informou (para validação cruzada)", async () => {
    const r = await parseVisioProductReport(readFileSync(join(FIXTURES, "visio-loja.pdf")));
    assert.ok(perto(r.percentualBebidasPdf, 42.4));
    assert.ok(perto(r.percentualAdicionaisPdf, 28.8));
    assert.ok(perto(r.percentualDiversosPdf, 14.4));
  });
});

describe("Teste C — Mix calculado a partir das quantidades do PDF Loja", () => {
  test("bebidas/adicionais/diversos batem com o percentual esperado (~42,4% / 28,8% / 14,4%)", async () => {
    const r = await parseVisioProductReport(readFileSync(join(FIXTURES, "visio-loja.pdf")));
    assert.ok(perto((r.beverages / r.sandwichesSalads) * 100, 42.4));
    assert.ok(perto((r.additions / r.sandwichesSalads) * 100, 28.8));
    assert.ok(perto((r.miscellaneous / r.sandwichesSalads) * 100, 14.4));
  });
});

describe("Teste 68 — coerência Geral >= Loja (sem exigir igualdade)", () => {
  test("faturamento, PPD e quantidades do Geral são maiores ou iguais aos do Loja", async () => {
    const geral = await parseVisioProductReport(readFileSync(join(FIXTURES, "visio-geral.pdf")));
    const loja = await parseVisioProductReport(readFileSync(join(FIXTURES, "visio-loja.pdf")));
    assert.ok(geral.faturamento >= loja.faturamento);
    assert.ok(geral.ppd >= loja.ppd);
    assert.ok(geral.sandwichesSalads >= loja.sandwichesSalads);
    assert.ok(geral.beverages >= loja.beverages);
    assert.ok(geral.additions >= loja.additions);
    assert.ok(geral.miscellaneous >= loja.miscellaneous);
  });
});

describe("robustez do parser", () => {
  test("rejeita um PDF sem a estrutura esperada", async () => {
    const bufFalso = Buffer.from("%PDF-1.4\n%%EOF");
    await assert.rejects(() => parseVisioProductReport(bufFalso));
  });
});
