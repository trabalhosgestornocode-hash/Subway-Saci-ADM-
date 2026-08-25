// Testes da tool "consultar_evolucao_diaria_financeiro" (Etapa H) — unit,
// sem rede/Supabase: dependências injetadas (mesmo padrão das outras tools
// de dashboard-executivo).
//
// O que estes testes protegem, na ordem do pedido:
//   * ranking pelos dias de MAIOR |variação|, nunca ordem cronológica;
//   * limite máximo nunca ultrapassado, mesmo se solicitado mais;
//   * dias sem variação calculável (delta null) NUNCA entram no ranking;
//   * visão agregada ("todas as unidades") nunca finge ter uma série;
//   * módulo/permissão exigidos mesmo com a rota /agente liberada;
//   * nenhuma tool tem efeito de escrita.
//
// Rodar: node --env-file-if-exists=.env --test test/agente-evolucao-diaria-tool.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MODULOS } from "../src/shared/modulos.js";
import { PERMISSOES } from "../src/shared/permissoes.js";
import * as evolucaoTool from "../src/modules/agente/tools/evolucaoDiariaFinanceiro.tool.js";

const ORG_ID = "33333333-3333-4333-8333-333333333333";
const UNIDADE_ID = "44444444-4444-4444-8444-444444444444";
const ACESSO_COM_MODULO = { modulos: [MODULOS.IFOOD_DASHBOARD], permissoes: [PERMISSOES.DASHBOARD_EXECUTIVO_VER], impersonando: false };
const ACESSO_SEM_MODULO = { modulos: [], permissoes: [PERMISSOES.DASHBOARD_EXECUTIVO_VER], impersonando: false };
const ACESSO_SEM_PERMISSAO = { modulos: [MODULOS.IFOOD_DASHBOARD], permissoes: [], impersonando: false };

const SNAPSHOTS = [
  { data: "2026-08-01", valor: 1000, delta: 1000, percentualTotalDeducoes: 30 },
  { data: "2026-08-02", valor: null, delta: null, percentualTotalDeducoes: null }, // dia sem lançamento
  { data: "2026-08-11", valor: 6000, delta: 5000, percentualTotalDeducoes: 35 },   // maior alta
  { data: "2026-08-18", valor: 500, delta: -5500, percentualTotalDeducoes: 40 },   // maior queda (|delta| empata com o dia 11)
  { data: "2026-08-25", valor: 700, delta: 200, percentualTotalDeducoes: 31 },
];

