// Ciclo de vida do token iFood — troca, refresh, renovação proativa e o
// retry ÚNICO em 401. Sem rede real, sem banco real.
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret";
process.env.IFOOD_ANALYTICS_CLIENT_ID = "";
process.env.IFOOD_ANALYTICS_CLIENT_SECRET = "";

const svc = await import("../src/modules/ifood/ifoodToken.service.js");
const { IFOOD_ERROS, ifoodErro } = await import("../src/modules/ifood/ifood.errors.js");
const { cifrar, decifrar } = await import("../src/shared/cripto.js");

// --- fakes --------------------------------------------------------------
function httpFalso(respostas) {
  const chamadas = [];
  const fila = [...respostas];
  return {
    chamadas,
    async postForm(caminho, campos, opts) {
      chamadas.push({ caminho, campos, opts });
      const r = fila.length > 1 ? fila.shift() : fila[0];
      if (typeof r === "function") return r();
      if (r?.erro) throw r.erro;
      return r;
    },
  };
}

function repoFalso(credInicial) {
  let cred = credInicial ? { ...credInicial } : null;
  return {
    _cred: () => cred,
    async obterCredencial() { return cred ? { ...cred } : null; },
    async salvarCredencial({ accessTokenCifrado, refreshTokenCifrado, expiraEm, tokenType }) {
      cred = {
        ...(cred ?? {}),
        access_token_cifrado: accessTokenCifrado,
        // undefined = mantém o anterior (o service passa undefined quando o
        // iFood não devolve refreshToken novo)
        refresh_token_cifrado: refreshTokenCifrado === undefined ? cred?.refresh_token_cifrado ?? null : refreshTokenCifrado,
        expira_em: expiraEm, token_type: tokenType, status: "ativa",
      };
      return cred;
    },
    async atualizarCredencial({ campos }) { cred = { ...(cred ?? {}), ...campos }; return cred; },
  };
}

const daquiA = (ms) => new Date(Date.now() + ms).toISOString();

