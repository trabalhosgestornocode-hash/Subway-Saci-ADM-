// Testes da representação CANÔNICA da ficha técnica oficial (backups/canonico.json).
//
// Protegem contra a regressão que motivou a auditoria: a planilha tem as
// referências de fórmula DESLOCADAS na aba "Sanduíches 15 cm", e o parser antigo
// as seguia — o BMT recebia "Carne Seca" e o Vegetariano recebia frango.
// A composição canônica é montada por RÓTULO, e estes testes travam isso.
//
// Rodar: node --test test/fichas-canonicas.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { converterQuantidade, custoComponente, cmvPct, margem } from "../src/modules/insumos/insumos.calc.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const P = path.join(dir, "..", "..", "database", "ficha-tecnica-canonica.json");
const existe = fs.existsSync(P);
const C = existe ? JSON.parse(fs.readFileSync(P, "utf8")) : { insumos: [], produtos: [], blocos: { recheios: {}, bases: {} } };

const N = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const acha = (aba, nome) => C.produtos.find((p) => p.aba === aba && N(p.nome_planilha) === N(nome));
const nomes = (p) => p.componentes.map((c) => N(c.insumo_nome)).join(" | ");
const temInsumo = (p, frag) => p.componentes.some((c) => N(c.insumo_nome).includes(N(frag)));

