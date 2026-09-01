// Testes do motor de diagnóstico do Dashboard iFood (dashboardExecutivo.diagnostico.js)
// — puros, sem rede. Rodar: node --test test/dashboard-executivo-diagnostico.test.js
//
// Cobre os Casos A-H do pedido de evolução do Diagnóstico/Plano de Ação.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { gerarDiagnostico, confiabilidadeDados, LIMIARES_DIAGNOSTICO } from "../src/modules/dashboard-executivo/dashboardExecutivo.diagnostico.js";
import { saldoMeta } from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";

const perto = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

/** Monta um indicador no formato que o service já entrega ao motor. */
function indicador({ atual, valor, metaIdeal, limite, faturamentoBase, naoAplicavel = false }) {
  const meta = metaIdeal != null ? { metaIdeal, limite } : null;
  return {
    atual, valor, meta, naoAplicavel,
    saldo: meta ? saldoMeta({ valorUtilizado: valor, percentualUtilizado: atual, limitePct: limite, faturamentoBase }) : null,
  };
}

function baseIndicadores({ faturamentoBase = 50000 } = {}) {
  return {
    taxas_comissoes: indicador({ atual: null, valor: null, metaIdeal: 20.5, limite: 20.5, faturamentoBase }),
    servicos_promocoes: indicador({ atual: null, valor: null, metaIdeal: 10, limite: 15, faturamentoBase }),
    taxas_entregadores: indicador({ atual: null, valor: null, metaIdeal: 15, limite: 15, faturamentoBase }),
    total_deducoes: indicador({ atual: null, valor: null, metaIdeal: 30.5, limite: 32, faturamentoBase }),
  };
}

// ---------------------------------------------------------------------------
describe("Caso A — Serviços e Promoções acima da meta ideal (11,9% / ideal 10% / limite 15%)", () => {
  test("gera ponto de atenção com excesso em R$ e margem até o limite", () => {
    const faturamentoBase = 50000;
    const indicadores = baseIndicadores({ faturamentoBase });
    indicadores.servicos_promocoes = indicador({ atual: 11.9, valor: 5950, metaIdeal: 10, limite: 15, faturamentoBase });

    const d = gerarDiagnostico({
      indicadores, faturamentoBase, diasComDados: 20, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0,
      comparativo: null, recuperacao: null,
    });

    const achado = d.pontosAtencao.find((a) => a.categoria === "servicos_promocoes");
    assert.ok(achado, "deveria gerar ponto de atenção para Serviços e Promoções");
    assert.ok(perto(achado.metricas.valorIdeal, 5000));
    assert.ok(perto(achado.metricas.excesso, 950));
    assert.ok(perto(achado.metricas.margemAteLimiteReais, 1550));

    const acao = d.acoes.find((a) => a.diagnosticoId === achado.id);
    assert.ok(acao, "deveria gerar uma ação ligada ao MESMO id do achado");
    assert.match(acao.descricao, /950/); // valor de redução citado
    assert.match(acao.descricao, /não é recomendável ampliar os gastos/i); // não incentiva gastar a margem (item 8)
    assert.equal(acao.cta.label, "Analisar Serviços e Promoções");
  });
});

// ---------------------------------------------------------------------------
describe("Caso B — Serviços e Promoções acima do limite máximo", () => {
  test("vira alerta e mostra quanto falta para voltar ao LIMITE e à META IDEAL", () => {
    const faturamentoBase = 50000;
    const indicadores = baseIndicadores({ faturamentoBase });
    indicadores.servicos_promocoes = indicador({ atual: 17, valor: 8500, metaIdeal: 10, limite: 15, faturamentoBase });

    const d = gerarDiagnostico({
      indicadores, faturamentoBase, diasComDados: 20, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0,
      comparativo: null, recuperacao: null,
    });

    const achado = d.alertas.find((a) => a.categoria === "servicos_promocoes");
    assert.ok(achado, "deveria virar alerta (acima do limite)");
    const acao = d.acoes.find((a) => a.diagnosticoId === achado.id);
    assert.equal(acao.tipo, "CRITICAL");
    assert.match(acao.descricao, /retornar ao limite/i);
    assert.match(acao.descricao, /retornar à meta ideal/i);
  });
});

