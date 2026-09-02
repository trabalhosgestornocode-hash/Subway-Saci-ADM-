// PAINEL ADMINISTRATIVO — identificação de EMPRESAS e UNIDADES com pendência.
//
// `consolidarEmpresas` deixou de ser só um contador: passou a devolver QUAIS
// unidades da empresa estão pendentes, qual delas tratar primeiro e se o
// fechamento de ontem fechou. Sem isso o frontend teria de fazer uma chamada
// por empresa só para expandir um card — os dados já estavam em memória.
//
// PURO: sem I/O, sem fake de Supabase. Entra a saída do avaliador de frota,
// sai o rollup.
//
// Rodar: node --test test/administrativo-empresas-pendencia.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { consolidarEmpresas, temPendencia } from "../src/modules/administrativo/administrativo.monitores.js";
import { D1_CATEGORIA, ROLLUP } from "../src/modules/administrativo/administrativo.status.js";

/**
 * Unidade no formato que `avaliarFrota` devolve. Só os campos que a
 * consolidação lê — o resto do motor não importa aqui.
 */
function u({
  id, nome, org = "o1", empresa = "Alfa",
  criticidade = ROLLUP.EM_DIA, d1 = D1_CATEGORIA.CONCLUIDO, elegivel = true,
  diasPeriodo = 0, desdePeriodo = null,
  diasHist = 0, desdeHist = null, bloqueada = false,
  herdada = false, herdadaDesde = null,
  completos = 10, esperados = 10,
}) {
  return {
    unidadeId: id, unidadeNome: nome, organizacaoId: org, empresaNome: empresa,
    rollup: { status: criticidade },
    d1: { elegivel, categoria: d1, data: "2026-09-05" },
    conformidade: { completos, esperados, taxa: esperados ? completos / esperados : null },
    pendenciasPeriodo: { total: diasPeriodo, desde: desdePeriodo, dias: [], sequenciaBloqueada: bloqueada },
    pendenciasAcum: { total: diasHist, desde: desdeHist, dias: [], sequenciaBloqueada: bloqueada },
    pendenciaHerdada: { herdada, desde: herdadaDesde, total: herdada ? diasHist - diasPeriodo : 0 },
  };
}

const BLOQ = { criticidade: ROLLUP.CRITICO, d1: D1_CATEGORIA.SEQUENCIA_BLOQUEADA, bloqueada: true };
const NAO = { criticidade: ROLLUP.ATENCAO, d1: D1_CATEGORIA.NAO_REALIZADO };
const ABERTO = { criticidade: ROLLUP.ATENCAO, d1: D1_CATEGORIA.EM_PREENCHIMENTO };

// ===========================================================================
describe("consolidarEmpresas — quais unidades estão pendentes", () => {
  const frota = [
    u({ id: "u1", nome: "Mogi Centro", ...BLOQ, diasPeriodo: 4, desdePeriodo: "2026-09-01", diasHist: 4, desdeHist: "2026-09-01", completos: 1, esperados: 5 }),
    u({ id: "u2", nome: "Mogi Shopping", ...NAO, diasPeriodo: 2, desdePeriodo: "2026-09-03", diasHist: 7, desdeHist: "2026-08-27", herdada: true, herdadaDesde: "2026-08-27", completos: 3, esperados: 5 }),
    u({ id: "u3", nome: "Mogi Norte", completos: 5, esperados: 5 }),
  ];

  test("devolve a lista das unidades pendentes, e só delas", () => {
    const [e] = consolidarEmpresas(frota);
    assert.equal(e.unidadesMonitoradas, 3);
    assert.equal(e.unidadesPendentes, 2);
    // CRÍTICO vem antes de ATENÇÃO mesmo com o outro arrastando desde agosto:
    // criticidade tem precedência sobre antiguidade.
    assert.deepEqual(e.pendentes.map((p) => p.unidadeNome), ["Mogi Centro", "Mogi Shopping"]);
    assert.ok(!e.pendentes.some((p) => p.unidadeNome === "Mogi Norte"), "unidade em dia fica fora");
  });

  test("a definição de pendente é a MESMA de `temPendencia` (uma regra só)", () => {
    const [e] = consolidarEmpresas(frota);
    assert.equal(e.pendentes.length, frota.filter(temPendencia).length);
  });

  test("cada unidade pendente traz tipo, dias DO PERÍODO e a herança", () => {
    const [e] = consolidarEmpresas(frota);
    const shopping = e.pendentes.find((p) => p.unidadeNome === "Mogi Shopping");
    assert.equal(shopping.d1Status, D1_CATEGORIA.NAO_REALIZADO);
    assert.equal(shopping.criticidade, ROLLUP.ATENCAO);
    assert.equal(shopping.diasPendentes, 2, "leitura do período, não a histórica (7)");
    assert.equal(shopping.pendenciaMaisAntiga, "2026-09-03");
    assert.equal(shopping.pendenciaHerdada, true);
    assert.equal(shopping.pendenciaHerdadaDesde, "2026-08-27");
  });

  test("`piorUnidade` é a primeira da fila — quem tratar primeiro", () => {
    const [e] = consolidarEmpresas(frota);
    assert.equal(e.piorUnidade.unidadeNome, "Mogi Centro");
    assert.equal(e.piorUnidade.unidadeId, "u1");
    assert.equal(e.piorUnidade.criticidade, ROLLUP.CRITICO);
  });

  test("`pendenciaMaisAntiga` da empresa considera a herança", () => {
    const [e] = consolidarEmpresas(frota);
    assert.equal(e.pendenciaMaisAntiga, "2026-08-27");
  });

  test("empresa sem pendência: lista vazia, piorUnidade null, severidade saudável", () => {
    const [e] = consolidarEmpresas([u({ id: "x", nome: "Limpa" })]);
    assert.equal(e.unidadesPendentes, 0);
    assert.deepEqual(e.pendentes, []);
    assert.equal(e.piorUnidade, null);
    assert.equal(e.severidade, 2);
    assert.equal(e.pendenciaMaisAntiga, null);
  });
});

