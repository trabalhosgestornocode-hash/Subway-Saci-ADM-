// Fase F — tela "Selecione seu usuário" + PIN.
//
// Testa o módulo de UI (selecaoPerfil.js) com um fake DOM mínimo, mais scans
// de fonte de app.js / sessao.js para os pontos de segurança (47) e o fluxo
// (44). Cobertura de contrato de backend (45/46) fica nas suítes do backend.
//
// Rodar: node --test frontend/test/selecaoPerfil.test.js

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const APP = src("../src/app.js");
const SESSAO = src("../src/sessao.js");
const STATE = src("../src/state.js");

// --- fake DOM ------------------------------------------------------------
function fakeEl(tag = "div") {
  const listeners = {};
  return {
    tagName: tag.toUpperCase(),
    hidden: false, disabled: false, value: "", textContent: "",
    dataset: {}, _html: "", _focus: 0, onclick: null, onkeydown: null,
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      // extrai os data-perfil e [disabled] dos "cards" para os testes de clique
      this._cards = [...String(v).matchAll(/data-perfil="([^"]+)"([^>]*)>/g)]
        .map((m) => {
          const card = fakeEl("button");
          card.dataset.perfil = m[1];
          card.disabled = /\bdisabled\b/.test(m[2]);
          return card;
        });
    },
    querySelector(sel) {
      if (sel === ".sel-card:not([disabled])") return (this._cards || []).find((c) => !c.disabled) || null;
      return (this._cards || [])[0] || null;
    },
    querySelectorAll(sel) {
      const all = this._cards || [];
      return sel.includes("disabled") ? all : all;
    },
    addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
    _emit(ev, arg) {
      (listeners[ev] || []).forEach((fn) => fn(arg));
      if (ev === "click" && typeof this.onclick === "function") this.onclick(arg);
      if (ev === "keydown" && typeof this.onkeydown === "function") this.onkeydown(arg);
    },
    focus() { this._focus++; },
    _listeners: listeners,
  };
}
let nodes = {};
globalThis.document = {
  querySelector: (sel) => nodes[sel] ?? null,
  querySelectorAll: () => [],
};

const {
  montarSelecaoPerfil, abrirPinDoPerfil, setErroPin, fecharPinDoPerfil, mostrarSemPerfil,
} = await import("../src/selecaoPerfil.js");

function resetDom() {
  nodes = {};
  for (const id of ["#selp-conta", "#selp-lista", "#selp-aviso", "#selp-pin", "#selp-pin-nome",
    "#selp-pin-input", "#selp-pin-erro", "#selp-pin-ok", "#selp-pin-voltar"]) {
    nodes[id] = fakeEl(id.includes("input") ? "input" : id.includes("ok") || id.includes("voltar") ? "button" : "div");
  }
}

const PERFIS = [
  { id: "p-fulana-1", nome: "Fulana 1", ativo: true, temPin: true },
  { id: "p-fulana-2", nome: "Fulana 2", ativo: true, temPin: true },
];

// ===========================================================================
describe("montarSelecaoPerfil (testes 2/3/4)", () => {
  beforeEach(resetDom);

  test("2/3) renderiza um card por perfil, com o NOME de cada", () => {
    montarSelecaoPerfil({ perfis: PERFIS, contaLabel: "operacional@x.com", onEscolher() {} });
    const html = nodes["#selp-lista"].innerHTML;
    assert.match(html, /Fulana 1/);
    assert.match(html, /Fulana 2/);
    assert.equal(nodes["#selp-conta"].textContent, "operacional@x.com");
  });

  test("4) NUNCA renderiza pin_hash / pin / tentativas", () => {
    const comSegredo = PERFIS.map((p) => ({ ...p, pin_hash: "s1:naovaza", pin_tentativas: 3 }));
    montarSelecaoPerfil({ perfis: comSegredo, contaLabel: "x", onEscolher() {} });
    const html = nodes["#selp-lista"].innerHTML;
    assert.doesNotMatch(html, /pin_hash|s1:naovaza|pin_tentativas/);
  });

  test("config incompleta -> cards desabilitados + aviso", () => {
    montarSelecaoPerfil({
      perfis: PERFIS, contaLabel: "x", configIncompleta: true, onEscolher() {},
    });
    assert.equal(nodes["#selp-aviso"].hidden, false);
    assert.match(nodes["#selp-lista"].innerHTML, /disabled/);
  });

  test("5) clicar num card chama onEscolher com o perfil certo", () => {
    let escolhido = null;
    montarSelecaoPerfil({ perfis: PERFIS, contaLabel: "x", onEscolher: (p) => { escolhido = p; } });
    const card = nodes["#selp-lista"]._cards.find((c) => c.dataset.perfil === "p-fulana-2");
    card._emit("click");
    assert.equal(escolhido?.id, "p-fulana-2");
  });
});

