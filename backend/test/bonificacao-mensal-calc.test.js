// Testes D, E, G, K do item 76 — camada de cálculo pura da Bonificação
// Mensal (bonificacaoMensal.calc.js). Sem rede.
// Rodar: node --test test/bonificacao-mensal-calc.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  percentualDerivado, mixDoDia, validarPercentualCruzado, detectarInversaoRelatorios,
  faturamentoAcumulado, mixMensalPonderado, mediaDiaria, somaValida, projecaoFaturamento,
  ritmoNecessario, participacaoLoja, mesmaUnidadeVisio, statusDia, STATUS_DIA_BONIFICACAO, diasDoMes,
} from "../src/modules/bonificacao-mensal/bonificacaoMensal.calc.js";

const perto = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
describe("percentualDerivado — null ≠ 0 (item 22)", () => {
  test("calcula normalmente", () => assert.ok(perto(percentualDerivado(56, 132), 42.424242, 1e-4)));
  test("valor null -> null, nunca 0", () => assert.equal(percentualDerivado(null, 132), null));
  test("base 0 ou null -> null", () => {
    assert.equal(percentualDerivado(5, 0), null);
    assert.equal(percentualDerivado(5, null), null);
  });
});

// ---------------------------------------------------------------------------
describe("Teste D — detecção de PDFs invertidos", () => {
  const geral = { faturamento: 9845.09, ppd: 168, sandwichesSalads: 307, beverages: 85, additions: 51, miscellaneous: 34 };
  const loja = { faturamento: 3893.15, ppd: 73, sandwichesSalads: 132, beverages: 56, additions: 38, miscellaneous: 19 };

  test("relatórios consistentes (Geral >= Loja) não disparam alerta", () => {
    const r = detectarInversaoRelatorios(geral, loja);
    assert.equal(r.invertido, false);
    assert.deepEqual(r.violacoes, []);
  });

  test("relatórios invertidos (Loja > Geral) são detectados", () => {
    const r = detectarInversaoRelatorios(loja, geral); // passa loja como se fosse "geral"
    assert.equal(r.invertido, true);
    assert.ok(r.violacoes.some((v) => v.campo === "faturamento"));
    assert.ok(r.violacoes.some((v) => v.campo === "ppd"));
  });

  test("não exige igualdade, só Geral >= Loja (item 68)", () => {
    const r = detectarInversaoRelatorios(geral, geral); // valores iguais nos dois
    assert.equal(r.invertido, false);
  });
});

// ---------------------------------------------------------------------------
describe("Teste E — validação de unidade (item 16, CRÍTICA)", () => {
  test("nomes com token distintivo em comum batem (sistema e Visio nunca são idênticos)", () => {
    assert.equal(mesmaUnidadeVisio("Subway Saci — Matriz", "Subway Teresina Saci"), true);
  });
  test("unidades genuinamente diferentes são recusadas", () => {
    assert.equal(mesmaUnidadeVisio("Subway Saci — Matriz", "Subway North Shopping"), false);
    assert.equal(mesmaUnidadeVisio("Loja Florianópolis-SC 1", "Subway Teresina Saci"), false);
  });
  test("sem nome suficiente para comparar -> null (não bloqueia nem confirma sozinho)", () => {
    assert.equal(mesmaUnidadeVisio(null, "Subway Teresina Saci"), null);
    assert.equal(mesmaUnidadeVisio("Subway Saci — Matriz", null), null);
  });
});

// ---------------------------------------------------------------------------
describe("Teste G — dados ausentes nunca viram zero", () => {
  test("faturamentoAcumulado sem nenhum lançamento válido -> null, não 0", () => {
    assert.equal(faturamentoAcumulado([{ faturamentoGeral: null }, { faturamentoGeral: null }]), null);
  });
  test("mediaDiaria ignora nulls, não os trata como 0", () => {
    assert.ok(perto(mediaDiaria([10, null, 20, undefined]), 15));
    assert.equal(mediaDiaria([null, null]), null);
  });
  test("somaValida (Pesquisas/NPS) ignora nulls e soma só o que foi informado", () => {
    assert.equal(somaValida([5, null, 10]), 15);
    assert.equal(somaValida([null, undefined]), null);
  });
  test("statusDia: dia sem lançamento no passado é PENDENTE, não fica com valores zerados", () => {
    assert.equal(statusDia({ lancamento: null, dataIso: "2026-08-05", hojeIso: "2026-08-10" }), STATUS_DIA_BONIFICACAO.PENDENTE);
  });
  test("statusDia: dia futuro é FUTURO mesmo sem lançamento", () => {
    assert.equal(statusDia({ lancamento: null, dataIso: "2026-08-15", hojeIso: "2026-08-10" }), STATUS_DIA_BONIFICACAO.FUTURO);
  });
  test("statusDia: sem_operacao é status próprio, não vira PENDENTE nem 0", () => {
    assert.equal(statusDia({ lancamento: { semOperacao: true }, dataIso: "2026-08-05", hojeIso: "2026-08-10" }), STATUS_DIA_BONIFICACAO.SEM_OPERACAO);
  });
});

