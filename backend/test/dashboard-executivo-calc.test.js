// Testes da camada de cálculo do Dashboard Executivo (dashboardExecutivo.calc.js)
// — puros, sem rede. Rodar: node --test test/dashboard-executivo-calc.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ticketMedio, percentual, totalDeducoes, receitaAposDeducoes, saldoPercentual,
  mediaDiaria, projecaoMensal, confiabilidadeProjecao, statusDiaBase, statusMes,
  resumoPreenchimento, verificarDisponibilidade, agruparPendenciasPorMes,
  validarOutrasDeducoes, inconsistencias,
  diasDoMes, mesAnterior, STATUS_DIA,
  MODELOS_LOGISTICOS, ROTULO_MODELO, INDICADORES_POR_MODELO, indicadorAplicavel,
  statusIndicador, saldoMeta, distribuirValorMensal, distribuirQuantidadeMensal,
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

// Diagnóstico executivo e recomendações viraram o motor novo em
// dashboardExecutivo.diagnostico.js (rodada 2 do Dashboard iFood) — testes
// em backend/test/dashboard-executivo-diagnostico.test.js.

// ---------------------------------------------------------------------------
// Modelo logístico do iFood (Marketplace x Full Service) — briefing novo:
// cada modelo tem seu próprio conjunto de metas, e "taxas de entregadores"
// (motoboy próprio) não existe no Full Service (quem entrega é o parceiro
// do iFood).
// ---------------------------------------------------------------------------
describe("modelo logístico — indicadores aplicáveis por modelo", () => {
  test("MODELOS_LOGISTICOS tem exatamente marketplace e full_service", () => {
    assert.deepEqual([...MODELOS_LOGISTICOS].sort(), ["full_service", "marketplace"]);
  });
  test("rótulos em pt-BR existem para os dois modelos", () => {
    assert.equal(ROTULO_MODELO.marketplace, "Marketplace");
    assert.equal(ROTULO_MODELO.full_service, "Full Service");
  });
  test("Marketplace tem os 4 indicadores, incluindo taxas de entregadores", () => {
    assert.deepEqual([...INDICADORES_POR_MODELO.marketplace].sort(), ["servicos_promocoes", "taxas_comissoes", "taxas_entregadores", "total_deducoes"]);
    assert.equal(indicadorAplicavel("marketplace", "taxas_entregadores"), true);
  });
  test("Full Service NÃO tem taxas de entregadores (quem entrega é o parceiro do iFood)", () => {
    assert.deepEqual([...INDICADORES_POR_MODELO.full_service].sort(), ["servicos_promocoes", "taxas_comissoes", "total_deducoes"]);
    assert.equal(indicadorAplicavel("full_service", "taxas_entregadores"), false);
  });
  test("os demais 3 indicadores são aplicáveis nos dois modelos", () => {
    for (const modelo of MODELOS_LOGISTICOS) {
      for (const chave of ["taxas_comissoes", "servicos_promocoes", "total_deducoes"]) {
        assert.equal(indicadorAplicavel(modelo, chave), true, `${chave} deveria ser aplicável em ${modelo}`);
      }
    }
  });
});

// (o respeito ao modelo logístico no diagnóstico agora é testado no motor
// novo — dashboard-executivo-diagnostico.test.js)

// ---------------------------------------------------------------------------
// Desempenho opcional / "não informado" ≠ "zero" (rodada 2 do Dashboard iFood)
// ---------------------------------------------------------------------------
describe("ticket médio — nenhum dos dois lados vira 0 por conta própria", () => {
  test("valor bruto ausente, quantidade presente -> null (não R$ 0,00)", () => {
    assert.equal(ticketMedio(null, 50), null);
    assert.equal(ticketMedio(undefined, 50), null);
  });
  test("os dois presentes calcula normalmente", () => {
    assert.ok(perto(ticketMedio(1000, 10), 100));
  });
});

describe("totalDeducoes / percentual — null quando não há dado, nunca inventa 0", () => {
  test("as 4 deduções ausentes -> total null (não 0)", () => {
    assert.equal(totalDeducoes({ taxasComissoes: null, servicosPromocoes: null, taxasEntregadores: null, outrasDeducoes: null }), null);
  });
  test("algumas presentes -> soma só as conhecidas (melhor esforço)", () => {
    assert.equal(totalDeducoes({ taxasComissoes: 100, servicosPromocoes: null, taxasEntregadores: null, outrasDeducoes: null }), 100);
  });
  test("percentual(null, base) -> null, nunca 0%", () => {
    assert.equal(percentual(null, 1000), null);
  });
  test("receitaAposDeducoes com total null -> null (não finge deduções = 0)", () => {
    assert.equal(receitaAposDeducoes(1000, null), null);
  });
});

