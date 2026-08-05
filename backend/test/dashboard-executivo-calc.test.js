// Testes da camada de cálculo do Dashboard Executivo (dashboardExecutivo.calc.js)
// — puros, sem rede. Rodar: node --test test/dashboard-executivo-calc.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ticketMedio, percentual, totalDeducoes, receitaAposDeducoes, saldoPercentual,
  mediaDiaria, projecaoMensal, confiabilidadeProjecao, statusDiaBase, statusMes,
  resumoPreenchimento, verificarDisponibilidade, agruparPendenciasPorMes,
  validarOutrasDeducoes, inconsistencias, diagnostico, recomendacoes,
  diasDoMes, mesAnterior, STATUS_DIA,
} from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";

const perto = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
describe("ticket médio", () => {
  test("R$ 4.668,53 / 108 vendas ≈ R$ 43,23", () => {
    assert.ok(perto(ticketMedio(4668.53, 108), 43.23, 0.01));
  });
  test("sem vendas devolve null (nunca divide por zero)", () => {
    assert.equal(ticketMedio(1000, 0), null);
    assert.equal(ticketMedio(1000, null), null);
  });
});

// ---------------------------------------------------------------------------
describe("percentual", () => {
  test("851,22 / 4668,53 ≈ 18,23%", () => {
    assert.ok(perto(percentual(851.22, 4668.53), 18.23, 0.01));
  });
  test("base zero ou inválida devolve null", () => {
    assert.equal(percentual(100, 0), null);
    assert.equal(percentual(100, null), null);
  });
});

// ---------------------------------------------------------------------------
describe("total de deduções e receita após deduções", () => {
  test("soma das 4 deduções", () => {
    const total = totalDeducoes({ taxasComissoes: 100, servicosPromocoes: 50, taxasEntregadores: 30, outrasDeducoes: 20 });
    assert.equal(total, 200);
  });
  test("outras deduções negativas reduzem o total (ajuste a favor)", () => {
    const total = totalDeducoes({ taxasComissoes: 100, servicosPromocoes: 50, taxasEntregadores: 30, outrasDeducoes: -20 });
    assert.equal(total, 160);
  });
  test("receita após deduções = vendas - total", () => {
    assert.equal(receitaAposDeducoes(1000, 300), 700);
  });
  test("saldo percentual = 100 - percentual total; null quando o percentual é null", () => {
    assert.equal(saldoPercentual(30), 70);
    assert.equal(saldoPercentual(null), null);
  });
});

// ---------------------------------------------------------------------------
describe("média diária e projeção", () => {
  test("média ignora nulls (dias sem dado)", () => {
    assert.equal(mediaDiaria([100, 200, null, 300]), 200);
  });
  test("sem nenhum dia válido devolve null", () => {
    assert.equal(mediaDiaria([]), null);
    assert.equal(mediaDiaria([null, undefined]), null);
  });
  test("projeção = média × dias previstos", () => {
    assert.equal(projecaoMensal(1000, 30), 30000);
    assert.equal(projecaoMensal(null, 30), null);
  });
});

// ---------------------------------------------------------------------------
describe("confiabilidade da projeção", () => {
  test("sem dados => indisponível", () => {
    assert.equal(confiabilidadeProjecao({ diasVencidos: 3, diasResolvidos: 0, diasComDados: 0 }).nivel, "indisponivel");
  });
  test("com pendência => baixa, mesmo com dados", () => {
    assert.equal(confiabilidadeProjecao({ diasVencidos: 5, diasResolvidos: 3, diasComDados: 3 }).nivel, "baixa");
  });
  test("sem pendência e poucos dias => média", () => {
    assert.equal(confiabilidadeProjecao({ diasVencidos: 3, diasResolvidos: 3, diasComDados: 3 }).nivel, "media");
  });
  test("sem pendência e dias suficientes => alta", () => {
    assert.equal(confiabilidadeProjecao({ diasVencidos: 6, diasResolvidos: 6, diasComDados: 6 }).nivel, "alta");
  });
});

// ---------------------------------------------------------------------------
describe("status de um dia (base, a partir do lançamento)", () => {
  test("sem lançamento => null", () => assert.equal(statusDiaBase({ lancamento: null }), null));
  test("rascunho => RASCUNHO, mesmo com situação normal", () => {
    assert.equal(statusDiaBase({ lancamento: { status: "rascunho", situacao: "normal" } }), STATUS_DIA.RASCUNHO);
  });
  test("finalizado + sem_operacao => SEM_OPERACAO", () => {
    assert.equal(statusDiaBase({ lancamento: { status: "finalizado", situacao: "sem_operacao" } }), STATUS_DIA.SEM_OPERACAO);
  });
  test("finalizado + zero_vendas => ZERO_VENDAS", () => {
    assert.equal(statusDiaBase({ lancamento: { status: "finalizado", situacao: "zero_vendas" } }), STATUS_DIA.ZERO_VENDAS);
  });
  test("finalizado + normal => PREENCHIDO", () => {
    assert.equal(statusDiaBase({ lancamento: { status: "finalizado", situacao: "normal" } }), STATUS_DIA.PREENCHIDO);
  });
});