// ---------------------------------------------------------------------------
describe("Caso C — Taxas dentro da meta", () => {
  test("vira ponto forte e NÃO gera ação prioritária", () => {
    const faturamentoBase = 50000;
    const indicadores = baseIndicadores({ faturamentoBase });
    indicadores.taxas_comissoes = indicador({ atual: 18.1, valor: 9050, metaIdeal: 20.5, limite: 20.5, faturamentoBase });

    const d = gerarDiagnostico({
      indicadores, faturamentoBase, diasComDados: 20, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0,
      comparativo: null, recuperacao: null,
    });

    assert.ok(d.pontosFortes.some((a) => a.categoria === "taxas_comissoes"));
    assert.ok(!d.acoes.some((a) => a.diagnosticoId.startsWith("taxas_comissoes")));
  });
});

// ---------------------------------------------------------------------------
describe("Caso C.1 (Etapa H) — Taxas de Entregadores acima do limite (16,0% / meta ideal e limite 15%)", () => {
  test("vira ALERTA (meta ideal == limite: qualquer excesso já ultrapassa os dois) com excesso em R$", () => {
    const faturamentoBase = 50000;
    const indicadores = baseIndicadores({ faturamentoBase });
    indicadores.taxas_entregadores = indicador({ atual: 16, valor: 8000, metaIdeal: 15, limite: 15, faturamentoBase });

    const d = gerarDiagnostico({
      indicadores, faturamentoBase, diasComDados: 20, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0,
      comparativo: null, recuperacao: null,
    });

    const achado = d.alertas.find((a) => a.categoria === "taxas_entregadores");
    assert.ok(achado, "deveria virar alerta para Taxas de Entregadores");
    assert.match(achado.titulo, /Taxas de Entregadores/);
    assert.ok(perto(achado.metricas.excesso, 500)); // 500/50000 = 1% de excesso sobre a meta ideal de 15%

    const acao = d.acoes.find((a) => a.diagnosticoId === achado.id);
    assert.ok(acao, "deveria gerar uma ação ligada ao MESMO id do achado");
    assert.equal(acao.cta.label, "Analisar Taxas de Entregadores");
  });

  test("indicador não aplicável (ex.: modelo Full Service) nunca gera achado", () => {
    const faturamentoBase = 50000;
    const indicadores = baseIndicadores({ faturamentoBase });
    indicadores.taxas_entregadores = indicador({ atual: 16, valor: 8000, metaIdeal: 15, limite: 15, faturamentoBase, naoAplicavel: true });

    const d = gerarDiagnostico({
      indicadores, faturamentoBase, diasComDados: 20, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0,
      comparativo: null, recuperacao: null,
    });

    assert.ok(!d.alertas.some((a) => a.categoria === "taxas_entregadores"));
    assert.ok(!d.pontosAtencao.some((a) => a.categoria === "taxas_entregadores"));
  });

  test("dentro da meta -> ponto forte, sem ação prioritária", () => {
    const faturamentoBase = 50000;
    const indicadores = baseIndicadores({ faturamentoBase });
    indicadores.taxas_entregadores = indicador({ atual: 12, valor: 6000, metaIdeal: 15, limite: 15, faturamentoBase });

    const d = gerarDiagnostico({
      indicadores, faturamentoBase, diasComDados: 20, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0,
      comparativo: null, recuperacao: null,
    });

    assert.ok(d.pontosFortes.some((a) => a.categoria === "taxas_entregadores"));
    assert.ok(!d.acoes.some((a) => a.diagnosticoId.startsWith("taxas_entregadores")));
  });

  test("continua contribuindo pro texto de 'componente que mais pesa' do Total de Deduções (comportamento pré-existente preservado)", () => {
    const faturamentoBase = 50000;
    const indicadores = baseIndicadores({ faturamentoBase });
    indicadores.taxas_entregadores = indicador({ atual: 16, valor: 8000, metaIdeal: 15, limite: 15, faturamentoBase });
    indicadores.total_deducoes = indicador({ atual: 33, valor: 16500, metaIdeal: 30.5, limite: 32, faturamentoBase });

    const d = gerarDiagnostico({
      indicadores, faturamentoBase, diasComDados: 20, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0,
      comparativo: null, recuperacao: null,
    });

    const achadoDeducoes = d.alertas.find((a) => a.categoria === "total_deducoes");
    assert.match(achadoDeducoes.descricao, /Taxas de Entregadores/);
  });
});

// ---------------------------------------------------------------------------
describe("Caso D — faturamento de mês fechado caiu (comparação real)", () => {
  test("mostra diferença em R$ e percentual", () => {
    const comparativo = { tipo: "mes_fechado", diaComparado: null, atual: 40000, anterior: 80000, diferenca: -40000, pct: -50, temEstimativa: false };
    const d = gerarDiagnostico({
      indicadores: baseIndicadores(), faturamentoBase: 40000, diasComDados: 30, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0,
      comparativo, recuperacao: null,
    });
    const achado = [...d.pontosAtencao, ...d.alertas].find((a) => a.id === "faturamento_caiu");
    assert.ok(achado);
    assert.match(achado.descricao, /R\$ 80.000,00/);
    assert.match(achado.descricao, /R\$ 40.000,00/);
    assert.match(achado.descricao, /50\.0%/);
  });
});

