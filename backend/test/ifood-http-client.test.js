// Testes do cliente HTTP do iFood com fetch FALSO. Nenhuma chamada real —
// nem aqui, nem no CI.
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";

const { postForm, getJson } = await import("../src/modules/ifood/ifoodHttp.client.js");
const { IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");

// fetch falso: registra as chamadas e devolve o que for programado. A ÚLTIMA
// resposta é repetida (permite testar retry com uma linha).
function fetchFalso(respostas) {
  const chamadas = [];
  const fila = [...respostas];
  let ultima = respostas.at(-1);
  const impl = async (url, opts) => {
    chamadas.push({ url, opts, method: opts?.method, headers: opts?.headers, body: opts?.body });
    if (fila.length) ultima = fila.shift();
    const r = ultima;
    if (r.erroRede) throw new Error("ECONNRESET");
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: {
        get: (h) => {
          const k = h.toLowerCase();
          if (k === "content-type") return r.contentType ?? "application/json";
          if (k === "retry-after") return r.retryAfter ?? null;
          return null;
        },
      },
      text: async () => (typeof r.corpo === "string" ? r.corpo : JSON.stringify(r.corpo ?? {})),
    };
  };
  return { chamadas, impl };
}
const okJson = (corpo) => ({ status: 200, corpo });

test("postForm monta URL, método e corpo x-www-form-urlencoded", async () => {
  const f = fetchFalso([okJson({ userCode: "HJLX-LPSQ" })]);
  const r = await postForm("/authentication/v1.0/oauth/userCode", { clientId: "abc123" }, { fetchImpl: f.impl });
  assert.equal(r.userCode, "HJLX-LPSQ");
  assert.equal(f.chamadas[0].url, "https://mock.ifood.test/authentication/v1.0/oauth/userCode");
  assert.equal(f.chamadas[0].method, "POST");
  assert.equal(f.chamadas[0].headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(f.chamadas[0].body, "clientId=abc123");
});

test("postForm serializa vários campos e ignora undefined/null", async () => {
  const f = fetchFalso([okJson({ accessToken: "AT" })]);
  await postForm("/authentication/v1.0/oauth/token", {
    grantType: "authorization_code", clientId: "c", clientSecret: "s",
    authorizationCode: "AC", authorizationCodeVerifier: "V", vazio: undefined, nulo: null,
  }, { fetchImpl: f.impl });
  const body = new URLSearchParams(f.chamadas[0].body);
  assert.equal(body.get("grantType"), "authorization_code");
  assert.equal(body.get("clientSecret"), "s");
  assert.equal(body.get("authorizationCodeVerifier"), "V");
  assert.equal(body.has("vazio"), false);
  assert.equal(body.has("nulo"), false);
});

test("getJson envia Authorization: Bearer e nada mais além de Accept", async () => {
  const f = fetchFalso([okJson({ merchants: [] })]);
  await getJson("/merchant/v1.0/merchants?page=1&size=100", { accessToken: "TOKEN-XYZ", fetchImpl: f.impl });
  const h = f.chamadas[0].headers;
  assert.equal(h.Authorization, "Bearer TOKEN-XYZ");
  assert.equal(h.Accept, "application/json");
  assert.equal(f.chamadas[0].method, "GET");
});

test("getJson sem accessToken falha como token expirado (não chega a chamar)", async () => {
  const f = fetchFalso([okJson({})]);
  await assert.rejects(() => getJson("/merchant/v1.0/merchants", { fetchImpl: f.impl }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
  assert.equal(f.chamadas.length, 0);
});

test("400 no fluxo OAuth vira IFOOD_OAUTH_CODIGO_INVALIDO e NÃO é repetido", async () => {
  const f = fetchFalso([{ status: 400, corpo: { error: "invalid_grant" } }]);
  await assert.rejects(() => postForm("/authentication/v1.0/oauth/token", { grantType: "x" }, { fetchImpl: f.impl }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_OAUTH_CODIGO_INVALIDO);
  assert.equal(f.chamadas.length, 1, "400 não pode gerar retry");
});

test("401 vira IFOOD_TOKEN_EXPIRADO e NÃO é repetido", async () => {
  const f = fetchFalso([{ status: 401 }]);
  await assert.rejects(() => getJson("/merchant/v1.0/merchants", { accessToken: "t", fetchImpl: f.impl }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
  assert.equal(f.chamadas.length, 1);
});

test("403 vira IFOOD_MERCHANT_SEM_PERMISSAO e NÃO é repetido", async () => {
  const f = fetchFalso([{ status: 403 }]);
  await assert.rejects(() => getJson("/merchant/v1.0/merchants/abc", { accessToken: "t", fetchImpl: f.impl }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO);
  assert.equal(f.chamadas.length, 1);
});

test("5xx é transitório: tenta de novo e sobe INDISPONIVEL ao esgotar", async () => {
  const f = fetchFalso([{ status: 503 }]);
  await assert.rejects(() => getJson("/merchant/v1.0/merchants", { accessToken: "t", fetchImpl: f.impl }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL);
  assert.equal(f.chamadas.length, 3, "deveria usar as 3 tentativas");
});

test("5xx seguido de sucesso se recupera", async () => {
  const f = fetchFalso([{ status: 500 }, okJson({ ok: true })]);
  const r = await getJson("/merchant/v1.0/merchants", { accessToken: "t", fetchImpl: f.impl });
  assert.equal(r.ok, true);
  assert.equal(f.chamadas.length, 2);
});

test("429 é transitório e respeita Retry-After (curto)", async () => {
  const f = fetchFalso([{ status: 429, retryAfter: "0" }, okJson({ ok: true })]);
  const r = await getJson("/merchant/v1.0/merchants", { accessToken: "t", fetchImpl: f.impl });
  assert.equal(r.ok, true);
  assert.equal(f.chamadas.length, 2);
});

test("429 até o fim vira IFOOD_RATE_LIMITED", async () => {
  const f = fetchFalso([{ status: 429, retryAfter: "0" }]);
  await assert.rejects(() => getJson("/merchant/v1.0/merchants", { accessToken: "t", fetchImpl: f.impl }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RATE_LIMITED);
  assert.equal(f.chamadas.length, 3);
});

test("content-type não-JSON vira IFOOD_RESPOSTA_INVALIDA", async () => {
  const f = fetchFalso([{ status: 200, contentType: "text/html", corpo: "<html>login</html>" }]);
  await assert.rejects(() => getJson("/merchant/v1.0/merchants", { accessToken: "t", fetchImpl: f.impl }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA);
});

test("JSON inválido vira IFOOD_RESPOSTA_INVALIDA", async () => {
  const f = fetchFalso([{ status: 200, corpo: "{nao e json" }]);
  await assert.rejects(() => postForm("/authentication/v1.0/oauth/token", {}, { fetchImpl: f.impl }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA);
});

test("falha de rede é repetida e vira INDISPONIVEL", async () => {
  const f = fetchFalso([{ erroRede: true }]);
  await assert.rejects(() => getJson("/merchant/v1.0/merchants", { accessToken: "t", fetchImpl: f.impl }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL);
  assert.equal(f.chamadas.length, 3);
});

test("cancelamento externo interrompe a chamada", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const f = fetchFalso([{ erroRede: true }]);
  await assert.rejects(() => getJson("/merchant/v1.0/merchants", { accessToken: "t", sinal: ctrl.signal, fetchImpl: f.impl }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_CANCELADO);
});