// ---------------------------------------------------------------------------
describe("Teste K — mix mensal PONDERADO (item 44-45), nunca média simples", () => {
  test("exemplo do item 45: 10/5 (50%) + 100/20 (20%) = 22,7% real, não 35% (média simples)", () => {
    const lancamentos = [
      { qtdSanduichesLoja: 10, qtdBebidasLoja: 5, qtdAdicionaisLoja: 0, qtdDiversosLoja: 0 },
      { qtdSanduichesLoja: 100, qtdBebidasLoja: 20, qtdAdicionaisLoja: 0, qtdDiversosLoja: 0 },
    ];
    const r = mixMensalPonderado(lancamentos);
    assert.ok(perto(r.bebidas, 22.727272727, 1e-6));
    assert.notEqual(Math.round(r.bebidas), 35); // média simples daria 35% — tem que ser diferente
  });
  test("dias sem qtdSanduichesLoja (não informado) ficam de fora da soma", () => {
    const r = mixMensalPonderado([
      { qtdSanduichesLoja: 132, qtdBebidasLoja: 56, qtdAdicionaisLoja: 38, qtdDiversosLoja: 19 },
      { qtdSanduichesLoja: null, qtdBebidasLoja: null, qtdAdicionaisLoja: null, qtdDiversosLoja: null },
    ]);
    assert.equal(r.diasComDados, 1);
    assert.ok(perto(r.bebidas, 42.424242, 1e-4));
  });
  test("mês sem nenhum dado -> null, não 0", () => {
    const r = mixMensalPonderado([]);
    assert.equal(r.bebidas, null);
  });
});

// ---------------------------------------------------------------------------
describe("validação cruzada (item 11)", () => {
  test("diferença pequena não é divergência", () => {
    const r = validarPercentualCruzado(42.4, 42.42424, 1.5);
    assert.equal(r.divergente, false);
  });
  test("diferença grande é sinalizada", () => {
    const r = validarPercentualCruzado(42.4, 30, 1.5);
    assert.equal(r.divergente, true);
    assert.ok(r.diferenca > 1.5);
  });
});

// ---------------------------------------------------------------------------
describe("projeção de faturamento (itens 41-43)", () => {
  test("exclui dias sem_operacao e pendentes da média-base", () => {
    // agosto/2026: 31 dias. Dias 1-3 com faturamento, dia 4 sem_operacao, dia 5 pendente (sem lançamento), hoje = dia 5.
    const lancamentos = [
      { data: "2026-08-01", faturamentoGeral: 9000 },
      { data: "2026-08-02", faturamentoGeral: 10000 },
      { data: "2026-08-03", faturamentoGeral: 11000 },
      { data: "2026-08-04", faturamentoGeral: null, semOperacao: true },
    ];
    const r = projecaoFaturamento({ lancamentos, ano: 2026, mes: 8, hojeIso: "2026-08-05" });
    assert.equal(r.diasValidos, 3);
    assert.equal(r.diasSemOperacao, 1);
    assert.equal(r.diasPendentes, 1); // dia 5 (hoje, sem lançamento ainda)
    assert.ok(perto(r.acumulado, 30000));
    assert.ok(perto(r.mediaDiariaValida, 10000));
    assert.equal(r.diasRestantes, diasDoMes(2026, 8).length - 5); // dias após hoje
    assert.ok(perto(r.projecao, 30000 + 10000 * r.diasRestantes));
  });

  test("ritmoNecessario = faltante / dias restantes", () => {
    assert.ok(perto(ritmoNecessario(130200, 12), 10850));
    assert.equal(ritmoNecessario(null, 12), null);
    assert.equal(ritmoNecessario(100, 0), null);
  });
});

describe("participação do balcão (item 54) — só dado disponível, sem regra de meta", () => {
  test("calcula o percentual sem impor nenhuma faixa", () => {
    assert.ok(perto(participacaoLoja(3893.15, 9845.09), 39.54, 0.01));
  });
});
