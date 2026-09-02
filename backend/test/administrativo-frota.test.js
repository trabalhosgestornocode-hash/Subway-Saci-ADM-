// PAINEL ADMINISTRATIVO — Fase F: carregamento cross-tenant + endpoints.
//
// COMPORTAMENTAL (fake do Supabase, sem rede). Prova:
//   * quem entra no monitoramento (módulo efetivo, org operacional, unidade ativa);
//   * quem fica de fora (sem módulo, org inativa, unidade inativa, unidade de teste);
//   * a projeção de D-1 (concluída / financeiro pendente / rascunho / pendente / bloqueada);
//   * pendência que atravessa a virada de mês;
//   * D-1 correto em 01/10 (30/09) e 01/01 (31/12);
//   * conformidade da EMPRESA = Σcompletos / Σesperados (nunca média de %);
//   * cross-tenant: nenhum req.tenant, todas as empresas aparecem;
//   * N+1: nº de queries NÃO cresce com o nº de unidades;
//   * performance: 100 unidades × 31 dias consolidam sem custo O(unidades × queries).
//
// Rodar: node --test test/administrativo-frota.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  visaoGeral, monitoramentoDiario, pendencias, empresas, detalheEmpresa, calendarioUnidade, avaliarFrota,
} from "../src/modules/administrativo/administrativo.service.js";
import { D1_CATEGORIA, ROLLUP } from "../src/modules/administrativo/administrativo.status.js";
import { ApiError } from "../src/shared/ApiError.js";

const MOD = "ifood_dashboard";
const HOJE = "2026-09-15";     // D-1 = 2026-09-14 ; mês corrente set/2026 (30 dias)
const D1 = "2026-09-14";

