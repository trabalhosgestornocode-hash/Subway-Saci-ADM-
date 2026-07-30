// Testes da camada de cálculo do CMV (insumos.calc.js) — puros, sem rede.
// Rodar: node --test test/insumos-calc.test.js
//
// Protegem exatamente os exemplos do documento de especificação: custo por
// unidade, conversões kg->g / l->ml, custo proporcional, soma da ficha, CMV,
// margem e as validações (quantidade zero, preço negativo, unidade incompatível).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  converterQuantidade, unidadesCompativeis, unidadeValida,
  custoUnitario, custoComponente, custoProduto, cmvPct, margem, variacaoPct,
  statusFicha, validarCompraInsumo, validarComponenteFicha,
} from "../src/modules/insumos/insumos.calc.js";

const perto = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
describe("conversão de unidades", () => {
  test("1 kg = 1000 g", () => assert.equal(converterQuantidade(1, "kg", "g"), 1000));
  test("76 g = 0,076 kg", () => assert.ok(perto(converterQuantidade(76, "g", "kg"), 0.076)));
  test("1 litro = 1000 ml", () => assert.equal(converterQuantidade(1, "l", "ml"), 1000));
  test("500 ml = 0,5 l", () => assert.ok(perto(converterQuantidade(500, "ml", "l"), 0.5)));
  test("mesma unidade não altera", () => assert.equal(converterQuantidade(3, "un", "un"), 3));

  test("unidades incompatíveis lançam (g -> ml)", () => {
    assert.throws(() => converterQuantidade(10, "g", "ml"), /incompat/i);
  });
  test("compatibilidade: massa com massa, volume com volume", () => {
    assert.equal(unidadesCompativeis("g", "kg"), true);
    assert.equal(unidadesCompativeis("ml", "l"), true);
    assert.equal(unidadesCompativeis("g", "l"), false);
    assert.equal(unidadesCompativeis("un", "g"), false);
  });
  test("unidadeValida reconhece as unidades da 1ª versão", () => {
    for (const u of ["un", "g", "kg", "ml", "l"]) assert.equal(unidadeValida(u), true);
    assert.equal(unidadeValida("caixa"), false); // forma de compra NÃO é unidade
  });
});

// ---------------------------------------------------------------------------
describe("custo por unidade-base do insumo", () => {
  test("R$ 47,52 / 24 un = R$ 1,98/un", () => {
    assert.ok(perto(custoUnitario({ precoCompra: 47.52, quantidadeEmbalagem: 24 }), 1.98));
  });
  test("R$ 120,00 / 4 kg = R$ 30,00/kg", () => {
    assert.equal(custoUnitario({ precoCompra: 120, quantidadeEmbalagem: 4 }), 30);
  });
  test("fator de correção multiplica o custo", () => {
    assert.ok(perto(custoUnitario({ precoCompra: 10, quantidadeEmbalagem: 1, fatorCorrecao: 1.25 }), 12.5));
  });
  test("sem dados suficientes devolve null (não inventa custo)", () => {
    assert.equal(custoUnitario({ precoCompra: 10, quantidadeEmbalagem: 0 }), null);
    assert.equal(custoUnitario({ precoCompra: null, quantidadeEmbalagem: 4 }), null);
  });
});

// ---------------------------------------------------------------------------
describe("custo proporcional do componente", () => {
  test("frango R$ 30/kg × 76 g = R$ 2,28", () => {
    const c = custoComponente({ custoUnitarioBase: 30, quantidade: 76, unidadeUso: "g", unidadeBase: "kg" });
    assert.ok(perto(c, 2.28));
  });
  test("cookie pronto R$ 1,98/un × 1 un = R$ 1,98", () => {
    assert.equal(custoComponente({ custoUnitarioBase: 1.98, quantidade: 1, unidadeUso: "un", unidadeBase: "un" }), 1.98);
  });
  test("saco de cookie R$ 0,06/un × 1 un = R$ 0,06", () => {
    assert.ok(perto(custoComponente({ custoUnitarioBase: 0.06, quantidade: 1, unidadeUso: "un", unidadeBase: "un" }), 0.06));
  });
});