describe("ordem das unidades dentro da empresa", () => {
  test("mais grave primeiro; empatando, a pendência mais antiga", () => {
    const [e] = consolidarEmpresas([
      u({ id: "a", nome: "Aberto", ...ABERTO, diasPeriodo: 1, desdePeriodo: "2026-09-04", diasHist: 1, desdeHist: "2026-09-04" }),
      u({ id: "b", nome: "Nao iniciado", ...NAO, diasPeriodo: 1, desdePeriodo: "2026-09-04", diasHist: 1, desdeHist: "2026-09-04" }),
      u({ id: "c", nome: "Travada nova", ...BLOQ, diasPeriodo: 2, desdePeriodo: "2026-09-03", diasHist: 2, desdeHist: "2026-09-03" }),
      u({ id: "d", nome: "Travada antiga", ...BLOQ, diasPeriodo: 4, desdePeriodo: "2026-09-01", diasHist: 4, desdeHist: "2026-09-01" }),
    ]);
    assert.deepEqual(e.pendentes.map((p) => p.unidadeNome),
      ["Travada antiga", "Travada nova", "Nao iniciado", "Aberto"]);
  });

  test("a herança puxa a unidade para cima (arrasta há mais tempo)", () => {
    const [e] = consolidarEmpresas([
      u({ id: "a", nome: "So no mes", ...NAO, diasPeriodo: 3, desdePeriodo: "2026-09-01", diasHist: 3, desdeHist: "2026-09-01" }),
      u({ id: "b", nome: "Vem de agosto", ...NAO, diasPeriodo: 1, desdePeriodo: "2026-09-04", diasHist: 6, desdeHist: "2026-08-28", herdada: true, herdadaDesde: "2026-08-28" }),
    ]);
    assert.deepEqual(e.pendentes.map((p) => p.unidadeNome), ["Vem de agosto", "So no mes"]);
    assert.equal(e.pendentes[0].diasPendentes, 1, "sobe pela histórica, mas exibe a do período");
  });
});

describe("ordem das EMPRESAS — a pior primeiro", () => {
  const empresa = (org, nome, unidades) => unidades.map((o) => u({ ...o, org, empresa: nome }));

  test("críticas antes de atenção, e atenção antes de saudável", () => {
    const r = consolidarEmpresas([
      ...empresa("o3", "Saudável", [{ id: "s1", nome: "S1" }]),
      ...empresa("o2", "Atenção", [{ id: "a1", nome: "A1", ...NAO, diasPeriodo: 1, diasHist: 1, desdePeriodo: "2026-09-04", desdeHist: "2026-09-04" }]),
      ...empresa("o1", "Crítica", [{ id: "c1", nome: "C1", ...BLOQ, diasPeriodo: 1, diasHist: 1, desdePeriodo: "2026-09-04", desdeHist: "2026-09-04" }]),
    ]);
    assert.deepEqual(r.map((e) => e.empresaNome), ["Crítica", "Atenção", "Saudável"]);
    assert.deepEqual(r.map((e) => e.severidade), [0, 1, 2]);
  });

  test("empatando na severidade, mais unidades pendentes vem antes", () => {
    const r = consolidarEmpresas([
      ...empresa("o1", "Uma pendente", [
        { id: "a", nome: "A", ...BLOQ, diasPeriodo: 1, diasHist: 1, desdePeriodo: "2026-09-04", desdeHist: "2026-09-04" },
        { id: "b", nome: "B" },
      ]),
      ...empresa("o2", "Tres pendentes", [
        { id: "c", nome: "C", ...BLOQ, diasPeriodo: 1, diasHist: 1, desdePeriodo: "2026-09-04", desdeHist: "2026-09-04" },
        { id: "d", nome: "D", ...NAO, diasPeriodo: 1, diasHist: 1, desdePeriodo: "2026-09-04", desdeHist: "2026-09-04" },
        { id: "e", nome: "E", ...ABERTO, diasPeriodo: 1, diasHist: 1, desdePeriodo: "2026-09-04", desdeHist: "2026-09-04" },
      ]),
    ]);
    assert.deepEqual(r.map((e) => e.empresaNome), ["Tres pendentes", "Uma pendente"]);
  });

  test("empatando em tudo, a pendência mais antiga desempata", () => {
    const r = consolidarEmpresas([
      ...empresa("o1", "Recente", [{ id: "a", nome: "A", ...BLOQ, diasPeriodo: 1, diasHist: 1, desdePeriodo: "2026-09-04", desdeHist: "2026-09-04" }]),
      ...empresa("o2", "Antiga", [{ id: "b", nome: "B", ...BLOQ, diasPeriodo: 4, diasHist: 4, desdePeriodo: "2026-09-01", desdeHist: "2026-09-01" }]),
    ]);
    assert.deepEqual(r.map((e) => e.empresaNome), ["Antiga", "Recente"]);
  });
});