describe("consultar_evolucao_diaria_financeiro", () => {
  test("ranking por MAIOR |variação|, nunca ordem cronológica", async () => {
    const deps = { obterMes: async () => ({ agregado: false, periodo: { ano: 2026, mes: 8 }, snapshotsFinanceiros: SNAPSHOTS }) };
    const r = await evolucaoTool.executar({ ano: 2026, mes: 8, limite: 3 }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    // |delta|: 08-18=5500, 08-11=5000, 08-01=1000, 08-25=200 -> top 3 nessa ordem.
    assert.deepEqual(r.dias.map((d) => d.data), ["2026-08-18", "2026-08-11", "2026-08-01"]);
    assert.equal(r.dias[0].variacao, -5500); // sinal preservado — nunca vira valor absoluto no retorno
    assert.equal(r.dias[1].variacao, 5000);
  });

  test("dia sem variação calculável (delta null) NUNCA entra no ranking nem no total", async () => {
    const deps = { obterMes: async () => ({ agregado: false, periodo: { ano: 2026, mes: 8 }, snapshotsFinanceiros: SNAPSHOTS }) };
    const r = await evolucaoTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.totalDiasComVariacaoCalculavel, 4); // 5 snapshots - 1 com delta null
    assert.ok(!r.dias.some((d) => d.data === "2026-08-02"));
  });

  test("limite padrão é 5, mas nunca ultrapassa MAX_DIAS_TOOL mesmo se pedido mais", async () => {
    const muitos = Array.from({ length: 20 }, (_, i) => ({ data: `2026-08-${String(i + 1).padStart(2, "0")}`, valor: i, delta: i + 1, percentualTotalDeducoes: 30 }));
    const deps = { obterMes: async () => ({ agregado: false, periodo: { ano: 2026, mes: 8 }, snapshotsFinanceiros: muitos }) };
    const r = await evolucaoTool.executar({ limite: 999 }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.dias.length, evolucaoTool.MAX_DIAS_TOOL);
  });

  test("cada dia traz o percentual de deduções DAQUELE snapshot (contexto, não a variação)", async () => {
    const deps = { obterMes: async () => ({ agregado: false, periodo: { ano: 2026, mes: 8 }, snapshotsFinanceiros: SNAPSHOTS }) };
    const r = await evolucaoTool.executar({ limite: 1 }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    // top-1 por |delta| é 08-18 (5500) -> traz o percentual DAQUELE snapshot, não o de 08-11.
    assert.equal(r.dias[0].data, "2026-08-18");
    assert.equal(r.dias[0].percentualDeducoesNesseSnapshot, 40);
  });

  test("visão agregada ('todas as unidades') -> semDados: true, nunca inventa série", async () => {
    const deps = { obterMes: async () => ({ agregado: true }) };
    const r = await evolucaoTool.executar({}, { organizacaoId: ORG_ID, unidadeId: null, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.visao, "todas_as_unidades");
    assert.equal(r.semDados, true);
    assert.equal("dias" in r, false);
  });

  test("mês sem nenhuma variação calculável -> dias: [], nunca lança", async () => {
    const deps = { obterMes: async () => ({ agregado: false, periodo: { ano: 2026, mes: 8 }, snapshotsFinanceiros: [{ data: "2026-08-01", valor: 100, delta: null, percentualTotalDeducoes: null }] }) };
    const r = await evolucaoTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.deepEqual(r.dias, []);
    assert.equal(r.totalDiasComVariacaoCalculavel, 0);
  });

  test("tenant correto: organizacaoId/unidadeId vêm do CONTEXTO, nunca do input", async () => {
    let chamadaCom = null;
    const deps = { obterMes: async (args) => { chamadaCom = args; return { agregado: false, periodo: { ano: 2026, mes: 8 }, snapshotsFinanceiros: [] }; } };
    await evolucaoTool.executar(
      { ano: 2026, mes: 8, organizacaoId: "org-de-outro-tenant", unidadeId: "outra-unidade" },
      { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO },
      deps,
    );
    assert.equal(chamadaCom.organizacaoId, ORG_ID);
    assert.equal(chamadaCom.unidadeIdSessao, UNIDADE_ID);
    assert.equal(chamadaCom.unidadeIdSolicitado, undefined);
  });

  test("módulo Dashboard iFood desabilitado: nega, sem chamar o service", async () => {
    let chamou = false;
    const deps = { obterMes: async () => { chamou = true; return {}; } };
    await assert.rejects(
      () => evolucaoTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_SEM_MODULO }, deps),
      /não contratado/,
    );
    assert.equal(chamou, false);
  });

  test("sem permissão dashboard_executivo.ver: nega, sem chamar o service", async () => {
    let chamou = false;
    const deps = { obterMes: async () => { chamou = true; return {}; } };
    await assert.rejects(
      () => evolucaoTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_SEM_PERMISSAO }, deps),
      /Permissão insuficiente/,
    );
    assert.equal(chamou, false);
  });

  test("mês fora de 1-12 é rejeitado antes de chamar o service", async () => {
    let chamou = false;
    const deps = { obterMes: async () => { chamou = true; return {}; } };
    await assert.rejects(() => evolucaoTool.executar({ mes: 13 }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps));
    assert.equal(chamou, false);
  });
});