// ---------------------------------------------------------------------------
// A trava sequencial: o núcleo do bloqueio pedido no briefing.
// ---------------------------------------------------------------------------
describe("statusMes — trava sequencial dentro do mês", () => {
  test("dia 1 vazio fica PENDENTE (nunca bloqueado por padrão)", () => {
    const dias = [{ data: "2026-08-01", lancamento: null }];
    const r = statusMes({ dias, hojeIso: "2026-08-03" });
    assert.equal(r[0].status, STATUS_DIA.PENDENTE);
  });

  test("dia 1 vazio + dia 2 vazio + hoje=dia 3 => dia 2 e 3 BLOQUEADOS", () => {
    const dias = [
      { data: "2026-08-01", lancamento: null },
      { data: "2026-08-02", lancamento: null },
      { data: "2026-08-03", lancamento: null },
    ];
    const r = statusMes({ dias, hojeIso: "2026-08-03" });
    assert.equal(r[0].status, STATUS_DIA.PENDENTE);
    assert.equal(r[1].status, STATUS_DIA.BLOQUEADO);
    assert.equal(r[2].status, STATUS_DIA.BLOQUEADO);
  });

  test("dia 1 finalizado libera o dia 2", () => {
    const dias = [
      { data: "2026-08-01", lancamento: { status: "finalizado", situacao: "normal" } },
      { data: "2026-08-02", lancamento: null },
    ];
    const r = statusMes({ dias, hojeIso: "2026-08-03" });
    assert.equal(r[0].status, STATUS_DIA.PREENCHIDO);
    assert.equal(r[1].status, STATUS_DIA.PENDENTE);
  });

  test("dia 1 em rascunho NÃO libera o dia 2 (rascunho não resolve)", () => {
    const dias = [
      { data: "2026-08-01", lancamento: { status: "rascunho", situacao: "normal" } },
      { data: "2026-08-02", lancamento: null },
    ];
    const r = statusMes({ dias, hojeIso: "2026-08-03" });
    assert.equal(r[0].status, STATUS_DIA.RASCUNHO);
    assert.equal(r[1].status, STATUS_DIA.BLOQUEADO);
  });

  test("dia sem operação e dia zero vendas TAMBÉM resolvem e liberam o próximo", () => {
    const dias = [
      { data: "2026-08-01", lancamento: { status: "finalizado", situacao: "sem_operacao" } },
      { data: "2026-08-02", lancamento: { status: "finalizado", situacao: "zero_vendas" } },
      { data: "2026-08-03", lancamento: null },
    ];
    const r = statusMes({ dias, hojeIso: "2026-08-03" });
    assert.equal(r[0].status, STATUS_DIA.SEM_OPERACAO);
    assert.equal(r[1].status, STATUS_DIA.ZERO_VENDAS);
    assert.equal(r[2].status, STATUS_DIA.PENDENTE);
  });

  test("data futura é sempre FUTURO, mesmo que o dia anterior esteja pendente", () => {
    const dias = [
      { data: "2026-08-01", lancamento: null },
      { data: "2026-08-02", lancamento: null },
    ];
    const r = statusMes({ dias, hojeIso: "2026-08-01" });
    assert.equal(r[0].status, STATUS_DIA.PENDENTE); // é hoje, não é futuro
    assert.equal(r[1].status, STATUS_DIA.FUTURO);
  });

  test("dia 1 de um mês novo NUNCA é bloqueado — a trava não atravessa a fronteira do mês", () => {
    // Isto é chamado uma vez por mês; o próprio statusMes só vê os dias do mês
    // recebido, então pendência de agosto não pode aparecer aqui.
    const diasSetembro = [{ data: "2026-09-01", lancamento: null }];
    const r = statusMes({ dias: diasSetembro, hojeIso: "2026-09-01" });
    assert.equal(r[0].status, STATUS_DIA.PENDENTE);
  });
});