// ===========================================================================
describe("abrirPinDoPerfil (testes 5/6/7/9/10)", () => {
  beforeEach(resetDom);

  test("5/9) abre o painel de PIN, esconde a lista; voltar restaura e limpa PIN", () => {
    let voltou = false;
    abrirPinDoPerfil({ perfil: { id: "p1", nome: "Fulana 1" }, onConfirmar() {}, onVoltar: () => { voltou = true; } });
    assert.equal(nodes["#selp-pin"].hidden, false);
    assert.equal(nodes["#selp-lista"].hidden, true);
    assert.equal(nodes["#selp-pin-nome"].textContent, "Fulana 1");

    nodes["#selp-pin-input"].value = "1234";
    nodes["#selp-pin-voltar"]._emit("click");
    assert.equal(voltou, true);
    assert.equal(nodes["#selp-pin-input"].value, ""); // 10) PIN não sobrevive
    assert.equal(nodes["#selp-pin"].hidden, true);
    assert.equal(nodes["#selp-lista"].hidden, false);
  });

  test("6) PIN no formato correto -> onConfirmar(pin)", () => {
    let recebido = null;
    abrirPinDoPerfil({ perfil: { id: "p1", nome: "F" }, onConfirmar: (pin) => { recebido = pin; }, onVoltar() {} });
    nodes["#selp-pin-input"].value = "0123"; // zeros à esquerda preservados (string)
    nodes["#selp-pin-ok"]._emit("click");
    assert.equal(recebido, "0123");
  });

  test("PIN em formato inválido -> erro, NÃO chama onConfirmar", () => {
    let chamou = false;
    abrirPinDoPerfil({ perfil: { id: "p1", nome: "F" }, onConfirmar: () => { chamou = true; }, onVoltar() {} });
    nodes["#selp-pin-input"].value = "12";
    nodes["#selp-pin-ok"]._emit("click");
    assert.equal(chamou, false);
    assert.equal(nodes["#selp-pin-erro"].hidden, false);
  });

  test("Enter no input também confirma", () => {
    let recebido = null;
    abrirPinDoPerfil({ perfil: { id: "p1", nome: "F" }, onConfirmar: (p) => { recebido = p; }, onVoltar() {} });
    nodes["#selp-pin-input"].value = "445566";
    nodes["#selp-pin-input"]._emit("keydown", { key: "Enter" });
    assert.equal(recebido, "445566");
  });
});

// ===========================================================================
describe("estados (testes 4/21)", () => {
  beforeEach(resetDom);

  test("21) mostrarSemPerfil -> estado tratado, sem cards", () => {
    mostrarSemPerfil("operacional@x.com");
    assert.match(nodes["#selp-lista"].innerHTML, /Nenhum usuário disponível/);
    assert.equal(nodes["#selp-pin"].hidden, true);
  });

  test("setErroPin exibe e limpa", () => {
    setErroPin("PIN inválido.");
    assert.equal(nodes["#selp-pin-erro"].hidden, false);
    assert.equal(nodes["#selp-pin-erro"].textContent, "PIN inválido.");
    setErroPin(null);
    assert.equal(nodes["#selp-pin-erro"].hidden, true);
  });
});