describe("ficha canônica", { skip: existe ? false : "backups/canonico.json ausente" }, () => {
  // ------------------------------------------------------------------ ERRO CONHECIDO
  describe("regressão: BMT não pode conter carne seca", () => {
    for (const aba of ["Sanduíches 15 cm", "Sanduíches 30 cm"]) {
      test(`${aba} — BMT`, () => {
        const p = acha(aba, "BMT");
        assert.ok(p, "BMT existe no canônico");
        assert.equal(temInsumo(p, "CARNE SECA"), false, `BMT contém carne seca: ${nomes(p)}`);
        assert.equal(temInsumo(p, "CREAM CHEESE"), false, `BMT contém cream cheese: ${nomes(p)}`);
        // composição oficial vem do rótulo "Dobro recheio BMT" (Base G18+G20+G15/2)
        assert.ok(temInsumo(p, "PEPPERONI"), "BMT tem pepperoni");
        assert.ok(temInsumo(p, "SALAME"), "BMT tem salame");
        assert.ok(temInsumo(p, "PRESUNTO"), "BMT tem presunto");
        assert.equal(p.recheio_rotulo, "Dobro recheio BMT");
      });
    }
    test("o recheio que contém carne seca pertence ao produto Carne Seca", () => {
      const cs = acha("Sanduíches 15 cm", "Carne Seca");
      assert.ok(temInsumo(cs, "CARNE SECA"), "Carne Seca tem carne seca");
      assert.equal(cs.recheio_rotulo, "Dobro de Recheio Carne Seca");
    });
    test("Vegetariano não contém proteína animal", () => {
      for (const aba of ["Sanduíches 15 cm", "Sanduíches 30 cm", "Saladas"]) {
        const v = acha(aba, "Vegetariano");
        if (!v) continue;
        for (const proibido of ["FRANGO", "CARNE", "PRESUNTO", "BACON", "PEPPERONI", "SALAME", "STEAK"]) {
          assert.equal(temInsumo(v, proibido), false, `${aba}/Vegetariano contém ${proibido}: ${nomes(v)}`);
        }
      }
    });
  });

  // ------------------------------------------------------------------ CORRESPONDÊNCIA
  describe("correspondência e distinção de tamanho", () => {
    test("15 cm e 30 cm são produtos distintos e o 30 é o dobro do 15", () => {
      for (const nome of ["BMT", "Presunto", "Churrasco", "Frango Empanado"]) {
        const p15 = acha("Sanduíches 15 cm", nome);
        const p30 = acha("Sanduíches 30 cm", nome);
        assert.ok(p15 && p30, `${nome} existe nos dois tamanhos`);
        assert.notEqual(p15.custo_canonico, p30.custo_canonico, `${nome}: 15cm e 30cm não podem ter o mesmo custo`);
        assert.ok(Math.abs(p30.custo_canonico - p15.custo_canonico * 2) < 0.01, `${nome}: 30cm deve ser 2x o 15cm`);
      }
    });
    test("cada insumo do canônico tem código numérico OU nome único", () => {
      const porNome = new Map();
      for (const i of C.insumos) {
        const k = N(i.nome);
        assert.equal(porNome.has(k), false, `insumo duplicado no canônico: ${i.nome}`);
        porNome.set(k, i);
      }
    });
    test("nenhum produto mistura recheio de outro sabor", () => {
      const pares = [["Carne Seca", "PEPPERONI"], ["BMT", "TERIYAKI"], ["Teriack", "CARNE SECA"], ["Churrasco", "CARNE SECA"]];
      for (const [prod, proibido] of pares) {
        const p = acha("Sanduíches 15 cm", prod);
        if (!p) continue;
        assert.equal(temInsumo(p, proibido), false, `${prod} não pode conter ${proibido}`);
      }
    });
  });

  // ------------------------------------------------------------------ AMOSTRAGEM POR TIPO
  describe("amostragem por tipo de produto", () => {
    test("sanduíche 15 cm inclui pão e embalagem", () => {
      const p = acha("Sanduíches 15 cm", "Frango Empanado");
      assert.ok(temInsumo(p, "PAO") || temInsumo(p, "PÃO"), `sem pão: ${nomes(p)}`);
      assert.ok(temInsumo(p, "EMBALAGEM"), `sem embalagem: ${nomes(p)}`);
      assert.ok(p.componentes.length >= 5);
    });
    test("sanduíche 30 cm inclui pão e embalagem", () => {
      const p = acha("Sanduíches 30 cm", "Churrasco");
      assert.ok(temInsumo(p, "PAO") || temInsumo(p, "PÃO"));
      assert.ok(temInsumo(p, "EMBALAGEM"));
    });
    test("salada usa DOBRO de recheio e inclui descartável", () => {
      const s = acha("Saladas", "Frango Empanado");
      const r = C.blocos.recheios["EMPANADO"];
      const qtdSalada = s.componentes.find((c) => N(c.insumo_nome).includes("EMPANADO"))?.quantidade;
      const qtdRecheio = r.componentes.find((c) => N(c.insumo_nome).includes("EMPANADO"))?.quantidade;
      assert.ok(Math.abs(qtdSalada - qtdRecheio * 2) < 1e-9, "salada = 2x recheio");
      assert.ok(s.componentes.some((c) => c.categoria === "embalagem"), `salada sem descartável: ${nomes(s)}`);
    });
    test("bebida = 1 unidade do item comprado pronto", () => {
      const b = acha("Bebidas", "Fanta Uva Lata");
      assert.equal(b.componentes.length, 1);
      assert.equal(b.componentes[0].quantidade, 1);
      assert.equal(Number(b.custo_canonico.toFixed(2)), 2.26);
      assert.equal(Number(cmvPct(b.custo_canonico, 10.5).toFixed(2)), 21.52);
    });
    test("cookie = cookie pronto + saco de cookie = R$ 2,04", () => {
      const c = acha("Cookies, Chips e Brownies", "COOKIE CHOCOLATE DOUBLE 120UN");
      assert.equal(c.componentes.length, 2);
      assert.ok(temInsumo(c, "COOKIE CRU"), "tem o cookie pronto");
      assert.ok(temInsumo(c, "SACO COOKIE"), "tem o saco (embalagem é insumo)");
      assert.equal(Number(c.custo_canonico.toFixed(2)), 2.04);
    });
    test("adicional tem ao menos um componente e custo > 0", () => {
      const a = acha("Recheios e Adicionais", "Dobro de Bacon");
      assert.ok(a.componentes.length >= 1);
      assert.ok(a.custo_canonico > 0);
    });
  });

  // ------------------------------------------------------------------ CÁLCULOS
  describe("cálculos", () => {
    test("conversões kg->g e l->ml", () => {
      assert.equal(converterQuantidade(1, "kg", "g"), 1000);
      assert.equal(converterQuantidade(1, "l", "ml"), 1000);
      assert.ok(Math.abs(converterQuantidade(76, "g", "kg") - 0.076) < 1e-9);
    });
    test("custo proporcional: R$ 30/kg x 76 g = R$ 2,28", () => {
      const c = custoComponente({ custoUnitarioBase: 30, quantidade: 76, unidadeUso: "g", unidadeBase: "kg" });
      assert.ok(Math.abs(c - 2.28) < 1e-9);
    });
    test("unidade incompatível é rejeitada", () => {
      assert.throws(() => converterQuantidade(10, "g", "ml"), /incompat/i);
    });
    test("custo do produto = soma dos componentes (sem arredondar cedo)", () => {
      for (const p of C.produtos) {
        if (!p.componentes.length) continue;
        const soma = p.componentes.reduce((s, c) => s + c.custo_aplicado, 0);
        assert.ok(Math.abs(soma - p.custo_canonico) < 0.005, `${p.aba}/${p.nome_planilha}: soma ${soma} != ${p.custo_canonico}`);
      }
    });
    test("CMV e margem do BMT 15 cm", () => {
      const p = acha("Sanduíches 15 cm", "BMT");
      const preco = p.preco_venda;
      assert.ok(preco > 0);
      const m = margem(p.custo_canonico, preco);
      assert.ok(Math.abs(m.reais - (preco - p.custo_canonico)) < 1e-9);
      assert.ok(cmvPct(p.custo_canonico, preco) > 0 && cmvPct(p.custo_canonico, preco) < 100);
    });
    test("nenhum componente tem quantidade <= 0", () => {
      for (const p of C.produtos) {
        for (const c of p.componentes) assert.ok(c.quantidade > 0, `${p.nome_planilha}/${c.insumo_nome} qtd=${c.quantidade}`);
      }
    });
  });

  // ------------------------------------------------------------------ INTEGRIDADE DA PLANILHA
  describe("integridade vs planilha", () => {
    test("saladas e os 4 primeiros sanduíches reproduzem o custo exibido na planilha", () => {
      // Estes NÃO são afetados pelo deslocamento — servem de prova de que o
      // algoritmo canônico está certo.
      const intactos = [["Saladas", "Frango Empanado"], ["Saladas", "Teriack"], ["Saladas", "Carne Seca"],
                        ["Sanduíches 15 cm", "Frango Empanado"], ["Sanduíches 15 cm", "Presunto"], ["Sanduíches 15 cm", "Churrasco"]];
      for (const [aba, nome] of intactos) {
        const p = acha(aba, nome);
        assert.ok(Math.abs(p.custo_canonico - p.custo_planilha) < 0.01,
          `${aba}/${nome}: canônico ${p.custo_canonico} != planilha ${p.custo_planilha}`);
      }
    });
    test("os produtos afetados pelo deslocamento DIVERGEM do custo exibido (esperado)", () => {
      for (const nome of ["BMT", "Vegetariano", "Carne Seca", "Teriack"]) {
        const p = acha("Sanduíches 15 cm", nome);
        assert.ok(Math.abs(p.custo_canonico - p.custo_planilha) > 0.01,
          `${nome}: deveria divergir do valor exibido na planilha (fórmula deslocada)`);
      }
    });
  });
});