// ---------------------------------------------------------------------------
describe("Caso E — mês em andamento não pode comparar dias parciais com mês fechado inteiro", () => {
  test("comparativo tipo 'mesmo_periodo' rotula claramente o recorte comparado", () => {
    // Estratégia A: 10 dias de agosto vs os mesmos 10 dias de julho — nunca
    // julho inteiro. O texto deve deixar isso explícito.
    const comparativo = { tipo: "mesmo_periodo", diaComparado: 10, atual: 15120, anterior: 18000, diferenca: -2880, pct: -16, temEstimativa: false };
    const d = gerarDiagnostico({
      indicadores: baseIndicadores(), faturamentoBase: 15120, diasComDados: 10, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0,
      comparativo, recuperacao: null,
    });
    const achado = [...d.pontosAtencao, ...d.alertas].find((a) => a.id === "faturamento_caiu");
    assert.ok(achado);
    assert.match(achado.descricao, /primeiros 10 dias/);
    assert.ok(!/81/.test(achado.descricao), "não deveria produzir a distorção de comparar parcial com mês inteiro");
  });

  test("sem dado suficiente no mesmo período -> comparativo indisponível, motor não inventa achado", () => {
    const comparativo = { tipo: "indisponivel", pct: null, atual: 1000, anterior: null, diferenca: null, diaComparado: 10, temEstimativa: false };
    const d = gerarDiagnostico({
      indicadores: baseIndicadores(), faturamentoBase: 1000, diasComDados: 2, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0,
      comparativo, recuperacao: null,
    });
    assert.ok(![...d.pontosFortes, ...d.pontosAtencao, ...d.alertas].some((a) => a.categoria === "faturamento"));
  });
});

// ---------------------------------------------------------------------------
describe("Caso F — 9 dias pendentes geram alerta acionável", () => {
  test("CTA 'Regularizar 9 dias' aponta para a aba de lançamentos", () => {
    const datas = ["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10"];
    const d = gerarDiagnostico({
      indicadores: baseIndicadores(), faturamentoBase: 1000, diasComDados: 1, diasPendentes: 9, diasPendentesDatas: datas, diasEstimados: 0,
      comparativo: null, recuperacao: null,
    });
    const achado = [...d.pontosAtencao, ...d.alertas].find((a) => a.id === "dias_pendentes");
    assert.ok(achado);
    assert.match(achado.titulo, /9/);
    const acao = d.acoes.find((a) => a.diagnosticoId === "dias_pendentes");
    assert.equal(acao.titulo, "Regularizar 9 dias");
    assert.equal(acao.cta.aba, "lancamentos");
    // amostra mostra só os 5 primeiros + "+N dias" (item 20 do pedido)
    assert.match(acao.descricao, /\+4 dia/);
  });
});

// ---------------------------------------------------------------------------
describe("Caso G — dados financeiros ausentes não geram números falsos", () => {
  test("mês sem nenhum lançamento -> semDadosSuficientes, nenhum achado inventado", () => {
    const d = gerarDiagnostico({
      indicadores: baseIndicadores(), faturamentoBase: null, diasComDados: 0, diasPendentes: 30, diasPendentesDatas: [], diasEstimados: 0,
      comparativo: null, recuperacao: null,
    });
    assert.equal(d.semDadosSuficientes, true);
    assert.deepEqual(d.pontosFortes, []);
    assert.deepEqual(d.alertas, []);
    assert.deepEqual(d.acoes, []);
  });

  test("mês com faturamento mas SEM detalhamento (ex.: só lançamento mensal) -> 'dados insuficientes', nunca '0% dentro da meta'", () => {
    const d = gerarDiagnostico({
      indicadores: baseIndicadores(), faturamentoBase: 31000, diasComDados: 31, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 31,
      comparativo: null, recuperacao: null,
    });
    const achado = d.pontosAtencao.find((a) => a.id === "detalhamento_financeiro_ausente");
    assert.ok(achado, "deveria sinalizar detalhamento ausente");
    assert.ok(!d.pontosFortes.some((a) => /taxas_comissoes|servicos_promocoes/.test(a.categoria)), "não deveria fingir indicador dentro da meta sem dado");
  });
});

