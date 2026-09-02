// Shell do Painel Administrativo (painelAdm.js + painelAdmViews.js).
// Fase D: abre só com acesso REAL (ping), volta para a seleção em "Trocar
// ambiente", nunca mostra número inventado.
//
// Sem jsdom — fake mínimo de DOM (mesma abordagem de selecaoAmbiente.test.js).
//
// Rodar: node --test frontend/test/painelAdm.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// --- fake DOM ------------------------------------------------------------
function fakeEl(id) {
  const el = {
    id, _html: "", textContent: "",
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn); },
    click() { (this._listeners.click ?? []).forEach((f) => f()); },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    querySelectorAll: () => [],
  };
  return el;
}
let nodes = {};
globalThis.document = {
  querySelector: (sel) => nodes[sel] ?? null,
  querySelectorAll: (sel) => {
    // usado por els("#padm-menu li[data-tela]") — devolve os itens do menu
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
const { TELAS_PADM, renderViewPadm } = await import("../src/painelAdmViews.js");
const { state } = await import("../src/state.js");

function resetDom() {
  nodes = {};
  for (const id of ["#painel-adm-screen", "#padm-menu", "#padm-view", "#padm-titulo", "#padm-nome", "#padm-email", "#padm-avatar", "#padm-trocar", "#padm-btn-menu", "#padm-backdrop"]) {
    nodes[id] = fakeEl(id);
  }
  // o menu, ao ser montado, popula um innerHTML; os "li" reais são simulados
  // por um getter que lê o innerHTML — para simplificar, expomos _itens.
  nodes["#padm-menu"]._itens = TELAS_PADM.map((t) => {
    const li = fakeEl();
    li.dataset = { tela: t.id };
    return li;
  });
  state.telaPainelAdm = null;
}

beforeEach(resetDom);

const apiFake = (impl) => ({ ping: impl });
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
  test("ping 200 -> troca para o shell #painel-adm-screen e renderiza a Visão Geral", async () => {
    const g = ganchosFake();
    const ok = await abrirPainelAdministrativo({ ...g, api: apiFake(async () => ({ ok: true })) });
    assert.equal(ok, true);
    assert.deepEqual(g.chamadas.find((c) => c[0] === "mostrarTela"), ["mostrarTela", "painelAdm"]);
    assert.match(nodes["#padm-view"].innerHTML, /Painel Administrativo/);
    assert.equal(state.telaPainelAdm, "visao-geral");
  });

  test("ping 403 -> NÃO abre o shell; chama aoAcessoRevogado com a mensagem", async () => {
    const g = ganchosFake();
    const err = Object.assign(new Error("Seu acesso não está mais disponível."), { status: 403 });
    const ok = await abrirPainelAdministrativo({ ...g, api: apiFake(async () => { throw err; }) });
    assert.equal(ok, false);
    assert.ok(!g.chamadas.some((c) => c[0] === "mostrarTela"), "nunca troca de shell");
    const revogado = g.chamadas.find((c) => c[0] === "aoAcessoRevogado");
    assert.ok(revogado);
    assert.match(revogado[1], /disponível/);
  });

  test("erro de rede (não-403) -> não abre, não chama aoAcessoRevogado", async () => {
    const g = ganchosFake();
    const ok = await abrirPainelAdministrativo({ ...g, api: apiFake(async () => { throw new Error("Failed to fetch"); }) });
    assert.equal(ok, false);
    assert.ok(!g.chamadas.some((c) => c[0] === "mostrarTela"));
    assert.ok(!g.chamadas.some((c) => c[0] === "aoAcessoRevogado"));
  });
});

describe("sairDoPainelAdministrativo (Trocar ambiente)", () => {
  test("chama aoTrocarAmbiente e limpa a tela ativa", async () => {
    const g = ganchosFake();
    await abrirPainelAdministrativo({ ...g, api: apiFake(async () => ({ ok: true })) });
    sairDoPainelAdministrativo();
    assert.ok(g.chamadas.some((c) => c[0] === "aoTrocarAmbiente"));
    assert.equal(state.telaPainelAdm, null);
  });
});

describe("TELAS_PADM / renderViewPadm", () => {
  test("5 áreas, só 'visao-geral' pronta nesta fase", () => {
    assert.deepEqual(TELAS_PADM.map((t) => t.id), ["visao-geral", "diario", "pendencias", "empresas", "historico"]);
    assert.deepEqual(TELAS_PADM.filter((t) => t.pronto).map((t) => t.id), ["visao-geral"]);
  });

  test("Visão Geral é placeholder — sem números inventados", () => {
    renderViewPadm("visao-geral");
    const html = nodes["#padm-view"].innerHTML;
    assert.match(html, /Painel Administrativo/);
    assert.match(html, /Monitoramento das operações/);
    assert.match(html, /Dashboard iFood/);
    assert.ok(!/\d+%|\d+ empresas|conformidade/i.test(html), "não pode ter indicador fake");
  });

  test("áreas sem motor -> 'Em breve'", () => {
    renderViewPadm("pendencias");
    assert.match(nodes["#padm-view"].innerHTML, /Em breve/);
    assert.ok(!/\d+%/.test(nodes["#padm-view"].innerHTML));
  });

  test("irParaPadm atualiza o título e o estado", () => {
    irParaPadm("historico");
    assert.equal(state.telaPainelAdm, "historico");
    assert.equal(nodes["#padm-titulo"].textContent, "Histórico");
    assert.match(nodes["#padm-view"].innerHTML, /Em breve/);
  });
});
