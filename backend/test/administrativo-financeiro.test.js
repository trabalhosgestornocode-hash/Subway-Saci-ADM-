// PAINEL ADMINISTRATIVO — motor FINANCEIRO.
//
// O risco que esta suíte existe para impedir: `valor_vendas_ifood` é SNAPSHOT
// ACUMULADO do mês. Somar as linhas de 30 dias infla o faturamento em ordens
// de grandeza. Todo teste aqui protege essa fronteira, mais a separação
// confirmado / provisório aprovada pelo gestor (opção "c": incluir rascunho,
// sinalizando).
//
// PURO: sem I/O. Entram linhas cruas, sai o consolidado.
//
// Rodar: node --test test/administrativo-financeiro.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  faturamentoDaUnidade, somarFaturamento, coberturaDe,
  rankingFaturamento, rankingConformidade, evolucaoDiaria,
  variacao, variacaoPP, diaEquivalenteNoMesAnterior,
} from "../src/modules/administrativo/administrativo.financeiro.js";

/** Linha crua do banco. `acumulado` = valor_vendas_ifood (snapshot do mês). */
const lin = (data, acumulado, over = {}) => ({
  unidade_id: "u1", data_lancamento: data, valor_vendas_ifood: acumulado,
  status: "finalizado", situacao: "normal", origem_lancamento: "diario",
  taxas_comissoes: null, servicos_promocoes: null, taxas_entregadores: null, outras_deducoes: null,
  ...over,
});

// ===========================================================================
// A) snapshot finalizado
// ===========================================================================
describe("A) snapshot finalizado — nada provisório", () => {
  test("total = confirmado, provisorio = 0, incluiProvisorio = false", () => {
    const f = faturamentoDaUnidade([lin("2026-09-01", 1000), lin("2026-09-05", 5000)]);
    assert.equal(f.total, 5000);
    assert.equal(f.confirmado, 5000);
    assert.equal(f.provisorio, 0);
    assert.equal(f.incluiProvisorio, false);
    assert.equal(f.statusSnapshot, "finalizado");
    assert.equal(f.dataSnapshot, "2026-09-05");
  });

  test("sem nenhum lançamento -> total null (não zero: 'ninguém lançou' ≠ 'vendeu 0')", () => {
    const f = faturamentoDaUnidade([]);
    assert.equal(f.total, null);
    assert.equal(f.incluiProvisorio, false);
  });
});

// ===========================================================================
// B) snapshot mais recente em rascunho
// ===========================================================================
describe("B) snapshot mais recente em rascunho — valor entra, sinalizado", () => {
  test("total inclui o rascunho; provisório é só o INCREMENTO sobre o último finalizado", () => {
    const f = faturamentoDaUnidade([
      lin("2026-09-03", 3000),                                  // finalizado
      lin("2026-09-05", 5200, { status: "rascunho" }),          // em edição
    ]);
    assert.equal(f.total, 5200, "o valor disponível não é escondido");
    assert.equal(f.confirmado, 3000, "o piso é o último snapshot finalizado");
    assert.equal(f.provisorio, 2200, "só o incremento é provisório, não o acumulado inteiro");
    assert.equal(f.incluiProvisorio, true);
    assert.equal(f.statusSnapshot, "rascunho");
  });

  test("rascunho sem nenhum finalizado antes -> tudo provisório", () => {
    const f = faturamentoDaUnidade([lin("2026-09-02", 900, { status: "rascunho" })]);
    assert.equal(f.total, 900);
    assert.equal(f.confirmado, 0);
    assert.equal(f.provisorio, 900);
    assert.equal(f.incluiProvisorio, true);
  });

  test("confirmado + provisorio == total (a conta sempre fecha)", () => {
    for (const linhas of [
      [lin("2026-09-03", 3000), lin("2026-09-05", 5200, { status: "rascunho" })],
      [lin("2026-09-02", 900, { status: "rascunho" })],
      [lin("2026-09-05", 5000)],
    ]) {
      const f = faturamentoDaUnidade(linhas);
      assert.equal(f.confirmado + f.provisorio, f.total);
    }
  });
});

