// Testes H, I, J do item 76 — motor de bonificação (bonificacaoMensal.metas.js).
// Sem rede. Rodar: node --test test/bonificacao-mensal-metas.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBonusMetric, resolverMetaVigente, totalBonificacao, metaTemBonusDefinido, STATUS_METRICA,
} from "../src/modules/bonificacao-mensal/bonificacaoMensal.metas.js";

// Regra corrigida do item 34 (a planilha original tinha um bug na 3ª faixa).
const PESQUISAS_META = {
  indicador: "pesquisas", direcao: "higher_is_better",
  faixas: [
    { ordem: 1, tipo: "intervalo", valorMin: 0, valorMax: 89, bonus: 0 },
    { ordem: 2, tipo: "limite_minimo", valorMin: 90, valorMax: null, bonus: 50 },
    { ordem: 3, tipo: "limite_minimo", valorMin: 120, valorMax: null, bonus: 100 },
  ],
};

describe("Teste H — 95 pesquisas", () => {
  test("bônus é R$ 50 (faixa 90+), não a soma de faixas", () => {
    const r = evaluateBonusMetric(95, PESQUISAS_META);
    assert.equal(r.bonusAtual, 50);
    assert.equal(r.status, STATUS_METRICA.DENTRO_DA_META);
  });
});

describe("Teste I — 125 pesquisas", () => {
  test("bônus é R$ 100 (faixa 120+), NUNCA R$ 150 (soma das faixas)", () => {
    const r = evaluateBonusMetric(125, PESQUISAS_META);
    assert.equal(r.bonusAtual, 100);
    assert.notEqual(r.bonusAtual, 150);
    assert.equal(r.status, STATUS_METRICA.META_MAXIMA);
  });
});

describe("Teste J — melhor faixa atingida, nunca soma de faixas do mesmo indicador", () => {
  const FATURAMENTO_META = {
    indicador: "faturamento", direcao: "higher_is_better",
    faixas: [
      { ordem: 1, tipo: "limite_minimo", valorMin: 334193.85, valorMax: null, bonus: 100 },
      { ordem: 2, tipo: "limite_minimo", valorMin: 350903.54, valorMax: null, bonus: 150 },
      { ordem: 3, tipo: "limite_minimo", valorMin: 367613.24, valorMax: null, bonus: 200 },
    ],
  };
  test("faturamento na faixa 3 rende só R$ 200, não 100+150+200=450", () => {
    const r = evaluateBonusMetric(400000, FATURAMENTO_META);
    assert.equal(r.bonusAtual, 200);
    assert.notEqual(r.bonusAtual, 450);
    assert.equal(r.faixaAtual.ordem, 3);
  });
  test("faturamento na faixa 1 rende só R$ 100", () => {
    const r = evaluateBonusMetric(340000, FATURAMENTO_META);
    assert.equal(r.bonusAtual, 100);
  });
  test("faturamento abaixo de todas as faixas -> meta não atingida, bônus null (não 0)", () => {
    const r = evaluateBonusMetric(100000, FATURAMENTO_META);
    assert.equal(r.status, STATUS_METRICA.META_NAO_ATINGIDA);
    assert.equal(r.bonusAtual, null);
    assert.equal(r.proximaFaixa.ordem, 1);
    assert.ok(r.faltante > 0);
  });
});

describe("CMV — faixas descendentes/intervalos (item 36)", () => {
  const CMV_META = {
    indicador: "cmv", direcao: "lower_is_better",
    faixas: [
      { ordem: 1, tipo: "intervalo", valorMin: 29.0, valorMax: 30.0, bonus: 100 },
      { ordem: 2, tipo: "intervalo", valorMin: 28.1, valorMax: 28.9, bonus: 150 },
      { ordem: 3, tipo: "limite_maximo", valorMin: null, valorMax: 28.0, bonus: 200 },
    ],
  };
  test("CMV baixo (27%) atinge a MELHOR faixa (bônus máximo)", () => {
    const r = evaluateBonusMetric(27, CMV_META);
    assert.equal(r.bonusAtual, 200);
    assert.equal(r.status, STATUS_METRICA.META_MAXIMA);
  });
  test("CMV alto (32%) não atinge nenhuma faixa", () => {
    const r = evaluateBonusMetric(32, CMV_META);
    assert.equal(r.bonusAtual, null);
    assert.equal(r.status, STATUS_METRICA.META_NAO_ATINGIDA);
  });
  test("CMV no meio (29,5%) atinge a faixa 1, não a máxima", () => {
    const r = evaluateBonusMetric(29.5, CMV_META);
    assert.equal(r.bonusAtual, 100);
  });
});