describe("resumo executivo da empresa", () => {
  test("d1Ok = true só quando TODAS as elegíveis concluíram", () => {
    const [ok] = consolidarEmpresas([u({ id: "a", nome: "A" }), u({ id: "b", nome: "B" })]);
    assert.equal(ok.d1Ok, true);

    const [nok] = consolidarEmpresas([
      u({ id: "a", nome: "A" }),
      u({ id: "b", nome: "B", ...NAO, diasPeriodo: 1, diasHist: 1, desdePeriodo: "2026-09-04", desdeHist: "2026-09-04" }),
    ]);
    assert.equal(nok.d1Ok, false);
  });

  test("d1Ok = null quando nenhuma unidade é elegível (não inventa 'sim')", () => {
    const [e] = consolidarEmpresas([u({ id: "a", nome: "A", elegivel: false, d1: D1_CATEGORIA.NAO_APLICAVEL })]);
    assert.equal(e.d1Ok, null);
  });

  test("conformidade da empresa continua Σ/Σ, nunca média de percentuais", () => {
    const [e] = consolidarEmpresas([
      u({ id: "a", nome: "A", completos: 14, esperados: 14 }),
      u({ id: "b", nome: "B", completos: 3, esperados: 7 }),
    ]);
    assert.equal(e.mesCompleto, 17);
    assert.equal(e.mesEsperado, 21);
    assert.ok(Math.abs(e.conformidadeMes - 17 / 21) < 1e-9);
    assert.ok(Math.abs(e.conformidadeMes - (1 + 3 / 7) / 2) > 0.05, "não é média de %");
  });

  test("contadores por severidade e por categoria de D-1 batem", () => {
    const [e] = consolidarEmpresas([
      u({ id: "a", nome: "A", ...BLOQ, diasPeriodo: 1, diasHist: 1, desdePeriodo: "2026-09-04", desdeHist: "2026-09-04" }),
      u({ id: "b", nome: "B", ...NAO, diasPeriodo: 1, diasHist: 1, desdePeriodo: "2026-09-04", desdeHist: "2026-09-04" }),
      u({ id: "c", nome: "C", ...ABERTO, diasPeriodo: 1, diasHist: 1, desdePeriodo: "2026-09-04", desdeHist: "2026-09-04" }),
      u({ id: "d", nome: "D" }),
    ]);
    assert.deepEqual(
      { criticas: e.criticas, atencao: e.atencao, emDia: e.emDia },
      { criticas: 1, atencao: 2, emDia: 1 },
    );
    assert.deepEqual(
      { bloq: e.d1Bloqueadas, nao: e.d1NaoRealizadas, aberto: e.d1EmPreenchimento, ok: e.d1Concluidas },
      { bloq: 1, nao: 1, aberto: 1, ok: 1 },
    );
  });
});

describe("robustez", () => {
  test("frota vazia -> lista vazia (sem exceção)", () => {
    assert.deepEqual(consolidarEmpresas([]), []);
    assert.deepEqual(consolidarEmpresas(null), []);
  });

  test("unidade sem organizacaoId cai num grupo próprio, sem quebrar", () => {
    const r = consolidarEmpresas([{ unidadeId: "x", unidadeNome: "Solta", rollup: {}, d1: {}, conformidade: {} }]);
    assert.equal(r.length, 1);
    assert.equal(r[0].organizacaoId, null);
    assert.equal(r[0].unidadesMonitoradas, 1);
  });
});