// ===========================================================================
// C) empresa com 2 unidades — uma finalizada, uma em rascunho
// ===========================================================================
describe("C) consolidação entre unidades", () => {
  const unidades = [
    { faturamento: faturamentoDaUnidade([lin("2026-09-05", 4000)]) },
    { faturamento: faturamentoDaUnidade([lin("2026-09-03", 1000), lin("2026-09-05", 1800, { status: "rascunho" })]) },
  ];

  test("total = soma das duas; confirmado/provisório separados", () => {
    const s = somarFaturamento(unidades);
    assert.equal(s.total, 5800);
    assert.equal(s.confirmado, 5000);   // 4000 + 1000
    assert.equal(s.provisorio, 800);    // só o incremento da segunda
    assert.equal(s.incluiProvisorio, true);
    assert.equal(s.unidadesComDado, 2);
  });

  test("unidade sem dado não zera o consolidado — é ignorada", () => {
    const s = somarFaturamento([...unidades, { faturamento: faturamentoDaUnidade([]) }]);
    assert.equal(s.total, 5800);
    assert.equal(s.unidadesComDado, 2);
  });

  test("nenhuma unidade com dado -> total null", () => {
    const s = somarFaturamento([{ faturamento: faturamentoDaUnidade([]) }]);
    assert.equal(s.total, null);
    assert.equal(s.unidadesComDado, 0);
  });
});

// ===========================================================================
// D) ranking ordena pelo TOTAL disponível
// ===========================================================================
describe("D) ranking de faturamento", () => {
  const item = (id, nome, total, provisorio = 0, conf = null) => ({
    id, nome, conformidadeMes: conf,
    faturamento: { total, confirmado: total - provisorio, provisorio, incluiProvisorio: provisorio > 0 },
    cobertura: { completos: 5, esperados: 5, taxa: 1 },
  });

  test("ordena por total, mesmo quando parte é provisória", () => {
    const r = rankingFaturamento([
      item("a", "Alfa", 100),
      item("c", "Gama", 300, 250),   // quase tudo provisório, mas é o maior total
      item("b", "Beta", 200),
    ]);
    assert.deepEqual(r.map((x) => x.nome), ["Gama", "Beta", "Alfa"]);
    assert.deepEqual(r.map((x) => x.posicao), [1, 2, 3]);
    assert.equal(r[0].faturamento.provisorio, 250, "a parte provisória viaja junto para a UI sinalizar");
  });

  test("empate resolve por nome (determinístico, sem peso inventado)", () => {
    const r = rankingFaturamento([item("z", "Zulu", 100), item("a", "Alfa", 100)]);
    assert.deepEqual(r.map((x) => x.nome), ["Alfa", "Zulu"]);
  });

  test("item sem faturamento não entra no ranking", () => {
    const r = rankingFaturamento([item("a", "Alfa", 100), { id: "b", nome: "Beta", faturamento: { total: null } }]);
    assert.deepEqual(r.map((x) => x.nome), ["Alfa"]);
  });

  test("limite corta o topo sem reordenar", () => {
    const r = rankingFaturamento([item("a", "Alfa", 100), item("b", "Beta", 300), item("c", "Gama", 200)], { limite: 2 });
    assert.deepEqual(r.map((x) => x.nome), ["Beta", "Gama"]);
  });

  test("a conformidade viaja ao lado do valor, sem virar score misto", () => {
    const r = rankingFaturamento([item("a", "Alfa", 500, 0, 0.61), item("b", "Beta", 400, 0, 0.98)]);
    assert.equal(r[0].nome, "Alfa");
    assert.equal(r[0].conformidadeMes, 0.61, "vende mais, administra pior — os dois visíveis");
    assert.equal(r[1].conformidadeMes, 0.98);
  });
});

describe("ranking de conformidade", () => {
  const item = (id, nome, conf) => ({ id, nome, conformidadeMes: conf, faturamento: { total: 1 }, cobertura: {} });

  test("desc = melhores; asc = maior atenção necessária", () => {
    const itens = [item("a", "Alfa", 0.8), item("b", "Beta", 1), item("c", "Gama", 0.5)];
    assert.deepEqual(rankingConformidade(itens).map((x) => x.nome), ["Beta", "Alfa", "Gama"]);
    assert.deepEqual(rankingConformidade(itens, { ordem: "asc" }).map((x) => x.nome), ["Gama", "Alfa", "Beta"]);
  });

  test("conformidade null fica fora (0% ≠ 'sem dia esperado')", () => {
    assert.deepEqual(rankingConformidade([item("a", "Alfa", null), item("b", "Beta", 0.9)]).map((x) => x.nome), ["Beta"]);
  });
});