// IDs de fixture no formato UUID (o service valida `:organizacaoId` / `:unidadeId`).
const UUID = (label) => {
  const hex = Buffer.from(String(label)).toString("hex").padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

// ---------------------------------------------------------------------------
// Fake do Supabase — só os verbos que o repo usa: select/eq/in/gte/lte/maybeSingle
// ---------------------------------------------------------------------------
function fakeDb(estado) {
  const contador = { queries: 0, porTabela: {} };
  function from(tabela) {
    const ctx = { eq: [], inFiltro: null, gte: null, lte: null };
    const rows = () => estado[tabela] ?? [];
    const casa = (r) =>
      ctx.eq.every(([c, v]) => r[c] === v) &&
      (!ctx.inFiltro || ctx.inFiltro.vals.includes(r[ctx.inFiltro.col])) &&
      (ctx.gte == null || r[ctx.gte.col] >= ctx.gte.v) &&
      (ctx.lte == null || r[ctx.lte.col] <= ctx.lte.v);
    function run(single) {
      contador.queries += 1;
      contador.porTabela[tabela] = (contador.porTabela[tabela] ?? 0) + 1;
      const achados = rows().filter(casa).map((r) => ({ ...r }));
      return Promise.resolve(single
        ? { data: achados[0] ?? null, error: null }
        : { data: achados, error: null });
    }
    const b = {
      select() { return b; },
      eq(c, v) { ctx.eq.push([c, v]); return b; },
      in(c, vals) { ctx.inFiltro = { col: c, vals }; return b; },
      gte(c, v) { ctx.gte = { col: c, v }; return b; },
      lte(c, v) { ctx.lte = { col: c, v }; return b; },
      maybeSingle() { return run(true); },
      then(res, rej) { return run(false).then(res, rej); },
    };
    return b;
  }
  return { from, __contador: contador };
}

// ---- helpers de dados ------------------------------------------------------
const org = (id, nome, over = {}) => ({ id, nome, status: "ativa", eh_modelo: false, created_at: "2025-01-01T00:00:00Z", ...over });
const uni = (id, orgId, nome, over = {}) => ({ id, organizacao_id: orgId, nome, ativo: true, eh_teste: false, created_at: "2025-01-01T00:00:00Z", ...over });
const finaliz = (u, data, over = {}) => ({ unidade_id: u, data_lancamento: data, status: "finalizado", situacao: "normal", valor_vendas_ifood: 1234, ...over });
const rascunhoFin = (u, data) => ({ unidade_id: u, data_lancamento: data, status: "rascunho", situacao: "normal", valor_vendas_ifood: null });
const semOp = (u, data) => ({ unidade_id: u, data_lancamento: data, status: "finalizado", situacao: "sem_operacao", valor_vendas_ifood: 0 });

/** Preenche (finalizado) de..ate inclusive, no mesmo mês. */
function preenche(u, de, ate) {
  const [y, m] = de.split("-").map(Number);
  const d0 = Number(de.slice(8)), d1 = Number(ate.slice(8));
  const out = [];
  for (let d = d0; d <= d1; d++) out.push(finaliz(u, `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`));
  return out;
}

/** Estado com N orgs (2 unidades cada), todas com o módulo efetivo. */
function frotaBase() {
  return {
    organizacoes: [org(UUID("o1"), "Alfa"), org(UUID("o2"), "Beta"), org(UUID("o3"), "Gama")],
    unidades: [
      uni(UUID("u1a"), UUID("o1"), "Alfa Centro"), uni(UUID("u1b"), UUID("o1"), "Alfa Sul"),
      uni(UUID("u2a"), UUID("o2"), "Beta Norte"), uni(UUID("u2b"), UUID("o2"), "Beta Leste"),
      uni(UUID("u3a"), UUID("o3"), "Gama Praia"), uni(UUID("u3b"), UUID("o3"), "Gama Serra"),
    ],
    organizacao_modulos: [UUID("o1"), UUID("o2"), UUID("o3")].map((organizacao_id) => ({ organizacao_id, modulo_id: MOD })),
    unidade_modulos: [UUID("u1a"), UUID("u1b"), UUID("u2a"), UUID("u2b"), UUID("u3a"), UUID("u3b")].map((unidade_id) => ({ unidade_id, modulo_id: MOD })),
    lancamentos_financeiros_diarios: [],
  };
}

// ===========================================================================
describe("A) 3 empresas / várias unidades — visão geral consolida a frota", () => {
  test("todas as 6 unidades entram; empresas = 3; cross-tenant sem req.tenant", async () => {
    const st = frotaBase();
    // agosto completo + setembro 1..14 completo em TODAS -> tudo em dia
    for (const u of [UUID("u1a"), UUID("u1b"), UUID("u2a"), UUID("u2b"), UUID("u3a"), UUID("u3b")]) {
      st.lancamentos_financeiros_diarios.push(...preenche(u, "2026-08-01", "2026-08-31"), ...preenche(u, "2026-09-01", D1));
    }
    const r = await visaoGeral({ hojeIso: HOJE }, { supabase: fakeDb(st) });
    assert.equal(r.resumo.unidadesMonitoradas, 6);
    assert.equal(r.resumo.empresasMonitoradas, 3);
    assert.equal(r.resumo.emDia, 6);
    assert.equal(r.resumo.concluidasD1, 6);
    assert.equal(r.resumo.conformidadeD1, 1);
    assert.equal(r.d1, D1);
    assert.equal(r.empresas.length, 3);
  });
});

describe("B/C/D — quem fica FORA do monitoramento", () => {
  test("B) unidade sem o módulo efetivo (falta unidade_modulos) -> fora", async () => {
    const st = frotaBase();
    st.unidade_modulos = st.unidade_modulos.filter((x) => x.unidade_id !== UUID("u3b"));
    const r = await avaliarFrota({ hojeIso: HOJE }, { supabase: fakeDb(st) });
    assert.equal(r.unidades.length, 5);
    assert.ok(!r.unidades.some((u) => u.unidadeId === UUID("u3b")));
  });

  test("B) empresa sem o módulo (falta organizacao_modulos) -> todas as unidades dela fora", async () => {
    const st = frotaBase();
    st.organizacao_modulos = st.organizacao_modulos.filter((x) => x.organizacao_id !== UUID("o2"));
    const r = await avaliarFrota({ hojeIso: HOJE }, { supabase: fakeDb(st) });
    assert.equal(r.unidades.length, 4);
    assert.ok(!r.unidades.some((u) => u.organizacaoId === UUID("o2")));
  });

  test("C) organização suspensa/cancelada -> fora", async () => {
    const st = frotaBase();
    st.organizacoes = st.organizacoes.map((o) => (o.id === UUID("o1") ? { ...o, status: "suspensa" } : o));
    const r = await avaliarFrota({ hojeIso: HOJE }, { supabase: fakeDb(st) });
    assert.equal(r.unidades.length, 4);
    assert.ok(!r.unidades.some((u) => u.organizacaoId === UUID("o1")));
  });

  test("C) organização eh_modelo -> fora", async () => {
    const st = frotaBase();
    st.organizacoes = st.organizacoes.map((o) => (o.id === UUID("o3") ? { ...o, eh_modelo: true } : o));
    const r = await avaliarFrota({ hojeIso: HOJE }, { supabase: fakeDb(st) });
    assert.ok(!r.unidades.some((u) => u.organizacaoId === UUID("o3")));
  });

  test("D) unidade inativa -> fora", async () => {
    const st = frotaBase();
    st.unidades = st.unidades.map((u) => (u.id === UUID("u1a") ? { ...u, ativo: false } : u));
    const r = await avaliarFrota({ hojeIso: HOJE }, { supabase: fakeDb(st) });
    assert.equal(r.unidades.length, 5);
    assert.ok(!r.unidades.some((u) => u.unidadeId === UUID("u1a")));
  });

  test("unidade eh_teste -> fora por padrão, dentro com incluirTeste", async () => {
    const st = frotaBase();
    st.unidades = st.unidades.map((u) => (u.id === UUID("u2b") ? { ...u, eh_teste: true } : u));
    assert.equal((await avaliarFrota({ hojeIso: HOJE }, { supabase: fakeDb(st) })).unidades.length, 5);
    assert.equal((await avaliarFrota({ hojeIso: HOJE, incluirTeste: true }, { supabase: fakeDb(st) })).unidades.length, 6);
  });

  test("org em status 'teste' (trial) fica FORA do monitoramento padrão", async () => {
    const st = frotaBase();
    st.organizacoes = st.organizacoes.map((o) => (o.id === UUID("o1") ? { ...o, status: "teste" } : o));
    // padrão: só orgs 'ativa' -> as 2 unidades da o1 saem
    const r = await avaliarFrota({ hojeIso: HOJE }, { supabase: fakeDb(st) });
    assert.equal(r.unidades.length, 4);
    assert.ok(!r.unidades.some((u) => u.organizacaoId === UUID("o1")));
  });

  test("incluirTeste=true (chamada diagnóstica) traz de volta a org em trial", async () => {
    const st = frotaBase();
    st.organizacoes = st.organizacoes.map((o) => (o.id === UUID("o1") ? { ...o, status: "teste" } : o));
    const r = await avaliarFrota({ hojeIso: HOJE, incluirTeste: true }, { supabase: fakeDb(st) });
    assert.equal(r.unidades.length, 6);
    assert.equal(r.unidades.filter((u) => u.organizacaoId === UUID("o1")).length, 2);
  });
});

describe("E) projeção de D-1 — cada estado do domínio", () => {
  const cenario = (over) => {
    const st = frotaBase();
    st.organizacoes = [org(UUID("o1"), "Alfa")];
    st.unidades = [
      uni(UUID("uc"), UUID("o1"), "Concluída"), uni(UUID("ufp"), UUID("o1"), "Financeiro pendente"),
      uni(UUID("urs"), UUID("o1"), "Rascunho"), uni(UUID("upe"), UUID("o1"), "Pendente"), uni(UUID("ubl"), UUID("o1"), "Bloqueada"),
    ];
    st.organizacao_modulos = [{ organizacao_id: UUID("o1"), modulo_id: MOD }];
    st.unidade_modulos = [UUID("uc"), UUID("ufp"), UUID("urs"), UUID("upe"), UUID("ubl")].map((unidade_id) => ({ unidade_id, modulo_id: MOD }));
    const L = st.lancamentos_financeiros_diarios;
    // agosto ok em todas
    for (const u of [UUID("uc"), UUID("ufp"), UUID("urs"), UUID("upe"), UUID("ubl")]) L.push(...preenche(u, "2026-08-01", "2026-08-31"));
    // concluída: set 1..14 ok
    L.push(...preenche(UUID("uc"), "2026-09-01", D1));
    // financeiro pendente: set 1..13 ok, D-1 rascunho normal SEM financeiro -> FINANCEIRO_PENDENTE
    L.push(...preenche(UUID("ufp"), "2026-09-01", "2026-09-13"), rascunhoFin(UUID("ufp"), D1));
    // rascunho: set 1..13 ok, D-1 rascunho COM financeiro (status ainda rascunho) -> RASCUNHO
    L.push(...preenche(UUID("urs"), "2026-09-01", "2026-09-13"), { unidade_id: UUID("urs"), data_lancamento: D1, status: "rascunho", situacao: "normal", valor_vendas_ifood: 500 });
    // pendente isolado: set 1..13 ok, D-1 vazio
    L.push(...preenche(UUID("upe"), "2026-09-01", "2026-09-13"));
    // bloqueada: set 1..12 ok, 13 e 14 vazios -> D-1 BLOQUEADO
    L.push(...preenche(UUID("ubl"), "2026-09-01", "2026-09-12"));
    return { ...st, ...over };
  };

  test("os 5 estados projetam para as 5 categorias administrativas", async () => {
    const r = await avaliarFrota({ hojeIso: HOJE }, { supabase: fakeDb(cenario()) });
    const cat = (id) => r.unidades.find((u) => u.unidadeId === id).d1.categoria;
    assert.equal(cat(UUID("uc")), D1_CATEGORIA.CONCLUIDO);
    assert.equal(cat(UUID("ufp")), D1_CATEGORIA.EM_PREENCHIMENTO);   // financeiro pendente NÃO é concluído
    assert.equal(cat(UUID("urs")), D1_CATEGORIA.EM_PREENCHIMENTO);
    assert.equal(cat(UUID("upe")), D1_CATEGORIA.NAO_REALIZADO);
    assert.equal(cat(UUID("ubl")), D1_CATEGORIA.SEQUENCIA_BLOQUEADA);
  });

  test("criticidade: bloqueada -> CRÍTICO ; pendente isolado / em preenchimento -> ATENÇÃO ; concluída -> EM DIA", async () => {
    const r = await avaliarFrota({ hojeIso: HOJE }, { supabase: fakeDb(cenario()) });
    const crit = (id) => r.unidades.find((u) => u.unidadeId === id).rollup.status;
    assert.equal(crit(UUID("uc")), ROLLUP.EM_DIA);
    assert.equal(crit(UUID("ufp")), ROLLUP.ATENCAO);
    assert.equal(crit(UUID("upe")), ROLLUP.ATENCAO);
    assert.equal(crit(UUID("ubl")), ROLLUP.CRITICO);
  });

  test("financeiro pendente aparece em 'Ação Necessária Hoje' e reduz conformidade", async () => {
    const vg = await visaoGeral({ hojeIso: HOJE }, { supabase: fakeDb(cenario()) });
    assert.ok(vg.acaoNecessariaHoje.some((it) => it.unidadeId === UUID("ufp")));
    const ufp = (await avaliarFrota({ hojeIso: HOJE }, { supabase: fakeDb(cenario()) })).unidades.find((u) => u.unidadeId === UUID("ufp"));
    assert.ok(ufp.conformidade.taxa < 1);
  });
});

describe("F/G/H — datas", () => {
  test("F) pendência que atravessa a virada de mês (D-1 = 01/09)", async () => {
    const HOJE2 = "2026-09-02"; // D-1 = 2026-09-01
    const st = frotaBase();
    st.organizacoes = [org(UUID("o1"), "Alfa")];
    st.unidades = [uni(UUID("u"), UUID("o1"), "U")];
    st.organizacao_modulos = [{ organizacao_id: UUID("o1"), modulo_id: MOD }];
    st.unidade_modulos = [{ unidade_id: UUID("u"), modulo_id: MOD }];
    // agosto 1..29 ok ; 30, 31 e 01/09 vazios
    st.lancamentos_financeiros_diarios.push(...preenche(UUID("u"), "2026-08-01", "2026-08-29"));
    const r = await avaliarFrota({ hojeIso: HOJE2 }, { supabase: fakeDb(st) });
    const u = r.unidades[0];
    assert.equal(u.rollup.status, ROLLUP.CRITICO);
    assert.equal(u.pendenciasAcum.desde, "2026-08-30");
    assert.ok(u.pendenciasAcum.total >= 2);
  });

  test("G) 01/10 -> referência D-1 = 30/09", async () => {
    const st = frotaBase();
    const r = await avaliarFrota({ hojeIso: "2026-10-01" }, { supabase: fakeDb(st) });
    assert.equal(r.referencia, "2026-09-30");
  });

  test("H) 01/01 -> referência D-1 = 31/12 do ano anterior", async () => {
    const st = frotaBase();
    const r = await avaliarFrota({ hojeIso: "2027-01-01" }, { supabase: fakeDb(st) });
    assert.equal(r.referencia, "2026-12-31");
  });

  test("monitoramento-diario recusa dia de hoje/futuro", async () => {
    const st = frotaBase();
    await assert.rejects(
      () => monitoramentoDiario({ hojeIso: HOJE, data: HOJE }, { supabase: fakeDb(st) }),
      (e) => e instanceof ApiError && e.statusCode === 400,
    );
    await assert.rejects(
      () => monitoramentoDiario({ hojeIso: HOJE, data: "2099-01-01" }, { supabase: fakeDb(st) }),
      (e) => e instanceof ApiError && e.statusCode === 400,
    );
  });

  test("monitoramento-diario de um dia PASSADO usa a lógica daquele dia", async () => {
    const st = frotaBase();
    st.organizacoes = [org(UUID("o1"), "Alfa")];
    st.unidades = [uni(UUID("u"), UUID("o1"), "U")];
    st.organizacao_modulos = [{ organizacao_id: UUID("o1"), modulo_id: MOD }];
    st.unidade_modulos = [{ unidade_id: UUID("u"), modulo_id: MOD }];
    // agosto ok ; setembro 1..5 ok ; 6..14 vazio. Consultar dia 05/09 -> concluído.
    st.lancamentos_financeiros_diarios.push(...preenche(UUID("u"), "2026-08-01", "2026-08-31"), ...preenche(UUID("u"), "2026-09-01", "2026-09-05"));
    const r = await monitoramentoDiario({ hojeIso: HOJE, data: "2026-09-05" }, { supabase: fakeDb(st) });
    assert.equal(r.referencia, "2026-09-05");
    assert.equal(r.unidades[0].categoria, D1_CATEGORIA.CONCLUIDO);
  });
});

describe("I) conformidade da EMPRESA = Σcompletos / Σesperados (nunca média de %)", () => {
  test("2 unidades com taxas diferentes -> taxa da empresa é agregada", async () => {
    const st = frotaBase();
    st.organizacoes = [org(UUID("o1"), "Alfa")];
    st.unidades = [uni(UUID("uA"), UUID("o1"), "A"), uni(UUID("uB"), UUID("o1"), "B")];
    st.organizacao_modulos = [{ organizacao_id: UUID("o1"), modulo_id: MOD }];
    st.unidade_modulos = [{ unidade_id: UUID("uA"), modulo_id: MOD }, { unidade_id: UUID("uB"), modulo_id: MOD }];
    // uA: setembro 1..14 completo (14/14). uB: setembro 1..7 completo, 8..14 vazio (7/14).
    st.lancamentos_financeiros_diarios.push(
      ...preenche(UUID("uA"), "2026-08-01", "2026-08-31"), ...preenche(UUID("uA"), "2026-09-01", D1),
      ...preenche(UUID("uB"), "2026-08-01", "2026-08-31"), ...preenche(UUID("uB"), "2026-09-01", "2026-09-07"),
    );
    const r = await empresas({ hojeIso: HOJE }, { supabase: fakeDb(st) });
    const e = r.empresas.find((x) => x.organizacaoId === UUID("o1"));
    // Σcompletos = 14 + 7 = 21 ; Σesperados = 14 + 14 = 28  -> 21/28 = 0.75
    assert.equal(e.mesCompleto, 21);
    assert.equal(e.mesEsperado, 28);
    assert.ok(Math.abs(e.conformidadeMes - 0.75) < 1e-9);
    // média das % seria (1 + 0.5)/2 = 0.75 aqui por coincidência; troca uB p/ 3/14 e checa de novo:
  });

  test("média de % ≠ Σ/Σ — o painel usa Σ/Σ", async () => {
    const st = frotaBase();
    st.organizacoes = [org(UUID("o1"), "Alfa")];
    st.unidades = [uni(UUID("uA"), UUID("o1"), "A"), uni(UUID("uB"), UUID("o1"), "B")];
    st.organizacao_modulos = [{ organizacao_id: UUID("o1"), modulo_id: MOD }];
    st.unidade_modulos = [{ unidade_id: UUID("uA"), modulo_id: MOD }, { unidade_id: UUID("uB"), modulo_id: MOD }];
    // A diferença Σ/Σ vs média-de-% aparece quando os DENOMINADORES diferem.
    // uB criada em 08/09 -> dias esperados = 08..14 = 7 (projetarDia: dia == criadaEm ainda conta).
    st.unidades = [uni(UUID("uA"), UUID("o1"), "A"), uni(UUID("uB"), UUID("o1"), "B", { created_at: "2026-09-08T00:00:00Z" })];
    st.lancamentos_financeiros_diarios.push(
      ...preenche(UUID("uA"), "2026-08-01", "2026-08-31"), ...preenche(UUID("uA"), "2026-09-01", D1),   // uA: 14/14
      ...preenche(UUID("uB"), "2026-09-09", "2026-09-11"),                                              // uB: 3/7
    );
    const r = await empresas({ hojeIso: HOJE }, { supabase: fakeDb(st) });
    const e = r.empresas.find((x) => x.organizacaoId === UUID("o1"));
    assert.equal(e.mesCompleto, 17);       // 14 + 3
    assert.equal(e.mesEsperado, 21);       // 14 + 7
    assert.ok(Math.abs(e.conformidadeMes - 17 / 21) < 1e-9);            // Σ/Σ ≈ 0.8095
    const mediaDePercentuais = (14 / 14 + 3 / 7) / 2;                   // ≈ 0.7143
    assert.ok(Math.abs(e.conformidadeMes - mediaDePercentuais) > 0.05, "o painel NÃO usa média de percentuais");
  });
});

describe("N+1 / performance", () => {
  test("nº de queries NÃO cresce com o nº de unidades (10 vs 60 unidades -> mesma contagem)", async () => {
    const mk = (nOrgs, nUniPorOrg) => {
      const st = { organizacoes: [], unidades: [], organizacao_modulos: [], unidade_modulos: [], lancamentos_financeiros_diarios: [] };
      for (let o = 0; o < nOrgs; o++) {
        const oid = `o${o}`;
        st.organizacoes.push(org(oid, `Org ${o}`));
        st.organizacao_modulos.push({ organizacao_id: oid, modulo_id: MOD });
        for (let u = 0; u < nUniPorOrg; u++) {
          const uid = `${oid}u${u}`;
          st.unidades.push(uni(uid, oid, `U ${o}.${u}`));
          st.unidade_modulos.push({ unidade_id: uid, modulo_id: MOD });
          st.lancamentos_financeiros_diarios.push(...preenche(uid, "2026-08-01", "2026-08-31"), ...preenche(uid, "2026-09-01", D1));
        }
      }
      return st;
    };
    const db1 = fakeDb(mk(2, 5));   // 10 unidades
    const db2 = fakeDb(mk(6, 10));  // 60 unidades
    await visaoGeral({ hojeIso: HOJE }, { supabase: db1 });
    await visaoGeral({ hojeIso: HOJE }, { supabase: db2 });
    assert.equal(db1.__contador.queries, db2.__contador.queries, "N+1: contagem de queries mudou com o nº de unidades");
    assert.ok(db1.__contador.queries <= 6, `esperado <= 6 queries, veio ${db1.__contador.queries}`);
  });

  test("100 unidades × ~31 dias — consolida a Visão Geral em tempo linear", async () => {
    const st = { organizacoes: [], unidades: [], organizacao_modulos: [], unidade_modulos: [], lancamentos_financeiros_diarios: [] };
    for (let o = 0; o < 20; o++) {
      const oid = `o${o}`;
      st.organizacoes.push(org(oid, `Org ${o}`));
      st.organizacao_modulos.push({ organizacao_id: oid, modulo_id: MOD });
      for (let u = 0; u < 5; u++) {
        const uid = `${oid}u${u}`;
        st.unidades.push(uni(uid, oid, `U ${o}.${u}`));
        st.unidade_modulos.push({ unidade_id: uid, modulo_id: MOD });
        // agosto completo + setembro 1..14 (mistura: 1 em cada 7 unidades fica com D-1 vazio)
        st.lancamentos_financeiros_diarios.push(...preenche(uid, "2026-08-01", "2026-08-31"));
        st.lancamentos_financeiros_diarios.push(...preenche(uid, "2026-09-01", (o + u) % 7 === 0 ? "2026-09-13" : D1));
      }
    }
    const db = fakeDb(st);
    const t0 = performance.now();
    const r = await visaoGeral({ hojeIso: HOJE }, { supabase: db });
    const ms = performance.now() - t0;
    assert.equal(r.resumo.unidadesMonitoradas, 100);
    assert.equal(r.resumo.empresasMonitoradas, 20);
    assert.ok(db.__contador.queries <= 6, `queries: ${db.__contador.queries}`);
    assert.ok(ms < 500, `consolidação levou ${ms.toFixed(0)}ms (esperado < 500ms para 100×~45 dias)`);
    // ~2600 lançamentos carregados numa query; ~14 não realizados no D-1
    assert.ok(r.resumo.naoRealizadasD1 > 0 && r.resumo.naoRealizadasD1 < 30);
  });
});

describe("endpoints — pendências, detalhe da empresa, calendário", () => {
  const stComProblemas = () => {
    const st = frotaBase();
    const L = st.lancamentos_financeiros_diarios;
    for (const u of [UUID("u1a"), UUID("u1b"), UUID("u2a"), UUID("u2b"), UUID("u3a"), UUID("u3b")]) L.push(...preenche(u, "2026-08-01", "2026-08-31"));
    L.push(...preenche(UUID("u1a"), "2026-09-01", D1));                       // em dia
    L.push(...preenche(UUID("u1b"), "2026-09-01", "2026-09-13"));             // D-1 não realizado -> atenção
    L.push(...preenche(UUID("u2a"), "2026-09-01", "2026-09-10"));             // 4 dias sem lançar -> crítico
    L.push(...preenche(UUID("u2b"), "2026-09-01", D1));                       // em dia
    L.push(...preenche(UUID("u3a"), "2026-09-01", "2026-09-13"), rascunhoFin(UUID("u3a"), D1));  // em preenchimento -> atenção
    L.push(...preenche(UUID("u3b"), "2026-09-01", D1));                       // em dia
    return st;
  };

  test("pendências: só unidades não-em-dia, CRÍTICO antes de ATENÇÃO, mais antigo primeiro", async () => {
    const r = await pendencias({ hojeIso: HOJE }, { supabase: fakeDb(stComProblemas()) });
    assert.equal(r.total, 3);
    assert.equal(r.criticas, 1);
    assert.equal(r.atencao, 2);
    assert.equal(r.unidades[0].unidadeId, UUID("u2a"));          // crítico primeiro
    assert.equal(r.unidades[0].criticidade, ROLLUP.CRITICO);
    assert.ok(r.unidades.slice(1).every((u) => u.criticidade === ROLLUP.ATENCAO));
  });

  test("detalhe da empresa: só as unidades dela; conformidade agregada; 404 p/ empresa inexistente", async () => {
    const db = fakeDb(stComProblemas());
    const r = await detalheEmpresa({ organizacaoId: UUID("o2"), hojeIso: HOJE }, { supabase: db });
    assert.equal(r.organizacao.nome, "Beta");
    assert.equal(r.unidades.length, 2);
    assert.ok(r.unidades.every((u) => [UUID("u2a"), UUID("u2b")].includes(u.unidadeId)));
    assert.equal(r.consolidado.criticas, 1);

    await assert.rejects(
      () => detalheEmpresa({ organizacaoId: "00000000-0000-4000-8000-000000000000", hojeIso: HOJE }, { supabase: fakeDb(stComProblemas()) }),
      (e) => e instanceof ApiError && e.statusCode === 404,
    );
  });

  test("detalhe da empresa: empresa suspensa -> 404 (cross-tenant não expõe empresa inválida)", async () => {
    const st = stComProblemas();
    st.organizacoes = st.organizacoes.map((o) => (o.id === UUID("o1") ? { ...o, status: "cancelada" } : o));
    await assert.rejects(
      () => detalheEmpresa({ organizacaoId: UUID("o1"), hojeIso: HOJE }, { supabase: fakeDb(st) }),
      (e) => e instanceof ApiError && e.statusCode === 404,
    );
  });

  test("calendário da unidade: dias do mês com painel/completo/esperado/bloqueada", async () => {
    const r = await calendarioUnidade({ unidadeId: UUID("u2a"), mes: "2026-09", hojeIso: HOJE }, { supabase: fakeDb(stComProblemas()) });
    assert.equal(r.dias.length, 30);
    assert.equal(r.dias.find((d) => d.data === "2026-09-05").completo, true);
    assert.equal(r.dias.find((d) => d.data === "2026-09-05").esperado, true);
    assert.equal(r.dias.find((d) => d.data === HOJE).esperado, false);          // hoje -> não aplicável
    assert.ok(r.dias.filter((d) => d.bloqueada).length > 0);                     // sequência bloqueada depois do dia 10
    assert.equal(r.sequenciaBloqueada, true);
  });

  test("calendário: unidade fora do monitoramento -> 404", async () => {
    const st = stComProblemas();
    st.unidade_modulos = st.unidade_modulos.filter((x) => x.unidade_id !== UUID("u3b"));
    await assert.rejects(
      () => calendarioUnidade({ unidadeId: UUID("u3b"), mes: "2026-09", hojeIso: HOJE }, { supabase: fakeDb(st) }),
      (e) => e instanceof ApiError && e.statusCode === 404,
    );
  });
});
