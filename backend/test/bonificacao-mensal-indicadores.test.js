// Testes dos indicadores manuais (Pesquisas/Avaliação iFood/Pedidos com
// chamado/Cancelamentos) — acompanhamento DIÁRIO, igual à Visio (item
// corrigido a pedido do usuário; migrations 042/043 criaram e reverteram
// uma versão mensal no mesmo dia). REV SAIU desta lista na migration 052 —
// virou mensal de verdade, ver bonificacao-mensal-rev-mensal.test.js.
// Roda contra o Supabase de produção (mesma ressalva das
// demais suítes), por isso usa SEMPRE a unidade de teste isolada (migration
// 041) — nunca a Subway Saci real — e uma data (2026-08-10) que não colide
// com a data de fixture (2026-08-01/02) usada por bonificacao-mensal-
// service.test.js na MESMA unidade (os arquivos de teste rodam concorrentes
// por padrão em `node --test`, então datas diferentes = linhas diferentes,
// seguro em paralelo).
// Rodar: node --env-file=.env --test test/bonificacao-mensal-indicadores.test.js
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { obterCalendarioIndicador, salvarValorDiaIndicador, historicoMensalIndicador } from "../src/modules/bonificacao-mensal/bonificacaoMensal.service.js";

const SACI_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SACI_UNIDADE_ID = "00000000-0000-0000-0000-0000000000b1"; // unidade de teste (migration 041) — NUNCA a real
const USUARIO = { id: null, nome: "teste automatizado (bonificacao-mensal-indicadores.test.js)", email: "teste@local" };
const ANO = 2026, MES = 8;
const DATA_TESTE = "2026-08-10"; // dia isolado, não usado por nenhuma outra suíte nesta unidade

async function limpar() {
  await supabase.from("bonificacao_lancamentos_diarios").delete().eq("unidade_id", SACI_UNIDADE_ID).eq("data", DATA_TESTE);
}

describe("Indicadores manuais — validação e isolamento", () => {
  after(limpar);

  test("indicador fora da whitelist é rejeitado", async () => {
    await assert.rejects(
      () => salvarValorDiaIndicador({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, indicador: "faturamento", data: DATA_TESTE, valor: 10 }),
      (err) => { assert.match(err.message, /indicador manual inválido/i); return true; },
    );
  });

  test("dia sem lançamento aparece como PENDENTE no calendário, valor nunca vira zero", async () => {
    await limpar();
    const cal = await obterCalendarioIndicador({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, indicador: "pesquisas", ano: ANO, mes: MES });
    const dia = cal.dias.find((d) => d.data === DATA_TESTE);
    assert.equal(dia.valor, null);
    assert.equal(dia.status, "PENDENTE");
  });
});

describe("Indicadores manuais — lançar, editar, calendário e histórico", () => {
  after(limpar);

  test("lança o valor de um dia", async () => {
    await limpar();
    const r = await salvarValorDiaIndicador({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, indicador: "pesquisas", data: DATA_TESTE, valor: 6 });
    assert.equal(r.pesquisasQtd, 6);
    assert.equal(r.origem, "manual");
  });

  test("o dia aparece como PREENCHIDO no calendário", async () => {
    const cal = await obterCalendarioIndicador({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, indicador: "pesquisas", ano: ANO, mes: MES });
    const dia = cal.dias.find((d) => d.data === DATA_TESTE);
    assert.equal(dia.valor, 6);
    assert.equal(dia.status, "PREENCHIDO");
  });

  test("editar o mesmo dia atualiza (não cria 2ª linha) e preserva os outros campos do dia", async () => {
    await salvarValorDiaIndicador({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, indicador: "cancelamentos", data: DATA_TESTE, valor: 0.8 });
    const r = await salvarValorDiaIndicador({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, indicador: "pesquisas", data: DATA_TESTE, valor: 9 });
    assert.equal(r.pesquisasQtd, 9);
    assert.equal(r.cancelamentosPct, 0.8, "lançar pesquisas não pode apagar o Cancelamentos do mesmo dia");

    const { data: linhas } = await supabase.from("bonificacao_lancamentos_diarios").select("id").eq("unidade_id", SACI_UNIDADE_ID).eq("data", DATA_TESTE);
    assert.equal(linhas.length, 1, "continua sendo UMA linha do dia, não duplicou");
  });

  test("edição fica registrada na auditoria com valor anterior e novo", async () => {
    const { data: aud } = await supabase.from("plataforma_auditoria").select("detalhes")
      .eq("acao", "bonificacao_mensal.indicador_lancado").eq("entidade", "bonificacao_indicador_manual")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    assert.ok(aud, "deveria existir um registro de auditoria");
    assert.equal(aud.detalhes.indicador, "pesquisas");
    assert.equal(aud.detalhes.valorAnterior, 6);
    assert.equal(aud.detalhes.valorNovo, 9);
  });

  test("agregado do mês reflete a soma de pesquisas do(s) dia(s) lançado(s)", async () => {
    const cal = await obterCalendarioIndicador({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, indicador: "pesquisas", ano: ANO, mes: MES });
    assert.equal(cal.agregado.valorAtual, 9); // só este 1 dia lançado no mês -> soma = 9
  });

  test("histórico mensal traz o mês atual com o valor agregado", async () => {
    const hist = await historicoMensalIndicador({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, indicador: "pesquisas", meses: 3 });
    assert.equal(hist.length, 3);
    const mesAtual = hist.find((h) => h.ano === ANO && h.mes === MES);
    assert.ok(mesAtual);
    assert.equal(mesAtual.valorAtual, 9);
  });

  test("valor negativo é rejeitado", async () => {
    await assert.rejects(
      () => salvarValorDiaIndicador({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, indicador: "cancelamentos", data: DATA_TESTE, valor: -1 }),
      (err) => { assert.match(err.message, /não pode ser negativo/i); return true; },
    );
  });

  test("'rev' não é mais um indicador manual diário (migration 052 — virou mensal)", async () => {
    await assert.rejects(
      () => salvarValorDiaIndicador({ organizacaoId: SACI_ORG_ID, unidadeId: SACI_UNIDADE_ID, usuario: USUARIO, indicador: "rev", data: DATA_TESTE, valor: 88 }),
      (err) => { assert.match(err.message, /indicador manual inválido/i); return true; },
    );
  });
});