// --- credenciaisDoApp --------------------------------------------------
test("credenciaisDoApp: app sem ENV lança IFOOD_APP_SEM_CREDENCIAL", () => {
  assert.throws(() => svc.credenciaisDoApp("analytics"), (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_SEM_CREDENCIAL);
});
test("credenciaisDoApp: appType inválido lança IFOOD_APP_TYPE_INVALIDO", () => {
  assert.throws(() => svc.credenciaisDoApp("qualquer"), (e) => e.codigo === IFOOD_ERROS.IFOOD_APP_TYPE_INVALIDO);
});

// --- troca authorization_code ----------------------------------------
test("trocarAuthorizationCodePorToken monta o form correto e normaliza a resposta", async () => {
  const http = httpFalso([{ accessToken: "AT-1", refreshToken: "RT-1", expiresIn: 21600, type: "bearer" }]);
  const tokens = await svc.trocarAuthorizationCodePorToken({ appType: "financial", authorizationCode: "AC", verifier: "V", http });
  assert.equal(http.chamadas[0].caminho, "/authentication/v1.0/oauth/token");
  assert.deepEqual(
    { g: http.chamadas[0].campos.grantType, ci: http.chamadas[0].campos.clientId, cs: http.chamadas[0].campos.clientSecret, ac: http.chamadas[0].campos.authorizationCode, v: http.chamadas[0].campos.authorizationCodeVerifier },
    { g: "authorization_code", ci: "fin-client-id", cs: "fin-client-secret", ac: "AC", v: "V" },
  );
  assert.equal(tokens.accessToken, "AT-1");
  assert.equal(tokens.refreshToken, "RT-1");
  assert.equal(tokens.tokenType, "bearer");
  assert.ok(new Date(tokens.expiraEm).getTime() > Date.now());
});

test("troca com authorizationCode inválido (400) vira IFOOD_OAUTH_CODIGO_INVALIDO", async () => {
  const http = httpFalso([{ erro: ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_CODIGO_INVALIDO) }]);
  await assert.rejects(() => svc.trocarAuthorizationCodePorToken({ appType: "financial", authorizationCode: "bad", verifier: "V", http }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_OAUTH_CODIGO_INVALIDO);
});

// --- refresh ---------------------------------------------------------
test("renovarToken usa grantType=refresh_token", async () => {
  const http = httpFalso([{ accessToken: "AT-2", expiresIn: 21600 }]);
  const t = await svc.renovarToken({ appType: "financial", refreshToken: "RT-old", http });
  assert.equal(http.chamadas[0].campos.grantType, "refresh_token");
  assert.equal(http.chamadas[0].campos.refreshToken, "RT-old");
  assert.equal(t.accessToken, "AT-2");
});

test("renovarToken sem refreshToken -> IFOOD_REFRESH_FALHOU", async () => {
  await assert.rejects(() => svc.renovarToken({ appType: "financial", refreshToken: null, http: httpFalso([]) }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_REFRESH_FALHOU);
});

// --- getValidAccessToken -------------------------------------------
test("token ainda longe de expirar: devolve o atual, sem chamar o iFood", async () => {
  const repo = repoFalso({ access_token_cifrado: cifrar("AT-vivo"), refresh_token_cifrado: cifrar("RT"), expira_em: daquiA(60 * 60 * 1000), status: "ativa" });
  const http = httpFalso([]);
  const at = await svc.getValidAccessToken({ conexaoId: "c1", appType: "financial", deps: { repo, http } });
  assert.equal(at, "AT-vivo");
  assert.equal(http.chamadas.length, 0);
});

test("token perto de expirar: renova, persiste CIFRADO e devolve o novo", async () => {
  const repo = repoFalso({ access_token_cifrado: cifrar("AT-velho"), refresh_token_cifrado: cifrar("RT-1"), expira_em: daquiA(2 * 60 * 1000), status: "ativa" });
  const http = httpFalso([{ accessToken: "AT-novo", refreshToken: "RT-2", expiresIn: 21600 }]);
  const at = await svc.getValidAccessToken({ conexaoId: "c1", appType: "financial", deps: { repo, http } });
  assert.equal(at, "AT-novo");
  assert.equal(decifrar(repo._cred().access_token_cifrado), "AT-novo");
  assert.equal(decifrar(repo._cred().refresh_token_cifrado), "RT-2");
  assert.notEqual(repo._cred().access_token_cifrado, "AT-novo", "deve estar cifrado, não em claro");
});

test("credencial reauth_required: getValidAccessToken lança IFOOD_REFRESH_FALHOU", async () => {
  const repo = repoFalso({ access_token_cifrado: cifrar("x"), refresh_token_cifrado: cifrar("y"), expira_em: daquiA(60 * 60 * 1000), status: "reauth_required" });
  await assert.rejects(() => svc.getValidAccessToken({ conexaoId: "c1", appType: "financial", deps: { repo, http: httpFalso([]) } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_REFRESH_FALHOU);
});

test("refresh falha: marca credencial como reauth_required e propaga o erro", async () => {
  const repo = repoFalso({ access_token_cifrado: cifrar("AT"), refresh_token_cifrado: cifrar("RT"), expira_em: daquiA(60 * 1000), status: "ativa" });
  const http = httpFalso([{ erro: ifoodErro(IFOOD_ERROS.IFOOD_REFRESH_FALHOU) }]);
  await assert.rejects(() => svc.getValidAccessToken({ conexaoId: "c1", appType: "financial", deps: { repo, http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_REFRESH_FALHOU);
  assert.equal(repo._cred().status, "reauth_required");
});

// --- comAccessTokenValido: retry ÚNICO em 401 ---------------------
test("fn ok de primeira: chamada única", async () => {
  const repo = repoFalso({ access_token_cifrado: cifrar("AT"), refresh_token_cifrado: cifrar("RT"), expira_em: daquiA(60 * 60 * 1000), status: "ativa" });
  let n = 0;
  const r = await svc.comAccessTokenValido({ conexaoId: "c1", appType: "financial", deps: { repo, http: httpFalso([]) }, fn: async () => { n += 1; return "ok"; } });
  assert.equal(r, "ok");
  assert.equal(n, 1);
});

test("fn dá 401 uma vez -> refresh -> repete UMA vez -> sucesso (exatamente 2 chamadas de fn)", async () => {
  const repo = repoFalso({ access_token_cifrado: cifrar("AT-1"), refresh_token_cifrado: cifrar("RT-1"), expira_em: daquiA(60 * 60 * 1000), status: "ativa" });
  const http = httpFalso([{ accessToken: "AT-2", refreshToken: "RT-2", expiresIn: 21600 }]);
  let n = 0;
  const r = await svc.comAccessTokenValido({
    conexaoId: "c1", appType: "financial", deps: { repo, http },
    fn: async (token) => {
      n += 1;
      if (n === 1) { assert.equal(token, "AT-1"); throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO); }
      assert.equal(token, "AT-2");
      return "ok-na-segunda";
    },
  });
  assert.equal(r, "ok-na-segunda");
  assert.equal(n, 2);
});

test("fn dá 401 nas DUAS vezes -> propaga, sem loop (exatamente 2 chamadas de fn)", async () => {
  const repo = repoFalso({ access_token_cifrado: cifrar("AT-1"), refresh_token_cifrado: cifrar("RT-1"), expira_em: daquiA(60 * 60 * 1000), status: "ativa" });
  const http = httpFalso([{ accessToken: "AT-2", expiresIn: 21600 }]);
  let n = 0;
  await assert.rejects(() => svc.comAccessTokenValido({
    conexaoId: "c1", appType: "financial", deps: { repo, http },
    fn: async () => { n += 1; throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO); },
  }), (e) => e.codigo === IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
  assert.equal(n, 2, "no máximo 2 tentativas de fn — nunca um loop");
});

test("erro de fn que NÃO é 401 sobe direto, sem refresh", async () => {
  const repo = repoFalso({ access_token_cifrado: cifrar("AT"), refresh_token_cifrado: cifrar("RT"), expira_em: daquiA(60 * 60 * 1000), status: "ativa" });
  const http = httpFalso([]);
  let n = 0;
  await assert.rejects(() => svc.comAccessTokenValido({
    conexaoId: "c1", appType: "financial", deps: { repo, http },
    fn: async () => { n += 1; throw ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL); },
  }), (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL);
  assert.equal(n, 1);
  assert.equal(http.chamadas.length, 0, "não deve tentar refresh para erro não-401");
});