// ---------------------------------------------------------------------------
describe("Caso H — mês anterior com distribuição mensal estimada", () => {
  test("comparativo sinaliza temEstimativa=true; o texto avisa que não é dado diário real", () => {
    const comparativo = { tipo: "mes_fechado", diaComparado: null, atual: 40000, anterior: 31000, diferenca: 9000, pct: 29.03, temEstimativa: true };
    const d = gerarDiagnostico({
      indicadores: baseIndicadores(), faturamentoBase: 40000, diasComDados: 30, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0,
      comparativo, recuperacao: null,
    });
    const achado = d.pontosFortes.find((a) => a.id === "faturamento_cresceu");
    assert.ok(achado);
    assert.match(achado.descricao, /estimado por distribuição mensal/);
  });
});

// ---------------------------------------------------------------------------
describe("Plano de recuperação — cenários quando a meta integral é pouco provável", () => {
  test("média necessária mais que o dobro da atual -> cenários, não uma meta inventada como certa", () => {
    const comparativo = { tipo: "mesmo_periodo", diaComparado: 2, atual: 3600, anterior: 40000, diferenca: -36400, pct: -91, temEstimativa: false };
    const recuperacao = {
      referencia: 80000, atual: 3600, faltante: 76400, diasRestantes: 2,
      mediaAtual: 1800, mediaNecessaria: 38200, poucoProvavel: true,
      cenarios: { conservador: 1800, parcial: 1980, forte: 2160 },
    };
    const d = gerarDiagnostico({
      indicadores: baseIndicadores(), faturamentoBase: 3600, diasComDados: 2, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0,
      comparativo, recuperacao,
    });
    const acao = d.acoes.find((a) => a.diagnosticoId === "faturamento_caiu");
    assert.ok(acao);
    assert.equal(acao.titulo, "Cenários para o restante do mês");
    assert.match(acao.descricao, /conservador/);
    assert.match(acao.descricao, /recuperação forte/);
    assert.ok(!/certeza/.test(acao.descricao));
  });

  test("meta alcançável -> plano direto com média necessária", () => {
    const comparativo = { tipo: "mesmo_periodo", diaComparado: 15, atual: 20000, anterior: 30000, diferenca: -10000, pct: -33.3, temEstimativa: false };
    const recuperacao = {
      referencia: 80000, atual: 40000, faltante: 40000, diasRestantes: 15,
      mediaAtual: 1800, mediaNecessaria: 2666.67, poucoProvavel: false,
      cenarios: { conservador: 1800, parcial: 1980, forte: 2160 },
    };
    const d = gerarDiagnostico({
      indicadores: baseIndicadores(), faturamentoBase: 40000, diasComDados: 15, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0,
      comparativo, recuperacao,
    });
    const acao = d.acoes.find((a) => a.diagnosticoId === "faturamento_caiu");
    assert.equal(acao.titulo, "Plano de recuperação do faturamento");
    assert.match(acao.descricao, /2\.666,67/);
    assert.match(acao.descricao, /15 dia/);
  });
});

// ---------------------------------------------------------------------------
describe("confiabilidadeDados — regras objetivas e centralizadas", () => {
  test("mês completo sem pendências nem estimativas -> alta", () => {
    assert.equal(confiabilidadeDados({ diasComDados: 30, diasPendentes: 0, diasEstimados: 0 }).nivel, "alta");
  });
  test("alguns dias pendentes -> média", () => {
    assert.equal(confiabilidadeDados({ diasComDados: 25, diasPendentes: 2, diasEstimados: 0 }).nivel, "media");
  });
  test("muitos dias pendentes -> baixa", () => {
    assert.equal(confiabilidadeDados({ diasComDados: 10, diasPendentes: LIMIARES_DIAGNOSTICO.diasPendentesParaBaixa, diasEstimados: 0 }).nivel, "baixa");
  });
  test("qualquer dia estimado por distribuição mensal -> baixa (mesmo sem pendência)", () => {
    assert.equal(confiabilidadeDados({ diasComDados: 30, diasPendentes: 0, diasEstimados: 5 }).nivel, "baixa");
  });
  test("sem nenhum lançamento -> indisponível", () => {
    assert.equal(confiabilidadeDados({ diasComDados: 0, diasPendentes: 30, diasEstimados: 0 }).nivel, "indisponivel");
  });
});