describe("resumoPreenchimento", () => {
  test("conta cada status e calcula o percentual de conclusão", () => {
    const diasComStatus = [
      { data: "2026-08-01", status: STATUS_DIA.PREENCHIDO, lancamento: { x: 1 } },
      { data: "2026-08-02", status: STATUS_DIA.SEM_OPERACAO, lancamento: { x: 1 } },
      { data: "2026-08-03", status: STATUS_DIA.RASCUNHO, lancamento: { x: 1 } },
      { data: "2026-08-04", status: STATUS_DIA.PENDENTE, lancamento: null },
      { data: "2026-08-05", status: STATUS_DIA.FUTURO, lancamento: null },
    ];
    const r = resumoPreenchimento(diasComStatus);
    assert.equal(r.totalDias, 5);
    assert.equal(r.diasPreenchidos, 2); // PREENCHIDO + SEM_OPERACAO
    assert.equal(r.diasRascunho, 1);
    assert.equal(r.diasPendentes, 1);
    assert.equal(r.primeiroDiaPendente, "2026-08-04");
    assert.ok(perto(r.percentualConclusao, 40));
  });
});

describe("verificarDisponibilidade", () => {
  const dias = [
    { data: "2026-08-01", status: STATUS_DIA.PREENCHIDO },
    { data: "2026-08-02", status: STATUS_DIA.PENDENTE },
    { data: "2026-08-03", status: STATUS_DIA.BLOQUEADO },
    { data: "2026-08-04", status: STATUS_DIA.FUTURO },
  ];
  test("PENDENTE está disponível", () => assert.equal(verificarDisponibilidade(dias, "2026-08-02").disponivel, true));
  test("BLOQUEADO não está disponível", () => assert.equal(verificarDisponibilidade(dias, "2026-08-03").disponivel, false));
  test("FUTURO não está disponível", () => assert.equal(verificarDisponibilidade(dias, "2026-08-04").disponivel, false));
  test("data fora do mês consultado não está disponível", () => assert.equal(verificarDisponibilidade(dias, "2026-09-01").disponivel, false));
});

describe("agruparPendenciasPorMes", () => {
  test("agrupa datas pendentes por ano-mês", () => {
    const grupos = agruparPendenciasPorMes(["2026-07-30", "2026-07-31", "2026-06-15"]);
    assert.equal(grupos.length, 2);
    assert.deepEqual(grupos[0], { ano: 2026, mes: 6, dias: ["2026-06-15"] });
    assert.deepEqual(grupos[1], { ano: 2026, mes: 7, dias: ["2026-07-30", "2026-07-31"] });
  });
});

describe("diasDoMes / mesAnterior", () => {
  test("agosto de 2026 tem 31 dias", () => assert.equal(diasDoMes(2026, 8).length, 31));
  test("fevereiro de 2028 (bissexto) tem 29 dias", () => assert.equal(diasDoMes(2028, 2).length, 29));
  test("mês anterior a janeiro é dezembro do ano anterior", () => {
    assert.deepEqual(mesAnterior(2026, 1), { ano: 2025, mes: 12 });
    assert.deepEqual(mesAnterior(2026, 8), { ano: 2026, mes: 7 });
  });
});

// ---------------------------------------------------------------------------
describe("validação de outras deduções (ajuste negativo)", () => {
  test("valor positivo é sempre aceito", () => {
    assert.equal(validarOutrasDeducoes({ valor: 50, justificativa: null, podeAjustarNegativo: false }), null);
  });
  test("negativo sem permissão é barrado", () => {
    assert.match(validarOutrasDeducoes({ valor: -50, justificativa: "motivo", podeAjustarNegativo: false }), /permissão/i);
  });
  test("negativo com permissão mas sem justificativa é barrado", () => {
    assert.match(validarOutrasDeducoes({ valor: -50, justificativa: "", podeAjustarNegativo: true }), /justificativa/i);
  });
  test("negativo com permissão e justificativa é aceito", () => {
    assert.equal(validarOutrasDeducoes({ valor: -50, justificativa: "erro de lançamento do dia anterior", podeAjustarNegativo: true }), null);
  });
});

describe("inconsistências (avisos, não bloqueiam sozinhas)", () => {
  test("vendas com valor mas quantidade zero gera aviso", () => {
    const avisos = inconsistencias({ qtdVendas: 0, valorVendasBruto: 100, valorVendasIfood: 100, totalDed: 20 });
    assert.ok(avisos.some((a) => /quantidade/i.test(a)));
  });
  test("deduções maiores que as vendas geram aviso", () => {
    const avisos = inconsistencias({ qtdVendas: 10, valorVendasBruto: 100, valorVendasIfood: 100, totalDed: 150 });
    assert.ok(avisos.some((a) => /ultrapassa/i.test(a)));
  });
  test("dados consistentes não geram aviso", () => {
    assert.deepEqual(inconsistencias({ qtdVendas: 10, valorVendasBruto: 500, valorVendasIfood: 500, totalDed: 100 }), []);
  });
});