describe("statusIndicador — fonte única de status (Caso G, H, I do pedido)", () => {
  const meta = { metaIdeal: 20, limite: 20.5 };
  test("Caso G: 18% com meta 20%/limite 20,5% -> dentro da meta", () => {
    assert.equal(statusIndicador(18, meta).chave, "dentro_da_meta");
  });
  test("Caso H: acima do limite -> fora da meta (card deve indicar o excesso)", () => {
    assert.equal(statusIndicador(25, meta).chave, "fora_da_meta");
  });
  test("entre meta ideal e limite -> atenção", () => {
    assert.equal(statusIndicador(20.2, meta).chave, "atencao");
  });
  test("Caso I: taxas não informadas (atual null) -> dados insuficientes, NUNCA 'dentro da meta'", () => {
    const s = statusIndicador(null, meta);
    assert.equal(s.chave, "sem_dados");
    assert.notEqual(s.label, "Dentro da meta");
  });
  test("sem meta configurada -> dados insuficientes", () => {
    assert.equal(statusIndicador(18, null).chave, "sem_dados");
  });
});

describe("saldoMeta — quanto ainda resta, em p.p. e em R$", () => {
  test("18,1% usado / limite 20% -> restam 1,9 p.p.", () => {
    const s = saldoMeta({ valorUtilizado: 6132.86, percentualUtilizado: 18.1, limitePct: 20, faturamentoBase: 33883.75 });
    assert.ok(perto(s.disponivelPp, 1.9, 0.01));
    assert.equal(s.status, "disponivel");
  });
  test("limite em reais e saldo em reais são calculados a partir do faturamento base", () => {
    const s = saldoMeta({ valorUtilizado: 5950, percentualUtilizado: 11.9, limitePct: 15, faturamentoBase: 50000 });
    assert.ok(perto(s.limiteReais, 7500));
    assert.ok(perto(s.disponivelReais, 1550));
  });
  test("valor utilizado igual ao limite -> limite atingido, saldo 0", () => {
    const s = saldoMeta({ valorUtilizado: 100, percentualUtilizado: 20, limitePct: 20, faturamentoBase: 500 });
    assert.equal(s.status, "limite_atingido");
    assert.equal(s.disponivelPp, 0);
  });
  test("acima do limite -> status acima_do_limite com saldo negativo", () => {
    const s = saldoMeta({ valorUtilizado: 130, percentualUtilizado: 26, limitePct: 20, faturamentoBase: 500 });
    assert.equal(s.status, "acima_do_limite");
    assert.ok(s.disponivelPp < 0);
  });
  test("sem percentual apurado -> sem_dados, nunca finge 'dentro da meta'", () => {
    const s = saldoMeta({ valorUtilizado: null, percentualUtilizado: null, limitePct: 20, faturamentoBase: 500 });
    assert.equal(s.status, "sem_dados");
    assert.equal(s.disponivelPp, null);
  });
});

describe("distribuirValorMensal — a soma NUNCA diverge de um centavo (Caso C do pedido)", () => {
  test("R$ 31.000,00 / 31 dias = R$ 1.000,00 por dia, exatos", () => {
    const fatias = distribuirValorMensal(31000, 31);
    assert.equal(fatias.length, 31);
    assert.ok(fatias.every((f) => f === 1000));
  });
  test("R$ 10.000,00 / 31 dias — soma exata, resto nos primeiros dias", () => {
    const fatias = distribuirValorMensal(10000, 31);
    assert.equal(fatias.length, 31);
    const soma = fatias.reduce((s, f) => s + f, 0);
    assert.ok(perto(soma, 10000, 1e-9), `soma foi ${soma}`);
    // 10000 / 31 = 322,58064... -> resto de 2 centavos vai pros 2 primeiros dias
    assert.ok(perto(fatias[0], 322.59));
    assert.ok(perto(fatias[1], 322.59));
    assert.ok(perto(fatias[2], 322.58));
  });
  test("valor que não divide exatamente em nenhum caso (R$ 100,01 / 3 dias)", () => {
    const fatias = distribuirValorMensal(100.01, 3);
    const soma = fatias.reduce((s, f) => s + f, 0);
    assert.ok(perto(soma, 100.01, 1e-9));
  });
  test("dias <= 0 devolve lista vazia (sem dividir por zero)", () => {
    assert.deepEqual(distribuirValorMensal(1000, 0), []);
  });
});

describe("distribuirQuantidadeMensal — mesma exatidão, para contagens inteiras", () => {
  test("100 pedidos / 31 dias — soma exata, resto nos primeiros dias", () => {
    const fatias = distribuirQuantidadeMensal(100, 31);
    assert.equal(fatias.length, 31);
    assert.equal(fatias.reduce((s, f) => s + f, 0), 100);
    assert.ok(fatias.every((f) => Number.isInteger(f)));
    // 100 / 31 = 3 resto 7 -> 7 primeiros dias com 4, os outros 24 com 3
    assert.equal(fatias.slice(0, 7).every((f) => f === 4), true);
    assert.equal(fatias.slice(7).every((f) => f === 3), true);
  });
  test("dias <= 0 devolve lista vazia", () => {
    assert.deepEqual(distribuirQuantidadeMensal(50, 0), []);
  });
});