// ===========================================================================
// E) cobertura é separada do faturamento
// ===========================================================================
describe("E) cobertura", () => {
  test("cobertura = Σcompletos / Σesperados, independente do valor faturado", () => {
    const c = coberturaDe([
      { conformidade: { completos: 28, esperados: 30 } },
      { conformidade: { completos: 15, esperados: 30 } },
    ]);
    assert.equal(c.completos, 43);
    assert.equal(c.esperados, 60);
    assert.ok(Math.abs(c.taxa - 43 / 60) < 1e-9);
  });

  test("sem dias esperados -> taxa null (não 0%)", () => {
    assert.equal(coberturaDe([{ conformidade: { completos: 0, esperados: 0 } }]).taxa, null);
  });

  test("quem lançou menos dias NÃO é rebaixado no ranking de faturamento", () => {
    const r = rankingFaturamento([
      { id: "a", nome: "Poucos dias", faturamento: { total: 900 }, cobertura: { taxa: 0.3 }, conformidadeMes: 0.3 },
      { id: "b", nome: "Todos os dias", faturamento: { total: 800 }, cobertura: { taxa: 1 }, conformidadeMes: 1 },
    ]);
    assert.equal(r[0].nome, "Poucos dias", "posição é faturamento absoluto");
    assert.equal(r[0].cobertura.taxa, 0.3, "a cobertura vai junto para o gestor julgar");
  });
});

// ===========================================================================
// F) 30 snapshots acumulados — NUNCA somar as linhas
// ===========================================================================
describe("F) o snapshot acumulado nunca é somado", () => {
  // Mês inteiro: o acumulado cresce R$ 1.000/dia. No dia 30 vale 30.000.
  // Somar as 30 linhas daria 465.000 — 15x o valor real.
  const mes = Array.from({ length: 30 }, (_, i) =>
    lin(`2026-09-${String(i + 1).padStart(2, "0")}`, (i + 1) * 1000));

  test("total do mês = último snapshot, não a soma das 30 linhas", () => {
    const f = faturamentoDaUnidade(mes);
    assert.equal(f.total, 30000);
    const somaIngenua = mes.reduce((s, r) => s + r.valor_vendas_ifood, 0);
    assert.equal(somaIngenua, 465000);
    assert.notEqual(f.total, somaIngenua, "a soma ingênua infla 15x — é exatamente o bug que isto impede");
  });

  test("o ranking herda a regra (nada de acumulado sobre acumulado)", () => {
    const r = rankingFaturamento([{ id: "u", nome: "U", faturamento: faturamentoDaUnidade(mes), cobertura: {}, conformidadeMes: 1 }]);
    assert.equal(r[0].faturamento.total, 30000);
  });

  test("`ateDataIso` corta o snapshot — é o que torna a comparação justa", () => {
    assert.equal(faturamentoDaUnidade(mes, { ateDataIso: "2026-09-14" }).total, 14000);
    assert.equal(faturamentoDaUnidade(mes, { ateDataIso: "2026-09-30" }).total, 30000);
  });
});

// ===========================================================================
// G) sem_operacao / zero_vendas    H) parcial
// ===========================================================================
describe("G/H) situação da operação", () => {
  test("G) sem_operacao e zero_vendas não viram snapshot financeiro real", () => {
    const f = faturamentoDaUnidade([
      lin("2026-09-05", 5000),
      lin("2026-09-06", 0, { situacao: "sem_operacao" }),
      lin("2026-09-07", 0, { situacao: "zero_vendas" }),
    ]);
    assert.equal(f.total, 5000, "o 0 sintético não derruba o faturamento do mês");
    assert.equal(f.dataSnapshot, "2026-09-05");
  });

  test("H) `parcial` é operação válida e entra normalmente", () => {
    const f = faturamentoDaUnidade([
      lin("2026-09-05", 5000),
      lin("2026-09-06", 6100, { situacao: "parcial" }),
    ]);
    assert.equal(f.total, 6100);
    assert.equal(f.dataSnapshot, "2026-09-06");
  });

  test("mês só com sem_operacao -> sem faturamento (null, não 0)", () => {
    assert.equal(faturamentoDaUnidade([lin("2026-09-05", 0, { situacao: "sem_operacao" })]).total, null);
  });
});