// ===========================================================================
describe("scan de segurança — app.js / sessao.js (ponto 47)", () => {
  test("nenhum signOut GLOBAL — só scope local", () => {
    assert.doesNotMatch(SESSAO, /signOut\(\)/);
    assert.doesNotMatch(SESSAO, /signOut\(\{ scope: ["']global["'] \}\)/);
    assert.match(SESSAO, /signOut\(\{ scope: ["']local["'] \}\)/);
  });

  test("11) PIN nunca é persistido (localStorage/sessionStorage)", () => {
    // o único lugar que toca `pin` é o request; nada de storage
    assert.doesNotMatch(SESSAO, /(localStorage|sessionStorage)[^\n]*pin/i);
    assert.doesNotMatch(APP, /(localStorage|sessionStorage)[^\n]*pin/i);
    assert.doesNotMatch(src("../src/selecaoPerfil.js"), /localStorage|sessionStorage/);
  });

  test("13) Profile Selection Token só vive em memória (state), nunca em storage", () => {
    assert.doesNotMatch(SESSAO, /(localStorage|sessionStorage)[^\n]*[Pp]rofileSelection/);
    assert.match(SESSAO, /state\.sessao\.profileSelectionToken = data\.profileSelectionToken/);
    // consumida ao criar o Context Token
    assert.match(SESSAO, /state\.sessao\.profileSelectionToken = null;\s*\n\s*return data;/);
  });

  test("14/19) acessos são escopados por perfilId no fluxo multi-perfil", () => {
    assert.match(SESSAO, /listarAcessos\(perfilId = null\)/);
    assert.match(SESSAO, /perfilId \? `\/api\/v1\/sessao\/acessos\?perfilId=/);
    assert.match(APP, /entrarComAcessosDoPerfil\(\{ perfilId/);
  });

  test("23) selecionarContexto envia a prova de PIN quando existe", () => {
    assert.match(SESSAO, /const prova = state\.sessao\.profileSelectionToken \|\| undefined/);
    assert.match(SESSAO, /\.\.\.\(prova \? \{ profileSelectionToken: prova \} : \{\}\)/);
  });

  test("state.js declara perfil / profileSelectionToken / perfisDisponiveis, sem persistência", () => {
    assert.match(STATE, /profileSelectionToken: null/);
    assert.match(STATE, /perfisDisponiveis: \[\]/);
  });
});

// ===========================================================================
describe("fluxo em app.js — scans (testes 1/2/16/17/24/25)", () => {
  test("1/2) 1 perfil (ou legado) -> fluxo automático; 2+ -> tela de seleção", () => {
    assert.match(APP, /perfis && perfis\.length >= 2[\s\S]{0,120}mostrarSelecaoDePerfil/);
    assert.match(APP, /1 perfil \(ou legado\): fluxo automático/);
    assert.match(APP, /catch \{ perfis = null; \}/); // pré-060 / erro -> legado
  });

  test("16) reload com Context Token válido NÃO pede perfil/PIN", () => {
    assert.match(APP, /restaurarContexto\(\)\) \{\s*\n\s*mostrarApp\(\);\s*\n\s*return;/);
    assert.match(APP, /NUNCA pede perfil\/PIN aqui/);
  });

  test("17/26) logout limpa perfil + prova", () => {
    assert.match(SESSAO, /state\.sessao\.perfil = null;\s*\n\s*state\.sessao\.perfisDisponiveis = \[\];\s*\n\s*state\.sessao\.profileSelectionToken = null;/);
  });

  test("19/25) Context Token inválido (409) -> volta para encaminhar (resolução de perfil)", () => {
    assert.match(APP, /app:contexto-invalido["'], async \(e\) => \{[\s\S]{0,160}encaminhar\(\)/);
  });

  test("24/25) troca de unidade/empresa mantém o perfil (usa trocarUnidadeDoContexto / selecionarContexto, sem re-PIN)", () => {
    assert.match(APP, /trocarUnidadeRapido/);
    assert.doesNotMatch(APP, /trocarUnidadeRapido[\s\S]{0,200}selecionarPerfil/);
  });

  test("35) prova expirada na seleção de empresa -> volta para o PIN", () => {
    assert.match(APP, /PROVA_PERFIL_\|/); // detecta o código de prova no catch de entrarNoContexto
    assert.match(APP, /perfilObrigatorio\) \{[\s\S]{0,200}encaminhar\(\)/);
  });
});