// ---------------------------------------------------------------------------
describe("custo do produto (soma da ficha)", () => {
  test("cookie = 1,98 + 0,06 = 2,04", () => {
    const total = custoProduto([{ custoTotal: 1.98 }, { custoTotal: 0.06 }]);
    assert.ok(perto(total, 2.04));
  });
  test("componentes inativos não entram na soma", () => {
    const total = custoProduto([{ custoTotal: 1.98 }, { custoTotal: 5, ativo: false }]);
    assert.ok(perto(total, 1.98));
  });
  test("recálculo: saco 0,06 -> 0,08 leva o cookie de 2,04 para 2,06", () => {
    const antes = custoProduto([{ custoTotal: 1.98 }, { custoTotal: 0.06 }]);
    const depois = custoProduto([{ custoTotal: 1.98 }, { custoTotal: 0.08 }]);
    assert.ok(perto(antes, 2.04));
    assert.ok(perto(depois, 2.06));
  });
});

// ---------------------------------------------------------------------------
describe("CMV e margem", () => {
  test("Fanta: 2,26 / 10,50 = 21,52%", () => {
    assert.equal(Number(cmvPct(2.26, 10.5).toFixed(2)), 21.52);
  });
  test("Cookie: 2,04 / 8,00 = 25,50%", () => {
    assert.equal(Number(cmvPct(2.04, 8).toFixed(2)), 25.5);
  });
  test("sem preço (0) => CMV null, nunca 0/100 falso", () => {
    assert.equal(cmvPct(2.04, 0), null);
    assert.equal(cmvPct(2.04, null), null);
  });
  test("margem bruta em reais e percentual", () => {
    const m = margem(2.04, 8);
    assert.ok(perto(m.reais, 5.96));
    assert.equal(Number(m.pct.toFixed(2)), 74.5);
  });
  test("margem sem preço => nulls", () => {
    assert.deepEqual(margem(2.04, 0), { reais: null, pct: null });
  });
});

// ---------------------------------------------------------------------------
describe("variação percentual (histórico)", () => {
  test("de 0,06 para 0,08 ~ +33,33%", () => {
    assert.equal(Number(variacaoPct(0.06, 0.08).toFixed(2)), 33.33);
  });
  test("sem base anterior válida => null", () => {
    assert.equal(variacaoPct(0, 0.08), null);
    assert.equal(variacaoPct(null, 0.08), null);
  });
});