// ---------------------------------------------------------------------------
describe("diagnóstico executivo", () => {
  const metas = {
    taxas_comissoes: { metaIdeal: 20.5, limite: 20.5 },
    servicos_promocoes: { metaIdeal: 10, limite: 14.5 },
    taxas_entregadores: { metaIdeal: 15, limite: 15 },
    total_deducoes: { metaIdeal: 30.5, limite: 32 },
  };

  test("sem dados suficientes não gera nenhum ponto forte", () => {
    const d = diagnostico({ indicadores: null, metas, diasPendentesNoMes: 0, comparativoMesAnteriorPct: null });
    assert.equal(d.semDadosSuficientes, true);
    assert.deepEqual(d.pontosFortes, []);
  });

  test("indicador dentro da meta ideal vira ponto forte", () => {
    const d = diagnostico({
      indicadores: { taxas_comissoes: 18.23, servicos_promocoes: 12.11, taxas_entregadores: 10, total_deducoes: 30.34 },
      metas, diasPendentesNoMes: 0, comparativoMesAnteriorPct: null,
    });
    assert.ok(d.pontosFortes.some((p) => /Taxas e comissões/.test(p)));
    assert.ok(d.pontosFortes.some((p) => /Total de deduções/.test(p)));
  });

  test("indicador acima da meta mas dentro do limite vira ponto de atenção", () => {
    const d = diagnostico({
      indicadores: { taxas_comissoes: 18, servicos_promocoes: 12.11, taxas_entregadores: 10, total_deducoes: 25 },
      metas, diasPendentesNoMes: 0, comparativoMesAnteriorPct: null,
    });
    assert.ok(d.pontosAtencao.some((p) => /Serviços e promoções/.test(p)));
    assert.ok(d.indicadoresForaDaMeta.includes("servicos_promocoes"));
  });

  test("indicador acima do limite vira alerta (crítico para total de deduções)", () => {
    const d = diagnostico({
      indicadores: { taxas_comissoes: 18, servicos_promocoes: 8, taxas_entregadores: 10, total_deducoes: 35 },
      metas, diasPendentesNoMes: 0, comparativoMesAnteriorPct: null,
    });
    assert.ok(d.alertas.some((a) => /Total de deduções/.test(a) && /Crítico/.test(a)));
  });

  test("dias pendentes geram alerta de dados incompletos", () => {
    const d = diagnostico({
      indicadores: { taxas_comissoes: 18, servicos_promocoes: 8, taxas_entregadores: 10, total_deducoes: 25 },
      metas, diasPendentesNoMes: 3, comparativoMesAnteriorPct: null,
    });
    assert.ok(d.alertas.some((a) => /3 dia/.test(a)));
  });

  test("crescimento vs mês anterior vira ponto forte; queda relevante vira ponto de atenção", () => {
    const base = { indicadores: { taxas_comissoes: 18, servicos_promocoes: 8, taxas_entregadores: 10, total_deducoes: 25 }, metas, diasPendentesNoMes: 0 };
    const crescimento = diagnostico({ ...base, comparativoMesAnteriorPct: 12 });
    assert.ok(crescimento.pontosFortes.some((p) => /cresceu/i.test(p)));
    const queda = diagnostico({ ...base, comparativoMesAnteriorPct: -15 });
    assert.ok(queda.pontosAtencao.some((p) => /caiu/i.test(p)));
  });
});

describe("recomendações — sempre amarradas a um indicador/pendência real", () => {
  test("sem dados suficientes recomenda esperar mais lançamentos", () => {
    const r = recomendacoes({ indicadoresForaDaMeta: [], diasPendentesNoMes: 0, semDadosSuficientes: true });
    assert.equal(r.length, 1);
    assert.match(r[0], /lançamentos suficientes/i);
  });
  test("indicador fora da meta gera recomendação específica", () => {
    const r = recomendacoes({ indicadoresForaDaMeta: ["servicos_promocoes"], diasPendentesNoMes: 0, semDadosSuficientes: false });
    assert.ok(r.some((x) => /campanhas e promoções/i.test(x)));
  });
  test("dias pendentes geram recomendação de regularização", () => {
    const r = recomendacoes({ indicadoresForaDaMeta: [], diasPendentesNoMes: 2, semDadosSuficientes: false });
    assert.ok(r.some((x) => /regulariz/i.test(x)));
  });
  test("tudo certo => recomendação de manter o desempenho", () => {
    const r = recomendacoes({ indicadoresForaDaMeta: [], diasPendentesNoMes: 0, semDadosSuficientes: false });
    assert.ok(r.some((x) => /manter o desempenho/i.test(x)));
  });
});
