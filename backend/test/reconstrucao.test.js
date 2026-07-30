// Testa o ARTEFATO de reconstrução (backups/reconstrucao.json) gerado da
// planilha oficial: custos batem com os exemplos, fichas têm componentes
// coerentes (pão/embalagem nos sanduíches), e todos os custos reconstruídos
// conferem com o valor calculado da planilha.
// Rode: node --test test/reconstrucao.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cmvPct, margem } from "../src/modules/insumos/insumos.calc.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.join(dir, "..", "backups", "reconstrucao.json");
const existe = fs.existsSync(JSON_PATH);
const data = existe ? JSON.parse(fs.readFileSync(JSON_PATH, "utf8")) : { insumos: [], produtos: [] };
const acha = (frag, aba) => data.produtos.find((p) => p.nome_planilha.toLowerCase().includes(frag.toLowerCase()) && (!aba || p.aba === aba));

describe("reconstrução — artefato da planilha", { skip: existe ? false : "backups/reconstrucao.json ausente (rode o parser)" }, () => {
  test("todos os produtos têm custo reconstruído coerente com a planilha", () => {
    const ruins = data.produtos.filter((p) => !p.ok);
    assert.equal(ruins.length, 0, "produtos com custo divergente: " + ruins.map((p) => p.nome_planilha).join(", "));
  });

  test("Cookie Chocolate = cookie pronto + saco ≈ R$ 2,04", () => {
    const c = acha("COOKIE CHOCOLATE DOUBLE", "Cookies, Chips e Brownies");
    assert.ok(c, "cookie encontrado");
    assert.equal(c.n_comp, 2);
    assert.equal(Number(c.custo_reconstruido.toFixed(2)), 2.04);
  });

  test("Fanta Uva Lata = 1 componente ≈ R$ 2,26 e CMV 21,52% a 10,50", () => {
    const f = acha("Fanta Uva Lata", "Bebidas");
    assert.ok(f);
    assert.equal(f.n_comp, 1);
    assert.equal(Number(f.custo_reconstruido.toFixed(2)), 2.26);
    assert.equal(Number(cmvPct(f.custo_reconstruido, 10.5).toFixed(2)), 21.52);
  });

  test("Sanduíche Frango Empanado 15cm inclui pão e embalagem e custo confere", () => {
    const s = acha("Frango Empanado", "Sanduíches 15 cm");
    assert.ok(s);
    assert.ok(s.n_comp >= 5, "sanduíche com múltiplos componentes");
    const nomes = s.componentes.map((c) => c.insumo_nome.toLowerCase()).join(" | ");
    assert.match(nomes, /pão|pao/, "tem pão");
    assert.match(nomes, /embalagem/, "tem embalagem");
    assert.ok(Math.abs(s.custo_reconstruido - s.custo_planilha) <= 0.02 * s.custo_planilha);
  });

  test("margem bruta do Cookie a R$ 7,00", () => {
    const c = acha("COOKIE CHOCOLATE DOUBLE", "Cookies, Chips e Brownies");
    const m = margem(c.custo_reconstruido, 7);
    assert.ok(Math.abs(m.reais - (7 - c.custo_reconstruido)) < 1e-9);
    assert.ok(m.pct > 70 && m.pct < 72);
  });

  test("base de insumos tem categorias e unidades válidas", () => {
    const cats = new Set(data.insumos.map((i) => i.categoria));
    for (const c of cats) assert.match(c, /^(proteina|queijo|molho|pao|vegetal|bebida|embalagem|doce|chips|outro)$/);
    const unis = new Set(data.insumos.map((i) => i.unidade));
    for (const u of unis) assert.match(u, /^(un|g|kg|ml|l)$/);
  });
});