// ---------------------------------------------------------------------------
describe("Total de Deduções — aponta o componente com maior participação, sem inferir causa", () => {
  test("identifica o maior componente entre os conhecidos", () => {
    const faturamentoBase = 50000;
    const indicadores = baseIndicadores({ faturamentoBase });
    indicadores.taxas_comissoes = indicador({ atual: 18, valor: 9000, metaIdeal: 20.5, limite: 20.5, faturamentoBase });
    indicadores.servicos_promocoes = indicador({ atual: 12, valor: 6000, metaIdeal: 10, limite: 15, faturamentoBase });
    indicadores.total_deducoes = indicador({ atual: 30, valor: 15000, metaIdeal: 30.5, limite: 32, faturamentoBase });
    // dentro da própria meta -> ponto forte, sem "maior componente" (não se aplica)
    const dentro = gerarDiagnostico({ indicadores, faturamentoBase, diasComDados: 20, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0, comparativo: null, recuperacao: null });
    assert.ok(dentro.pontosFortes.some((a) => a.id === "total_deducoes_dentro_da_meta"));

    indicadores.total_deducoes = indicador({ atual: 33, valor: 16500, metaIdeal: 30.5, limite: 32, faturamentoBase });
    const fora = gerarDiagnostico({ indicadores, faturamentoBase, diasComDados: 20, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0, comparativo: null, recuperacao: null });
    const achado = fora.alertas.find((a) => a.categoria === "total_deducoes");
    assert.match(achado.descricao, /Taxas e Comissões/); // 18% > 12% -> maior participação
    assert.match(achado.descricao, /não significa necessariamente a causa/i); // nunca infere causa
  });
});

// ===========================================================================
// REFORMULAÇÃO DO PLANO DE AÇÃO — classificação semântica, manutenção e resumo
// ===========================================================================

const TERMOS_NEGATIVOS = /(acima|ultrapass|excesso|reduz|cortar|estour|fora da meta|crítico|problema|piora|alerta)/i;

