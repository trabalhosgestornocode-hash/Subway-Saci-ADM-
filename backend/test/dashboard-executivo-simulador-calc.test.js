// Testes das fórmulas puras do Simulador de Preço Balcão x iFood, auditadas
// e corrigidas em 19/08 (margem do iFood agora desconta Taxas e Comissões +
// Serviços e Promoções; referência do modelo logístico calculada ao vivo,
// nunca lida de uma linha `total_deducoes` separada). Sem rede — mesmo
// espírito de dashboard-executivo-calc.test.js.
// Rodar: node --test test/dashboard-executivo-simulador-calc.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  margemEstimadaIfood, referenciaModeloPct, limiteCombinadoPct, situacaoDiferencaPreco,
} from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";

const perto = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
describe("margemEstimadaIfood — caso auditado (Churrasco 15cm, tabela Z4)", () => {
  const base = { preco: 35, custo: 6.07, taxaComissoesPct: 19.9, servicosPromocoesPct: 3.9 };

  test("taxas e serviços em R$, receita após deduções consideradas e margem batem com a auditoria", () => {
    const r = margemEstimadaIfood(base);
    assert.ok(perto(r.taxaComissoesReais, 6.965, 0.001));
    assert.ok(perto(r.servicosPromocoesReais, 1.365, 0.001));
    assert.ok(perto(r.deducoesConsideradasPct, 23.8, 0.001));
    assert.ok(perto(r.receitaAposDeducoesConsideradas, 26.67, 0.01));
    assert.ok(perto(r.margemEstimada, 20.6, 0.01));
    assert.ok(perto(r.margemEstimadaPct, 58.86, 0.01));
  });

  test("margem cai em relação à fórmula antiga (só Taxas e Comissões) — R$ 20,60 < R$ 21,97", () => {
    const r = margemEstimadaIfood(base);
    const margemAntiga = (base.preco - (base.preco * base.taxaComissoesPct) / 100) - base.custo;
    assert.ok(perto(margemAntiga, 21.965, 0.01)); // R$ 21,97 arredondado — a margem exibida antes da correção
    assert.ok(r.margemEstimada < margemAntiga);
  });
});

describe("margemEstimadaIfood — ausência de dado nunca vira 0", () => {
  test("Taxas e Comissões ainda não apurada → margem inteira null, nunca calculada com taxa=0", () => {
    const r = margemEstimadaIfood({ preco: 35, custo: 6.07, taxaComissoesPct: null, servicosPromocoesPct: 3.9 });
    assert.equal(r.margemEstimada, null);
    assert.equal(r.margemEstimadaPct, null);
    assert.equal(r.receitaAposDeducoesConsideradas, null);
  });

  test("Serviços e Promoções ainda não apurados → margem inteira null (não soma só a Taxa)", () => {
    const r = margemEstimadaIfood({ preco: 35, custo: 6.07, taxaComissoesPct: 19.9, servicosPromocoesPct: null });
    assert.equal(r.margemEstimada, null);
    assert.equal(r.servicosPromocoesReais, null);
  });

  test("Serviços e Promoções apurado como 0 de verdade (mês sem campanha) é DIFERENTE de null — calcula normalmente", () => {
    const r = margemEstimadaIfood({ preco: 35, custo: 6.07, taxaComissoesPct: 19.9, servicosPromocoesPct: 0 });
    assert.notEqual(r.margemEstimada, null);
    assert.ok(perto(r.servicosPromocoesReais, 0, 1e-9));
    assert.ok(perto(r.margemEstimada, 21.965, 0.01));
  });
});

// ---------------------------------------------------------------------------
describe("referenciaModeloPct — soma das metas ideais, nunca lida de linha separada", () => {
  test("Full Service: 20,5% + 10,0% = 30,5% (bate com metas_indicadores seedadas na migration 023)", () => {
    assert.ok(perto(referenciaModeloPct({ metaTaxasComissoes: 20.5, metaServicosPromocoes: 10.0 }), 30.5, 1e-9));
  });

  test("Marketplace: 13,0% + 5,0% = 18,0% (migration 024) — muda automaticamente com o modelo", () => {
    assert.ok(perto(referenciaModeloPct({ metaTaxasComissoes: 13.0, metaServicosPromocoes: 5.0 }), 18.0, 1e-9));
  });

  test("se qualquer uma das duas metas não estiver configurada, a referência é null (nunca soma parcial)", () => {
    assert.equal(referenciaModeloPct({ metaTaxasComissoes: null, metaServicosPromocoes: 10.0 }), null);
    assert.equal(referenciaModeloPct({ metaTaxasComissoes: 20.5, metaServicosPromocoes: null }), null);
    assert.equal(referenciaModeloPct({ metaTaxasComissoes: null, metaServicosPromocoes: null }), null);
  });

  test("se a meta de Taxas e Comissões mudar na configuração, a referência muda junto — nunca precisa editar duas linhas", () => {
    const antes = referenciaModeloPct({ metaTaxasComissoes: 20.5, metaServicosPromocoes: 10.0 });
    const depois = referenciaModeloPct({ metaTaxasComissoes: 22.0, metaServicosPromocoes: 10.0 });
    assert.ok(perto(antes, 30.5, 1e-9));
    assert.ok(perto(depois, 32.0, 1e-9));
  });
});