// ---------------------------------------------------------------------------
describe("status da ficha (nunca CMV falso)", () => {
  test("ficha vazia => sem componentes", () => {
    assert.equal(statusFicha({ componentes: [] }).chave, "sem_componentes");
  });
  test("insumo sem custo marca a ficha como incompleta", () => {
    const s = statusFicha({ componentes: [{ custoUnitarioBase: 1.98 }, { custoUnitarioBase: null }] });
    assert.equal(s.chave, "insumo_sem_custo");
    assert.equal(s.ok, false);
  });
  test("insumo inativo é sinalizado", () => {
    const s = statusFicha({ componentes: [{ custoUnitarioBase: 1, insumoAtivo: false }] });
    assert.equal(s.chave, "insumo_inativo");
  });
  test("tudo certo + preço => completa", () => {
    const s = statusFicha({ componentes: [{ custoUnitarioBase: 1.98 }], temPreco: true });
    assert.equal(s.chave, "completa");
    assert.equal(s.ok, true);
  });
  test("sem preço de venda => sinaliza sem_preco", () => {
    const s = statusFicha({ componentes: [{ custoUnitarioBase: 1.98 }], temPreco: false });
    assert.equal(s.chave, "sem_preco");
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Referência da PLANILHA (Ficha Técnica - Crescer com Delivery). Trava as
// fórmulas de negócio reais: custo por unidade-base (preço ÷ conteúdo),
// composição da ficha (embalagem é insumo) e CMV.
describe("referência da planilha", () => {
  test("Cookie = cookie pronto (238,14/120) + saco (29,48/500) ≈ 2,04", () => {
    const cookiePronto = custoUnitario({ precoCompra: 238.14, quantidadeEmbalagem: 120 }); // 1,9845
    const saco = custoUnitario({ precoCompra: 29.48, quantidadeEmbalagem: 500 });          // 0,05896
    const c1 = custoComponente({ custoUnitarioBase: cookiePronto, quantidade: 1, unidadeUso: "un", unidadeBase: "un" });
    const c2 = custoComponente({ custoUnitarioBase: saco, quantidade: 1, unidadeUso: "un", unidadeBase: "un" });
    const total = custoProduto([{ custoTotal: c1 }, { custoTotal: c2 }]);
    assert.equal(Number(total.toFixed(2)), 2.04);
  });

  test("Fanta Uva lata (13,56/6 = 2,26) tem CMV 21,52% a R$ 10,50", () => {
    const custo = custoUnitario({ precoCompra: 13.56, quantidadeEmbalagem: 6 });
    assert.equal(Number(custo.toFixed(2)), 2.26);
    assert.equal(Number(cmvPct(custo, 10.5).toFixed(2)), 21.52);
  });

  test("Sanduíche de Frango = pão + 76 g de frango + embalagem (soma sem arredondar cedo)", () => {
    const pao = custoUnitario({ precoCompra: 201.03, quantidadeEmbalagem: 140 });   // 1,4359/un
    const frangoKg = custoUnitario({ precoCompra: 121.42, quantidadeEmbalagem: 4 }); // 30,355/kg
    const emb = 0.78649;
    const cPao = custoComponente({ custoUnitarioBase: pao, quantidade: 1, unidadeUso: "un", unidadeBase: "un" });
    const cFrango = custoComponente({ custoUnitarioBase: frangoKg, quantidade: 76, unidadeUso: "g", unidadeBase: "kg" });
    const cEmb = custoComponente({ custoUnitarioBase: emb, quantidade: 1, unidadeUso: "un", unidadeBase: "un" });
    const total = custoProduto([{ custoTotal: cPao }, { custoTotal: cFrango }, { custoTotal: cEmb }]);
    assert.ok(perto(cFrango, 2.30698, 1e-4)); // 30,355 × 0,076
    assert.equal(Number(total.toFixed(2)), 4.53);
  });
});

describe("validações de consistência", () => {
  test("preço negativo é barrado", () => {
    assert.match(validarCompraInsumo({ preco: -1 }), /negativo/i);
  });
  test("preço zero é barrado quando não permitido", () => {
    assert.match(validarCompraInsumo({ preco: 0, permitirPrecoZero: false }), /zero/i);
    assert.equal(validarCompraInsumo({ preco: 0, permitirPrecoZero: true }), null);
  });
  test("quantidade da embalagem <= 0 é barrada", () => {
    assert.match(validarCompraInsumo({ quantidadeEmbalagem: 0 }), /maior que zero/i);
  });
  test("compra válida não retorna erro", () => {
    assert.equal(validarCompraInsumo({ preco: 47.52, quantidadeEmbalagem: 24, unidadeBase: "un" }), null);
  });

  test("quantidade da ficha <= 0 é barrada", () => {
    assert.match(validarComponenteFicha({ quantidade: 0, unidadeUso: "g", unidadeBase: "kg" }), /maior que zero/i);
  });
  test("unidade incompatível na ficha é barrada", () => {
    assert.match(validarComponenteFicha({ quantidade: 10, unidadeUso: "ml", unidadeBase: "kg" }), /incompat/i);
  });
  test("componente de ficha válido não retorna erro", () => {
    assert.equal(validarComponenteFicha({ quantidade: 76, unidadeUso: "g", unidadeBase: "kg" }), null);
  });
});
