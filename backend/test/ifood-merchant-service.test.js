// Merchant API do iFood (READ-ONLY): descoberta paginada + validação
// individual. Sem rede real, sem banco real. Exercita o token service real
// (comAccessTokenValido) com http/repo falsos.
import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_API_BASE_URL = "https://mock.ifood.test";
process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";
process.env.IFOOD_FINANCIAL_CLIENT_ID = "fin-client-id";
process.env.IFOOD_FINANCIAL_CLIENT_SECRET = "fin-client-secret";

const merchant = await import("../src/modules/ifood/ifoodMerchant.service.js");
const { IFOOD_ERROS, ifoodErro } = await import("../src/modules/ifood/ifood.errors.js");
const { cifrar } = await import("../src/shared/cripto.js");

const TENANT = { organizacaoId: "org-1", unidadeId: "uni-1" };
const daquiA = (ms) => new Date(Date.now() + ms).toISOString();
const paginaDe = (caminho) => Number(new URL(`https://x${caminho}`).searchParams.get("page"));

function repoFalso(opts = {}) {
  const estado = {
    conexao: "conexao" in opts ? opts.conexao : { id: "conx-1", status: "ativa" },
    cred: "cred" in opts ? opts.cred
      : { access_token_cifrado: cifrar("AT-atual"), refresh_token_cifrado: cifrar("RT-atual"), expira_em: daquiA(60 * 60 * 1000), status: "ativa" },
  };
  return {
    estado,
    async obterConexaoViva() { return estado.conexao; },
    async obterCredencial() { return estado.cred ? { ...estado.cred } : null; },
    async salvarCredencial(a) {
      estado.cred = { access_token_cifrado: a.accessTokenCifrado, refresh_token_cifrado: a.refreshTokenCifrado ?? estado.cred?.refresh_token_cifrado, expira_em: a.expiraEm, status: "ativa" };
      return estado.cred;
    },
    async atualizarCredencial({ campos }) { estado.cred = { ...estado.cred, ...campos }; return estado.cred; },
  };
}

function httpFalso({ get, post } = {}) {
  const chamadas = { get: [], post: [] };
  return {
    chamadas,
    async getJson(caminho, opts) { chamadas.get.push({ caminho, opts }); return get(caminho, opts, chamadas.get.length); },
    async postForm(caminho, campos) {
      chamadas.post.push({ caminho, campos });
      return post ? post(caminho, campos) : { accessToken: "AT-renovado", refreshToken: "RT-renovado", expiresIn: 21600 };
    },
  };
}