// ---------------------------------------------------------------------------
describe("limiteCombinadoPct — soma dos LIMITES (teto real), não das metas ideais", () => {
  test("exemplo do pedido: Taxas 13%|13% + Serviços 5%|7% → meta combinada 18%, limite combinado 20%", () => {
    const meta = referenciaModeloPct({ metaTaxasComissoes: 13, metaServicosPromocoes: 5 });
    const limite = limiteCombinadoPct({ limiteTaxasComissoes: 13, limiteServicosPromocoes: 7 });
    assert.ok(perto(meta, 18, 1e-9));
    assert.ok(perto(limite, 20, 1e-9));
  });

  test("21,2% de deduções reais → 3,2 p.p. acima da meta (18%) e 1,2 p.p. acima do limite (20%)", () => {
    const vsMeta = situacaoDiferencaPreco(21.2, 18);
    const vsLimite = situacaoDiferencaPreco(21.2, 20);
    assert.equal(vsMeta.chave, "acima");
    assert.ok(perto(vsMeta.diferencaPp, 3.2, 0.01));
    assert.equal(vsLimite.chave, "acima");
    assert.ok(perto(vsLimite.diferencaPp, 1.2, 0.01));
  });

  test("se qualquer um dos dois limites não estiver configurado, o combinado é null", () => {
    assert.equal(limiteCombinadoPct({ limiteTaxasComissoes: null, limiteServicosPromocoes: 7 }), null);
    assert.equal(limiteCombinadoPct({ limiteTaxasComissoes: 13, limiteServicosPromocoes: null }), null);
  });

  test("meta e limite mudam independentemente com a configuração — nunca acoplados", () => {
    // Taxas e Comissões costuma ter meta == limite (sem faixa de atenção);
    // Serviços e Promoções normalmente tem limite > meta (folga configurada).
    const meta = referenciaModeloPct({ metaTaxasComissoes: 20.5, metaServicosPromocoes: 10 });
    const limite = limiteCombinadoPct({ limiteTaxasComissoes: 20.5, limiteServicosPromocoes: 14.5 });
    assert.ok(perto(meta, 30.5, 1e-9));
    assert.ok(perto(limite, 35, 1e-9));
    assert.ok(limite > meta);
  });
});

// ---------------------------------------------------------------------------
describe("situacaoDiferencaPreco — linguagem neutra, nunca dentro/fora do limite", () => {
  test("caso auditado: 31,4% de diferença vs 30,5% de referência → 0,9 p.p. acima", () => {
    const s = situacaoDiferencaPreco(31.4, 30.5);
    assert.equal(s.chave, "acima");
    assert.ok(perto(s.diferencaPp, 0.9, 0.05));
  });

  test("diferença bem abaixo da referência → abaixo (sinal ruim: preço nem cobre o custo do canal)", () => {
    const s = situacaoDiferencaPreco(20, 30.5);
    assert.equal(s.chave, "abaixo");
    assert.ok(s.diferencaPp < 0);
  });

  test("diferença igual à referência → na_referencia, não 'acima'/'abaixo' por ruído de ponto flutuante", () => {
    assert.equal(situacaoDiferencaPreco(30.5, 30.5).chave, "na_referencia");
    assert.equal(situacaoDiferencaPreco(30.52, 30.5).chave, "na_referencia"); // 0,02 p.p. — dentro da tolerância
  });

  test("sem diferença de preço OU sem referência configurada → sem_dados, nunca um p.p. inventado", () => {
    assert.equal(situacaoDiferencaPreco(null, 30.5).chave, "sem_dados");
    assert.equal(situacaoDiferencaPreco(31.4, null).chave, "sem_dados");
    assert.equal(situacaoDiferencaPreco(31.4, null).diferencaPp, null);
  });
});
