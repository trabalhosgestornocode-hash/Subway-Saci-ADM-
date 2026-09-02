// Cliente da API do Painel Administrativo (painelAdmApi.js).
// Garante o contrato da Fase D: Bearer sim, x-context-token NUNCA (itens 8-9),
// e 403 propagado com `.status` para a UX de acesso revogado (item 17).
//
// Rodar: node --test frontend/test/painelAdmApi.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// supabaseClient.js precisa de `localStorage` + `window.supabase` no import.
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.sessionStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window ??= {};
globalThis.window.supabase = {
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "jwt-identidade-fake" } } }) },
  }),
};

const { painelAdmApi } = await import("../src/painelAdmApi.js");

let capturado;
const fetchOriginal = globalThis.fetch;

function stubFetch({ status = 200, body = { data: { ok: true } } } = {}) {
  globalThis.fetch = async (url, opcoes) => {
    capturado = { url, opcoes };
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => body,
    };
  };
}

beforeEach(() => { capturado = null; });
afterEach(() => { globalThis.fetch = fetchOriginal; });

describe("painelAdmApi.ping", () => {
  test("chama GET /api/v1/administrativo/ping", async () => {
    stubFetch();
    await painelAdmApi.ping();
    assert.match(capturado.url, /\/api\/v1\/administrativo\/ping$/);
  });

  test("envia Authorization: Bearer (a identidade) e nada de x-context-token", async () => {
    stubFetch();
    await painelAdmApi.ping();
    const h = capturado.opcoes.headers ?? {};
    assert.equal(h.Authorization, "Bearer jwt-identidade-fake");
    assert.ok(!Object.keys(h).some((k) => k.toLowerCase() === "x-context-token"), "nunca manda x-context-token");
  });

  test("NUNCA envia x-context-token, mesmo com um salvo no sessionStorage", async () => {
    globalThis.sessionStorage.getItem = (k) => (k === "cd.contextToken" ? "token-tenant-fake" : null);
    stubFetch();
    await painelAdmApi.ping();
    const h = capturado.opcoes.headers ?? {};
    assert.ok(!Object.keys(h).some((k) => k.toLowerCase() === "x-context-token"),
      "o cliente do Painel Administrativo é context-free por construção");
    globalThis.sessionStorage.getItem = () => null;
  });

  test("200 -> devolve o `data` do corpo", async () => {
    stubFetch({ body: { data: { ok: true, ambiente: "painel_administrativo" } } });
    const r = await painelAdmApi.ping();
    assert.equal(r.ambiente, "painel_administrativo");
  });

  test("403 -> lança erro com .status = 403 (para a UX de acesso revogado)", async () => {
    stubFetch({ status: 403, body: { error: "Acesso restrito ao Painel Administrativo da Crescer." } });
    await assert.rejects(() => painelAdmApi.ping(), (e) => {
      assert.equal(e.status, 403);
      assert.match(e.message, /Painel Administrativo/);
      return true;
    });
  });
});