// ===========================================================================
// I) distribuicao_mensal não duplica com o diário
// ===========================================================================
describe("I) distribuição mensal", () => {
  test("havendo snapshot diário, a distribuição mensal é ignorada", () => {
    const f = faturamentoDaUnidade([
      lin("2026-09-05", 5000),
      lin("2026-09-30", 90000, { origem_lancamento: "distribuicao_mensal" }),
    ]);
    assert.equal(f.total, 5000, "o diário manda; a fatia mensal não soma por cima");
  });

  test("só distribuição mensal -> aí sim SOMA (são fatias, não snapshots)", () => {
    const f = faturamentoDaUnidade([
      lin("2026-09-10", 30000, { origem_lancamento: "distribuicao_mensal" }),
      lin("2026-09-20", 40000, { origem_lancamento: "distribuicao_mensal" }),
    ]);
    assert.equal(f.total, 70000);
  });
});

// ===========================================================================
// EVOLUÇÃO DIÁRIA
// ===========================================================================
describe("evolução diária", () => {
  const dias = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"];

  test("o valor do dia é o DELTA do acumulado, não o acumulado", () => {
    const serie = evolucaoDiaria([{ linhas: [lin("2026-09-01", 1000), lin("2026-09-02", 2500), lin("2026-09-03", 4000)] }], dias);
    assert.deepEqual(serie.map((p) => p.acumulado), [1000, 2500, 4000, 4000]);
    assert.deepEqual(serie.map((p) => p.valor), [1000, 1500, 1500, 0]);
  });

  test("soma entre unidades no MESMO dia (acumulados independentes)", () => {
    const serie = evolucaoDiaria([
      { linhas: [lin("2026-09-01", 100), lin("2026-09-02", 300)] },
      { linhas: [lin("2026-09-01", 50), lin("2026-09-02", 150)] },
    ], ["2026-09-01", "2026-09-02"]);
    assert.deepEqual(serie.map((p) => p.acumulado), [150, 450]);
    assert.deepEqual(serie.map((p) => p.valor), [150, 300]);
  });

  test("dia sem nenhum snapshot -> acumulado null, valor null (buraco, não estimativa)", () => {
    const serie = evolucaoDiaria([{ linhas: [lin("2026-09-03", 4000)] }], dias);
    assert.deepEqual(serie.map((p) => p.acumulado), [null, null, 4000, 4000]);
    assert.equal(serie[0].valor, null);
    assert.equal(serie[1].valor, null);
  });
});

// ===========================================================================
// COMPARAÇÃO COM O MÊS ANTERIOR
// ===========================================================================
describe("comparação com o período equivalente", () => {
  test("o dia equivalente respeita o número de dias corridos", () => {
    const ago = Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`);
    assert.equal(diaEquivalenteNoMesAnterior("2026-09-14", ago), "2026-08-14");
    assert.equal(diaEquivalenteNoMesAnterior("2026-09-01", ago), "2026-08-01");
  });

  test("dia inexistente no mês anterior cai no último dia dele", () => {
    const fev = Array.from({ length: 28 }, (_, i) => `2026-02-${String(i + 1).padStart(2, "0")}`);
    assert.equal(diaEquivalenteNoMesAnterior("2026-03-31", fev), "2026-02-28");
  });

  test("variação null quando falta um dos lados (nunca fabrica crescimento)", () => {
    assert.equal(variacao(100, null), null);
    assert.equal(variacao(null, 100), null);
    assert.equal(variacao(100, 0), null, "divisão por zero não vira +infinito%");
    assert.ok(Math.abs(variacao(107.3, 100) - 0.073) < 1e-9);
  });

  test("variação de taxa é em pontos percentuais", () => {
    assert.ok(Math.abs(variacaoPP(0.88, 0.84) - 0.04) < 1e-9);
    assert.equal(variacaoPP(0.88, null), null);
  });
});