describe("Classificação semântica — CRITICAL / WARNING / HEALTHY / DATA_PENDING", () => {
  const fb = 50000;

  test("indicador acima do limite -> acao tipo CRITICAL, card completo", () => {
    const indicadores = baseIndicadores({ faturamentoBase: fb });
    indicadores.taxas_entregadores = indicador({ atual: 15.7, valor: 7850, metaIdeal: 12, limite: 15, faturamentoBase: fb });

    const d = gerarDiagnostico({ indicadores, faturamentoBase: fb, diasComDados: 18, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0, comparativo: null, recuperacao: null });
    const acao = d.acoes.find((a) => a.categoria === "taxas_entregadores");
    assert.equal(acao.tipo, "CRITICAL");
    assert.equal(acao.prioridade, 1);
    assert.equal(acao.situacao, "15.7% do faturamento");
    assert.deepEqual(acao.meta, { ideal: 12, limite: 15 });
    assert.ok(perto(acao.diferenca.pp, 3.7));
    assert.ok(perto(acao.diferenca.reais, 350)); // excesso sobre o LIMITE
    assert.match(acao.impacto, /R\$ 350,00/);
    assert.equal(acao.objetivo.proximo, "≤ 15.0%");
    assert.match(acao.objetivo.ideal, /12\.0%/);
    assert.ok(acao.acaoRecomendada && acao.acaoRecomendada !== acao.explicacao, "ação != explicação");
  });

  test("indicador acima da meta ideal mas dentro do limite -> WARNING, sem linguagem crítica", () => {
    const indicadores = baseIndicadores({ faturamentoBase: fb });
    indicadores.servicos_promocoes = indicador({ atual: 6.2, valor: 3100, metaIdeal: 5, limite: 7, faturamentoBase: fb });

    const d = gerarDiagnostico({ indicadores, faturamentoBase: fb, diasComDados: 18, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0, comparativo: null, recuperacao: null });
    const acao = d.acoes.find((a) => a.categoria === "servicos_promocoes");
    assert.equal(acao.tipo, "WARNING");
    assert.equal(acao.prioridade, 2);
    assert.match(acao.explicacao, /ainda dentro do limite/i);
    assert.ok(!/ultrapass/i.test(acao.explicacao), "WARNING não diz que ultrapassou o limite");
    assert.equal(acao.objetivo.proximo, "≤ 5.0%");
  });

  test("indicador dentro da meta -> NÃO entra em acoes, entra em manutencao (HEALTHY)", () => {
    const indicadores = baseIndicadores({ faturamentoBase: fb });
    indicadores.taxas_comissoes = indicador({ atual: 12, valor: 6000, metaIdeal: 13, limite: 13, faturamentoBase: fb });

    const d = gerarDiagnostico({ indicadores, faturamentoBase: fb, diasComDados: 18, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0, comparativo: null, recuperacao: null });
    assert.ok(!d.acoes.some((a) => a.categoria === "taxas_comissoes"));
    const m = d.manutencao.find((x) => x.categoria === "taxas_comissoes");
    assert.ok(m, "deveria gerar item de manutenção");
    assert.equal(m.tipo, "HEALTHY");
    assert.equal(m.status, "Dentro da meta");
    assert.equal(m.diagnosticoId, "taxas_comissoes_dentro_da_meta");
    assert.ok(perto(m.diferenca.pp, 1)); // 13 - 12
    assert.ok(m.comoPreservar && m.comoPreservar.length > 10);
    assert.match(m.objetivo.ideal, /permanecer/);
    assert.ok(m.cta && m.cta.aba === "indicadores");
  });

  test("HEALTHY produz ação real de preservação, sem linguagem negativa", () => {
    const indicadores = baseIndicadores({ faturamentoBase: fb });
    indicadores.taxas_comissoes = indicador({ atual: 12, valor: 6000, metaIdeal: 13, limite: 13, faturamentoBase: fb });
    indicadores.servicos_promocoes = indicador({ atual: 3.5, valor: 1750, metaIdeal: 5, limite: 7, faturamentoBase: fb });

    const d = gerarDiagnostico({ indicadores, faturamentoBase: fb, diasComDados: 20, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0, comparativo: null, recuperacao: null });
    for (const m of d.manutencao) {
      assert.ok(!TERMOS_NEGATIVOS.test(m.titulo), `titulo negativo: ${m.titulo}`);
      assert.ok(!TERMOS_NEGATIVOS.test(m.explicacao), `explicacao negativa: ${m.explicacao}`);
      assert.ok(!TERMOS_NEGATIVOS.test(m.comoPreservar), `comoPreservar negativo: ${m.comoPreservar}`);
      assert.match(m.explicacao, /dentro da (meta|faixa)/i);
    }
  });

  test("metaIdeal == limite -> nunca gera WARNING (consequência da regra de domínio, não caso especial)", () => {
    const indicadores = baseIndicadores({ faturamentoBase: fb });
    // 20,6% com meta ideal E limite em 20,5% -> passou dos dois de uma vez
    indicadores.taxas_comissoes = indicador({ atual: 20.6, valor: 10300, metaIdeal: 20.5, limite: 20.5, faturamentoBase: fb });

    const d = gerarDiagnostico({ indicadores, faturamentoBase: fb, diasComDados: 20, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0, comparativo: null, recuperacao: null });
    const acao = d.acoes.find((a) => a.categoria === "taxas_comissoes");
    assert.equal(acao.tipo, "CRITICAL");
    assert.ok(!d.acoes.some((a) => a.categoria === "taxas_comissoes" && a.tipo === "WARNING"));
    assert.equal(acao.objetivo.ideal, null); // não sugere "aproximar de" quando ideal == limite
  });

  test("dias pendentes -> DATA_PENDING, nunca CRITICAL/WARNING, sem impacto financeiro", () => {
    const indicadores = baseIndicadores({ faturamentoBase: fb });
    indicadores.taxas_comissoes = indicador({ atual: 12, valor: 6000, metaIdeal: 13, limite: 13, faturamentoBase: fb });
    const datas = ["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"];

    const d = gerarDiagnostico({ indicadores, faturamentoBase: fb, diasComDados: 10, diasPendentes: 6, diasPendentesDatas: datas, diasEstimados: 0, comparativo: null, recuperacao: null });
    const acao = d.acoes.find((a) => a.categoria === "dados");
    assert.equal(acao.tipo, "DATA_PENDING");
    assert.equal(acao.impacto, null);
    assert.equal(acao.meta, null);
    assert.equal(acao.prioridade, 3); // sempre depois de CRITICAL/WARNING
  });
});

describe("Impacto financeiro só com base válida", () => {
  test("com faturamentoBase -> impacto em R$ presente", () => {
    const fb = 50000;
    const indicadores = baseIndicadores({ faturamentoBase: fb });
    indicadores.servicos_promocoes = indicador({ atual: 6, valor: 3000, metaIdeal: 5, limite: 7, faturamentoBase: fb });
    const d = gerarDiagnostico({ indicadores, faturamentoBase: fb, diasComDados: 18, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0, comparativo: null, recuperacao: null });
    const acao = d.acoes.find((a) => a.categoria === "servicos_promocoes");
    assert.match(acao.impacto, /R\$/);
    assert.equal(acao.ordenacao.temImpacto, true);
    assert.ok(perto(acao.diferenca.reais, 500));
  });

  test("sem faturamentoBase -> nunca inventa impacto (impacto null, ordenacao.temImpacto false)", () => {
    const indicadores = {
      taxas_comissoes: indicador({ atual: 18, valor: null, metaIdeal: 13, limite: 13, faturamentoBase: null }),
      servicos_promocoes: indicador({ atual: 9, valor: null, metaIdeal: 5, limite: 7, faturamentoBase: null }),
      taxas_entregadores: indicador({ atual: null, valor: null, metaIdeal: 12, limite: 15, faturamentoBase: null }),
      total_deducoes: indicador({ atual: null, valor: null, metaIdeal: 30, limite: 32, faturamentoBase: null }),
    };
    const d = gerarDiagnostico({ indicadores, faturamentoBase: null, diasComDados: 15, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0, comparativo: null, recuperacao: null });
    const acao = d.acoes.find((a) => a.categoria === "servicos_promocoes");
    assert.equal(acao.impacto, null);
    assert.equal(acao.ordenacao.temImpacto, false);
    assert.equal(acao.diferenca.reais, null);
  });
});