describe("indicador sem valor de bonificação definido (Avaliação/Cancelamentos/Chamados)", () => {
  const AVALIACAO_META = { indicador: "avaliacao_ifood", direcao: "higher_is_better", faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 4.7, valorMax: null, bonus: null }] };
  test("meta com bonus=null nunca aparece como se valesse R$ 0 (item 60)", () => {
    const r = evaluateBonusMetric(4.8, AVALIACAO_META);
    assert.equal(r.faixaAtual.bonus, null);
    assert.equal(r.bonusAtual, null);
    assert.equal(metaTemBonusDefinido(AVALIACAO_META), false);
  });
});

describe("dados ausentes vs meta perdida (item 60)", () => {
  test("valor null -> status sem_dados, nunca meta_nao_atingida", () => {
    const meta = { indicador: "cmv", direcao: "lower_is_better", faixas: [{ ordem: 1, tipo: "limite_maximo", valorMin: null, valorMax: 28, bonus: 200 }] };
    const r = evaluateBonusMetric(null, meta);
    assert.equal(r.status, STATUS_METRICA.SEM_DADOS);
    assert.notEqual(r.status, STATUS_METRICA.META_NAO_ATINGIDA);
  });
});

describe("resolverMetaVigente — histórico não muda quando a meta futura é editada (item 31)", () => {
  const metas = [
    { indicador: "faturamento", validFrom: "2026-08-01", validUntil: "2026-08-31" },
    { indicador: "faturamento", validFrom: "2026-09-01", validUntil: null },
  ];
  test("agosto usa a meta de agosto", () => {
    assert.equal(resolverMetaVigente(metas, "2026-08-15").validFrom, "2026-08-01");
  });
  test("setembro usa a meta de setembro (a mais recente aplicável)", () => {
    assert.equal(resolverMetaVigente(metas, "2026-09-15").validFrom, "2026-09-01");
  });
  test("sem meta vigente na data -> null", () => {
    assert.equal(resolverMetaVigente(metas, "2026-01-01"), null);
  });
});

describe("totalBonificacao — soma só a melhor faixa de CADA indicador", () => {
  test("indicadores diferentes somam; sem-regra e sem-dados não entram", () => {
    const resultados = {
      faturamento: evaluateBonusMetric(400000, { indicador: "faturamento", direcao: "higher_is_better", faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 300000, valorMax: null, bonus: 150 }] }),
      pesquisas: evaluateBonusMetric(125, PESQUISAS_META),
      avaliacao_ifood: evaluateBonusMetric(4.8, { indicador: "avaliacao_ifood", direcao: "higher_is_better", faixas: [{ ordem: 1, tipo: "limite_minimo", valorMin: 4.7, valorMax: null, bonus: null }] }),
      cmv: evaluateBonusMetric(null, { indicador: "cmv", direcao: "lower_is_better", faixas: [{ ordem: 1, tipo: "limite_maximo", valorMin: null, valorMax: 28, bonus: 200 }] }),
    };
    const r = totalBonificacao(resultados);
    assert.equal(r.atual, 250); // 150 (faturamento) + 100 (pesquisas)
    assert.equal(r.metasAtingidas, 2);
    assert.equal(r.metasComRegra, 3); // avaliacao_ifood não conta (sem regra de bônus); cmv conta mas sem dados
  });
});