const fabricarMerchants = (n, prefixo = "m") =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefixo}-${i}`, name: `Loja ${prefixo}${i}`, corporateName: `Razao ${prefixo}${i} LTDA` }));

// =====================================================================
// DESCOBERTA
// =====================================================================
test("0 merchants: devolve lista vazia (não lança), 1 chamada", async () => {
  const http = httpFalso({ get: () => [] });
  const r = await merchant.listarMerchantsAutorizados({ ...TENANT, deps: { repo: repoFalso(), http } });
  assert.deepEqual(r, { merchants: [], total: 0, truncado: false });
  assert.equal(http.chamadas.get.length, 1);
});

test("1 merchant: sanitizado, com id real e idMascarado", async () => {
  const http = httpFalso({ get: () => [{ id: "550e8400-e29b-41d4-a716-446655440000", name: "Subway Saci", corporateName: "Saci Alimentos LTDA", type: "RESTAURANT", status: "AVAILABLE" }] });
  const r = await merchant.listarMerchantsAutorizados({ ...TENANT, deps: { repo: repoFalso(), http } });
  assert.equal(r.total, 1);
  assert.deepEqual(r.merchants[0], {
    id: "550e8400-e29b-41d4-a716-446655440000",
    idMascarado: "550e****0000",
    nome: "Subway Saci",
    razaoSocial: "Saci Alimentos LTDA",
    tipo: "RESTAURANT",
    status: "AVAILABLE",
  });
});

test("múltiplos merchants em 2 páginas: total somado, 2 chamadas, sem duplicar", async () => {
  const p1 = fabricarMerchants(100, "a");
  const p2 = fabricarMerchants(30, "b");
  const http = httpFalso({ get: (caminho) => (paginaDe(caminho) === 1 ? p1 : p2) });
  const r = await merchant.listarMerchantsAutorizados({ ...TENANT, deps: { repo: repoFalso(), http } });
  assert.equal(r.total, 130);
  assert.equal(http.chamadas.get.length, 2);
  assert.equal(r.truncado, false);
});

test("dedup entre páginas: mesmo id nas duas páginas conta uma vez", async () => {
  const comuns = fabricarMerchants(100, "x");
  const http = httpFalso({ get: (caminho) => (paginaDe(caminho) === 1 ? comuns : comuns.slice(0, 10)) });
  const r = await merchant.listarMerchantsAutorizados({ ...TENANT, deps: { repo: repoFalso(), http } });
  assert.equal(r.total, 100);
});

test("aceita envelope { merchants: [...] } além de array cru", async () => {
  const http = httpFalso({ get: () => ({ merchants: [{ id: "m1", name: "L1" }] }) });
  const r = await merchant.listarMerchantsAutorizados({ ...TENANT, deps: { repo: repoFalso(), http } });
  assert.equal(r.total, 1);
  assert.equal(r.merchants[0].id, "m1");
});

test("teto de páginas: páginas sempre cheias -> para no limite e marca truncado (com log)", async () => {
  const cheia = fabricarMerchants(100, "z");
  const http = httpFalso({ get: () => cheia });
  const r = await merchant.listarMerchantsAutorizados({ ...TENANT, deps: { repo: repoFalso(), http } });
  assert.equal(r.truncado, true);
  assert.equal(http.chamadas.get.length, 50, "maxPaginas");
});

test("sem conexão viva -> IFOOD_CONEXAO_NAO_ENCONTRADA", async () => {
  const http = httpFalso({ get: () => [] });
  await assert.rejects(
    () => merchant.listarMerchantsAutorizados({ ...TENANT, deps: { repo: repoFalso({ conexao: null }), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_CONEXAO_NAO_ENCONTRADA,
  );
  assert.equal(http.chamadas.get.length, 0);
});

test("sem credencial financial -> IFOOD_CREDENCIAL_NAO_ENCONTRADA", async () => {
  const http = httpFalso({ get: () => [] });
  await assert.rejects(
    () => merchant.listarMerchantsAutorizados({ ...TENANT, deps: { repo: repoFalso({ cred: null }), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_CREDENCIAL_NAO_ENCONTRADA,
  );
});

test("401 na descoberta: 1 refresh + 1 repetição, depois sucesso", async () => {
  let chamada = 0;
  const http = httpFalso({
    get: () => {
      chamada += 1;
      if (chamada === 1) throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
      return [{ id: "m1", name: "L1" }];
    },
  });
  const repo = repoFalso();
  const r = await merchant.listarMerchantsAutorizados({ ...TENANT, deps: { repo, http } });
  assert.equal(r.total, 1);
  assert.equal(http.chamadas.post.length, 1, "exatamente 1 refresh");
});

test("401 persistente na descoberta: propaga IFOOD_TOKEN_EXPIRADO sem loop", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO); } });
  await assert.rejects(
    () => merchant.listarMerchantsAutorizados({ ...TENANT, deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO,
  );
  assert.equal(http.chamadas.post.length, 1);
});

test("403 na descoberta -> IFOOD_MERCHANT_SEM_PERMISSAO", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO); } });
  await assert.rejects(
    () => merchant.listarMerchantsAutorizados({ ...TENANT, deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO,
  );
});

test("5xx/indisponível na descoberta -> IFOOD_INDISPONIVEL", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL); } });
  await assert.rejects(
    () => merchant.listarMerchantsAutorizados({ ...TENANT, deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_INDISPONIVEL,
  );
});

test("429 na descoberta -> IFOOD_RATE_LIMITED", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_RATE_LIMITED); } });
  await assert.rejects(
    () => merchant.listarMerchantsAutorizados({ ...TENANT, deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_RATE_LIMITED,
  );
});

// =====================================================================
// VALIDAÇÃO INDIVIDUAL
// =====================================================================
test("validarMerchant: happy path devolve detalhe sanitizado", async () => {
  const http = httpFalso({
    get: (caminho) => {
      assert.ok(caminho.startsWith("/merchant/v1.0/merchants/"));
      return { id: "abc-123", name: "Subway Saci", corporateName: "Saci LTDA", type: "RESTAURANT", status: "AVAILABLE" };
    },
  });
  const r = await merchant.validarMerchant({ ...TENANT, merchantId: "abc-123", deps: { repo: repoFalso(), http } });
  assert.equal(r.id, "abc-123");
  assert.equal(r.nome, "Subway Saci");
  assert.equal(r.razaoSocial, "Saci LTDA");
  assert.equal(r.status, "AVAILABLE");
});

test("validarMerchant: merchantId vazio -> IFOOD_MERCHANT_NAO_ENCONTRADO (sem chamar API)", async () => {
  const http = httpFalso({ get: () => ({}) });
  await assert.rejects(
    () => merchant.validarMerchant({ ...TENANT, merchantId: "  ", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_MERCHANT_NAO_ENCONTRADO,
  );
  assert.equal(http.chamadas.get.length, 0);
});

test("validarMerchant: 404 -> IFOOD_MERCHANT_NAO_ENCONTRADO", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_NAO_ENCONTRADO); } });
  await assert.rejects(
    () => merchant.validarMerchant({ ...TENANT, merchantId: "sumiu", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_MERCHANT_NAO_ENCONTRADO,
  );
});

test("validarMerchant: 403 -> IFOOD_MERCHANT_SEM_PERMISSAO", async () => {
  const http = httpFalso({ get: () => { throw ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO); } });
  await assert.rejects(
    () => merchant.validarMerchant({ ...TENANT, merchantId: "proibido", deps: { repo: repoFalso(), http } }),
    (e) => e.codigo === IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO,
  );
});

test("validarMerchant: 401 -> 1 refresh + 1 repetição", async () => {
  let n = 0;
  const http = httpFalso({
    get: () => { n += 1; if (n === 1) throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO); return { id: "m1", name: "L1" }; },
  });
  const r = await merchant.validarMerchant({ ...TENANT, merchantId: "m1", deps: { repo: repoFalso(), http } });
  assert.equal(r.id, "m1");
  assert.equal(http.chamadas.post.length, 1);
});