describe("Resumo operacional determinístico", () => {
  const fb = 50000;
  const base = (over = {}) => ({
    indicadores: baseIndicadores({ faturamentoBase: fb }),
    faturamentoBase: fb, diasComDados: 20, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0,
    comparativo: null, recuperacao: null, ...over,
  });

  test("com CRITICAL -> estado CRITICO", () => {
    const input = base();
    input.indicadores.taxas_entregadores = indicador({ atual: 16, valor: 8000, metaIdeal: 12, limite: 15, faturamentoBase: fb });
    const { resumo } = gerarDiagnostico(input);
    assert.equal(resumo.estado, "CRITICO");
    assert.equal(resumo.contadores.criticos, 1);
    assert.match(resumo.texto, /Taxas de Entregadores/);
  });

  test("só WARNING -> estado ATENCAO", () => {
    const input = base();
    input.indicadores.servicos_promocoes = indicador({ atual: 6.2, valor: 3100, metaIdeal: 5, limite: 7, faturamentoBase: fb });
    input.indicadores.taxas_comissoes = indicador({ atual: 12, valor: 6000, metaIdeal: 13, limite: 13, faturamentoBase: fb });
    const { resumo } = gerarDiagnostico(input);
    assert.equal(resumo.estado, "ATENCAO");
    assert.equal(resumo.contadores.criticos, 0);
    assert.equal(resumo.contadores.atencoes, 1);
  });

  test("sem CRITICAL/WARNING + confiabilidade alta -> estado SAUDAVEL", () => {
    const input = base();
    input.indicadores.taxas_comissoes = indicador({ atual: 12, valor: 6000, metaIdeal: 13, limite: 13, faturamentoBase: fb });
    input.indicadores.servicos_promocoes = indicador({ atual: 3, valor: 1500, metaIdeal: 5, limite: 7, faturamentoBase: fb });
    const { resumo } = gerarDiagnostico(input);
    assert.equal(resumo.estado, "SAUDAVEL");
    assert.match(resumo.manchete, /saudável/i);
  });

  test("sem CRITICAL/WARNING + confiabilidade baixa -> NÃO diz 'saudável', estado DADOS_INSUFICIENTES", () => {
    const input = base({ diasEstimados: 5, diasComDados: 31 });
    input.indicadores.taxas_comissoes = indicador({ atual: 12, valor: 6000, metaIdeal: 13, limite: 13, faturamentoBase: fb });
    const { resumo } = gerarDiagnostico(input);
    assert.equal(resumo.estado, "DADOS_INSUFICIENTES");
    assert.ok(!/excelente|saudável|ótim/i.test(resumo.texto));
    assert.match(resumo.texto, /dentro dos parâmetros/i);
  });

  test("texto é 100% determinístico (mesmo input -> mesma string)", () => {
    const a = gerarDiagnostico(base()).resumo.texto;
    const b = gerarDiagnostico(base()).resumo.texto;
    assert.equal(a, b);
  });
});

