// Shell do Painel Administrativo (painelAdm.js).
// Abre só com acesso REAL (ping), volta para a seleção em "Trocar ambiente",
// navega por pilha interna (aba → empresa → calendário) sem tocar contexto
// tenant, e trata 403 em qualquer view como acesso revogado.
//
// Sem jsdom — fake mínimo de DOM (mesma abordagem de selecaoAmbiente.test.js).
//
// Rodar: node --test frontend/test/painelAdm.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// --- fake DOM ------------------------------------------------------------
function fakeEl(id) {
  const el = {
    id, _html: "", textContent: "", hidden: false, disabled: false, value: "",
    dataset: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
    click() { (this._listeners.click ?? []).forEach((f) => f({ target: { closest: () => null } })); },
    closest() { return null; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return el;
}
let nodes = {};
globalThis.document = {
  querySelector: (sel) => nodes[sel] ?? null,
  querySelectorAll: (sel) => {
    if (sel.includes("#padm-menu li")) return nodes["#padm-menu"]?._itens ?? [];
    return [];
  },
  createElement: () => fakeEl(),
  body: { appendChild() {} },
};
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.sessionStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.requestAnimationFrame ??= (fn) => fn();

const { abrirPainelAdministrativo, sairDoPainelAdministrativo, irParaPadm } = await import("../src/painelAdm.js");
const { TELAS_PADM } = await import("../src/painelAdmViews.js");
const { state } = await import("../src/state.js");

function resetDom() {
  nodes = {};
  for (const id of ["#painel-adm-screen", "#padm-menu", "#padm-view", "#padm-titulo", "#padm-nome", "#padm-email", "#padm-avatar", "#padm-trocar", "#padm-btn-menu", "#padm-backdrop"]) {
    nodes[id] = fakeEl(id);
  }
  nodes["#padm-menu"]._itens = TELAS_PADM.map((t) => {
    const li = fakeEl();
    li.dataset = { tela: t.id };
    return li;
  });
  state.telaPainelAdm = null;
}

beforeEach(resetDom);

const VISAO_GERAL_FAKE = {
  monitor: "dashboard_ifood", dataReferencia: "2026-09-15", d1: "2026-09-14",
  resumo: {
    unidadesMonitoradas: 3, empresasMonitoradas: 2, concluidasD1: 2, emPreenchimentoD1: 0,
    naoRealizadasD1: 1, sequenciaBloqueadaD1: 0, criticas: 0, atencao: 1, emDia: 2,
    conformidadeD1: 0.6667, conformidadeMes: 0.94, mesCompleto: 79, mesEsperado: 84,
  },
  acaoNecessariaHoje: [], resumoAcao: {}, empresas: [],
};

const apiFake = (over = {}) => ({
  ping: async () => ({ ok: true }),
  visaoGeral: async () => VISAO_GERAL_FAKE,
  monitoramentoDiario: async () => ({ referencia: "2026-09-14", unidades: [] }),
  pendencias: async () => ({ d1: "2026-09-14", unidades: [] }),
  empresas: async () => ({ empresas: [] }),
  detalheEmpresa: async () => ({ organizacao: {}, consolidado: {}, unidades: [], pendencias: [] }),
  calendarioUnidade: async () => ({ mes: "2026-09", dataReferencia: "2026-09-15", dias: [], unidade: {} }),
  ...over,
});

const ganchosFake = () => {
  const chamadas = [];
  return {
    mostrarTela: (t) => chamadas.push(["mostrarTela", t]),
    aoTrocarAmbiente: () => chamadas.push(["aoTrocarAmbiente"]),
    aoAcessoRevogado: (m) => chamadas.push(["aoAcessoRevogado", m]),
    usuario: { nome: "João Pedro", email: "joao@x.com" },
    chamadas,
  };
};

describe("abrirPainelAdministrativo", () => {
  test("ping 200 -> troca para o shell e renderiza a Visão Geral real", async () => {
    const g = ganchosFake();
    const ok = await abrirPainelAdministrativo({ ...g, api: apiFake() });
    assert.equal(ok, true);
    assert.deepEqual(g.chamadas.find((c) => c[0] === "mostrarTela"), ["mostrarTela", "painelAdm"]);
    assert.equal(state.telaPainelAdm, "visao-geral");
    // A Visão Geral real mostra os cartões de indicador (não mais o placeholder).
    assert.match(nodes["#padm-view"].innerHTML, /Unidades monitoradas/);
    assert.match(nodes["#padm-view"].innerHTML, /Ação necessária hoje/i);
  });

  test("ping 403 -> NÃO abre o shell; chama aoAcessoRevogado", async () => {
    const g = ganchosFake();
    const err = Object.assign(new Error("Seu acesso não está mais disponível."), { status: 403 });
    const ok = await abrirPainelAdministrativo({ ...g, api: apiFake({ ping: async () => { throw err; } }) });
    assert.equal(ok, false);
    assert.ok(!g.chamadas.some((c) => c[0] === "mostrarTela"), "nunca troca de shell");
    assert.match(g.chamadas.find((c) => c[0] === "aoAcessoRevogado")[1], /disponível/);
  });

  test("erro de rede no ping -> não abre, não chama aoAcessoRevogado", async () => {
    const g = ganchosFake();
    const ok = await abrirPainelAdministrativo({ ...g, api: apiFake({ ping: async () => { throw new Error("Failed to fetch"); } }) });
    assert.equal(ok, false);
    assert.ok(!g.chamadas.some((c) => c[0] === "mostrarTela"));
    assert.ok(!g.chamadas.some((c) => c[0] === "aoAcessoRevogado"));
  });

  test("403 numa VIEW (após aberto) -> aoAcessoRevogado", async () => {
    const g = ganchosFake();
    const err403 = Object.assign(new Error("Acesso revogado."), { status: 403 });
    await abrirPainelAdministrativo({ ...g, api: apiFake({ pendencias: async () => { throw err403; } }) });
    g.chamadas.length = 0;
    irParaPadm("pendencias");
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(g.chamadas.some((c) => c[0] === "aoAcessoRevogado"), "403 em view vira acesso revogado");
  });

  test("erro de rede numa VIEW -> estado de erro, NÃO acesso revogado", async () => {
    const g = ganchosFake();
    await abrirPainelAdministrativo({ ...g, api: apiFake({ empresas: async () => { throw new Error("Failed to fetch"); } }) });
    g.chamadas.length = 0;
    irParaPadm("empresas");
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(!g.chamadas.some((c) => c[0] === "aoAcessoRevogado"));
    assert.match(nodes["#padm-view"].innerHTML, /não foi possível carregar/i);
    assert.match(nodes["#padm-view"].innerHTML, /conex/i);
  });
});

describe("sairDoPainelAdministrativo (Trocar ambiente)", () => {
  test("chama aoTrocarAmbiente e limpa a tela ativa", async () => {
    const g = ganchosFake();
    await abrirPainelAdministrativo({ ...g, api: apiFake() });
    sairDoPainelAdministrativo();
    assert.ok(g.chamadas.some((c) => c[0] === "aoTrocarAmbiente"));
    assert.equal(state.telaPainelAdm, null);
  });
});

describe("TELAS_PADM", () => {
  test("5 áreas fixas, na ordem da especificação", () => {
    assert.deepEqual(TELAS_PADM.map((t) => t.id), ["visao-geral", "diario", "pendencias", "empresas", "historico"]);
  });

  test("irParaPadm troca título e estado; Histórico é informativo (sem rede)", async () => {
    const g = ganchosFake();
    await abrirPainelAdministrativo({ ...g, api: apiFake() });
    irParaPadm("historico");
    assert.equal(state.telaPainelAdm, "historico");
    assert.equal(nodes["#padm-titulo"].textContent, "Histórico");
    assert.match(nodes["#padm-view"].innerHTML, /próxima etapa/i);
  });
});