describe("Plano nunca fica conceitualmente vazio quando há indicadores válidos", () => {
  test("operação 100% saudável -> acoes vazio, mas manutencao preenchida + resumo útil", () => {
    const fb = 40000;
    const indicadores = {
      taxas_comissoes: indicador({ atual: 12, valor: 4800, metaIdeal: 13, limite: 13, faturamentoBase: fb }),
      servicos_promocoes: indicador({ atual: 4, valor: 1600, metaIdeal: 5, limite: 7, faturamentoBase: fb }),
      taxas_entregadores: indicador({ atual: 10, valor: 4000, metaIdeal: 12, limite: 15, faturamentoBase: fb }),
      total_deducoes: indicador({ atual: 26, valor: 10400, metaIdeal: 30, limite: 32, faturamentoBase: fb }),
    };
    const d = gerarDiagnostico({ indicadores, faturamentoBase: fb, diasComDados: 20, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0, comparativo: null, recuperacao: null });
    assert.equal(d.acoes.length, 0);
    assert.equal(d.manutencao.length, 4);
    assert.notEqual(d.resumo.texto, "");
    assert.equal(d.semDadosSuficientes, false);
  });

  test("mês sem nenhum lançamento -> semDadosSuficientes + resumo DADOS_INSUFICIENTES (sem inventar nada)", () => {
    const d = gerarDiagnostico({
      indicadores: baseIndicadores(), faturamentoBase: null, diasComDados: 0, diasPendentes: 30, diasPendentesDatas: [], diasEstimados: 0,
      comparativo: null, recuperacao: null,
    });
    assert.equal(d.semDadosSuficientes, true);
    assert.deepEqual(d.manutencao, []);
    assert.equal(d.resumo.estado, "DADOS_INSUFICIENTES");
  });
});

describe("Ordenação determinística e explicável", () => {
  test("CRITICAL antes de WARNING antes de DATA_PENDING; desempate por impacto R$", () => {
    const fb = 100000;
    const indicadores = {
      // dois WARNING: servicos com excesso R$ maior que total_deducoes
      taxas_comissoes: indicador({ atual: 10, valor: 10000, metaIdeal: 13, limite: 13, faturamentoBase: fb }),
      servicos_promocoes: indicador({ atual: 6.5, valor: 6500, metaIdeal: 5, limite: 7, faturamentoBase: fb }), // excesso 1500
      taxas_entregadores: indicador({ atual: 17, valor: 17000, metaIdeal: 12, limite: 15, faturamentoBase: fb }), // CRITICAL
      total_deducoes: indicador({ atual: 30.5, valor: 30500, metaIdeal: 30, limite: 32, faturamentoBase: fb }), // excesso 500
    };
    const datas = ["2026-08-02"];
    const d = gerarDiagnostico({ indicadores, faturamentoBase: fb, diasComDados: 10, diasPendentes: 1, diasPendentesDatas: datas, diasEstimados: 0, comparativo: null, recuperacao: null });
    const tipos = d.acoes.map((a) => a.tipo);
    assert.deepEqual(tipos, ["CRITICAL", "WARNING", "WARNING", "DATA_PENDING"]);
    // entre os dois WARNING, o de maior excesso em R$ vem primeiro
    const warnings = d.acoes.filter((a) => a.tipo === "WARNING");
    assert.equal(warnings[0].categoria, "servicos_promocoes");
    assert.equal(warnings[1].categoria, "total_deducoes");
  });

  test("mesma entrada -> mesma ordem (estável)", () => {
    const fb = 50000;
    const mk = () => {
      const i = baseIndicadores({ faturamentoBase: fb });
      i.servicos_promocoes = indicador({ atual: 6, valor: 3000, metaIdeal: 5, limite: 7, faturamentoBase: fb });
      i.taxas_entregadores = indicador({ atual: 16, valor: 8000, metaIdeal: 12, limite: 15, faturamentoBase: fb });
      return i;
    };
    const a = gerarDiagnostico({ indicadores: mk(), faturamentoBase: fb, diasComDados: 15, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0, comparativo: null, recuperacao: null });
    const b = gerarDiagnostico({ indicadores: mk(), faturamentoBase: fb, diasComDados: 15, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0, comparativo: null, recuperacao: null });
    assert.deepEqual(a.acoes.map((x) => x.diagnosticoId), b.acoes.map((x) => x.diagnosticoId));
  });
});

describe("Sem tendência inventada nos indicadores individuais", () => {
  test("nenhuma ação/manutenção de indicador percentual carrega campo de tendência", () => {
    const fb = 50000;
    const indicadores = baseIndicadores({ faturamentoBase: fb });
    indicadores.taxas_comissoes = indicador({ atual: 12, valor: 6000, metaIdeal: 13, limite: 13, faturamentoBase: fb });
    indicadores.servicos_promocoes = indicador({ atual: 6.2, valor: 3100, metaIdeal: 5, limite: 7, faturamentoBase: fb });
    const d = gerarDiagnostico({ indicadores, faturamentoBase: fb, diasComDados: 18, diasPendentes: 0, diasPendentesDatas: [], diasEstimados: 0, comparativo: null, recuperacao: null });
    for (const item of [...d.acoes, ...d.manutencao]) {
      if (item.categoria === "faturamento") continue;
      assert.ok(!("tendencia" in item), `${item.categoria} não deveria ter tendência`);
      assert.ok(!/tendênc|melhorando|piorando|↑|↓/i.test(JSON.stringify(item)));
    }
  });
});
