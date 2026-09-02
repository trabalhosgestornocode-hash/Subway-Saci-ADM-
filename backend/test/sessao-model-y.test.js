// Fase D — sessões + Context Token v2 + Model Y.
//
// Unit/estático, SEM banco (a migration 060 não está aplicada em nenhum
// ambiente acessível — ver docs/multi-perfil-fase-d-*.md). Cobre:
//   * contextToken v2: payload com `pid`, VERSAO 2, v1 rejeitado;
//   * validarPidContraSessao (regra do pid — pura, cenários 8-15/28-29);
//   * resolverPerfilParaContexto (compat legado — cenários 22-25);
//   * criarSessao: invariantes de perfil/impersonação + NÃO auto-revoga (Model Y);
//   * revogarSessoes: guard "nunca revoga tudo" + escopos;
//   * scans de fonte: encerrarContexto por sessionId, selecionarContexto
//     escopa vínculos por perfil, requireContexto seta req.perfil, logout
//     do frontend usa scope:"local".
//
// Rodar: node --env-file-if-exists=.env --test test/sessao-model-y.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  emitirContextToken, verificarContextToken, validarPidContraSessao,
} from "../src/shared/contextToken.js";
import { resolverPerfilParaContexto } from "../src/modules/sessao/perfil.service.js";
import { criarSessao, revogarSessoes } from "../src/modules/sessao/sessao.service.js";
import { ApiError } from "../src/shared/ApiError.js";

const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SESSAO_SVC = src("../src/modules/sessao/sessao.service.js");
const AUTH = src("../src/middlewares/auth.js");
const CTX_TOKEN = src("../src/shared/contextToken.js");
const FRONT_SESSAO = src("../../frontend/src/sessao.js");

const U = "11111111-1111-4111-8111-111111111111"; // conta
const P1 = U;                                     // perfil inicial legado (id == conta)
const P2 = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const SID = "44444444-4444-4444-8444-444444444444";
const SUPER = "55555555-5555-4555-8555-555555555555";

async function esperaErro(fn, status) {
  try { await fn(); assert.fail("esperava ApiError"); }
  catch (e) { assert.ok(e instanceof ApiError, `veio ${e}`); if (status) assert.equal(e.statusCode, status); return e; }
}

// ---------------------------------------------------------------------------
describe("Context Token v2 — payload com pid", () => {
  const BASE = { usuarioId: U, sessionId: SID, organizacaoId: ORG, unidadeId: null, papel: "operations", permissoes: ["dashboard.ver"] };

  test("VERSAO 2 e `pid` no payload", () => {
    const { token } = emitirContextToken({ ...BASE, perfilId: P1 });
    const r = verificarContextToken(token);
    assert.equal(r.ok, true);
    assert.equal(r.payload.v, 2);
    assert.equal(r.payload.pid, P1);
    assert.equal(r.payload.sub, U);
  });

  test("impersonação: pid = null é estruturalmente válido", () => {
    const { token } = emitirContextToken({ ...BASE, perfilId: null, impersonadoPor: SUPER });
    const r = verificarContextToken(token);
    assert.equal(r.ok, true);
    assert.equal(r.payload.pid, null);
    assert.equal(r.payload.imp, SUPER);
  });

  test("cenário 13 — token v1 é REJEITADO (desatualizado)", () => {
    // simula um token v1: mesmo corpo, sem pid, v:1 — assinado com a MESMA chave
    const { token } = emitirContextToken({ ...BASE, perfilId: P1 });
    const [corpo, assin] = token.split(".");
    const payload = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8"));
    const v1 = { ...payload, v: 1 }; delete v1.pid;
    const corpoV1 = Buffer.from(JSON.stringify(v1)).toString("base64url");
    // assinatura antiga não casa com o corpo novo -> "inválido"; e mesmo que
    // casasse, `v: 1 !== VERSAO` -> "desatualizado". Os dois são recusa.
    const r = verificarContextToken(`${corpoV1}.${assin}`);
    assert.equal(r.ok, false);
  });

  test("`pid` NÃO está no check estrutural (só sub/sid/cid)", () => {
    assert.match(CTX_TOKEN, /pid.*NÃO entra no check estrutural/s);
    assert.match(CTX_TOKEN, /!payload\.sub \|\| !payload\.sid \|\| !payload\.cid/);
    assert.doesNotMatch(CTX_TOKEN, /!payload\.pid/);
  });
});

// ---------------------------------------------------------------------------
describe("validarPidContraSessao — regra do pid (pura)", () => {
  test("8) pid do token == perfil_id da linha, perfil ativo -> ok normal", () => {
    const r = validarPidContraSessao({ tokenPid: P1, sessaoPerfilId: P1, impersonadoPor: null, perfilAtivo: true });
    assert.deepEqual(r, { ok: true, modo: "normal" });
  });

  test("9) pid do token != perfil_id da linha -> 409 (mesmo sendo outro perfil da MESMA conta)", () => {
    const r = validarPidContraSessao({ tokenPid: P2, sessaoPerfilId: P1, impersonadoPor: null, perfilAtivo: true });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /divergente/i);
  });

  test("10) token pid null + linha de perfil NORMAL -> 409", () => {
    const r = validarPidContraSessao({ tokenPid: null, sessaoPerfilId: P1, impersonadoPor: null, perfilAtivo: true });
    assert.equal(r.ok, false); // já falha no cruzamento (null != P1)
  });

  test("10b) token pid null + linha perfil_id null + SEM impersonação -> 409 (invariante)", () => {
    const r = validarPidContraSessao({ tokenPid: null, sessaoPerfilId: null, impersonadoPor: null, perfilAtivo: null });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /inválido/i);
  });

  test("11) token pid null + linha perfil_id null + impersonação -> ok impersonacao", () => {
    const r = validarPidContraSessao({ tokenPid: null, sessaoPerfilId: null, impersonadoPor: SUPER, perfilAtivo: null });
    assert.deepEqual(r, { ok: true, modo: "impersonacao" });
  });

  test("12) token pid UUID + linha de impersonação (perfil_id null) -> 409", () => {
    const r = validarPidContraSessao({ tokenPid: P1, sessaoPerfilId: null, impersonadoPor: SUPER, perfilAtivo: null });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /divergente/i);
  });

  test("18) perfil desativado DEPOIS da emissão -> 409 (não confia em snapshot)", () => {
    const r = validarPidContraSessao({ tokenPid: P1, sessaoPerfilId: P1, impersonadoPor: null, perfilAtivo: false });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /desativado/i);
  });

  test("perfil não encontrado (embed null) em sessão normal -> 409", () => {
    const r = validarPidContraSessao({ tokenPid: P1, sessaoPerfilId: P1, impersonadoPor: null, perfilAtivo: null });
    assert.equal(r.ok, false);
  });
});

// ---------------------------------------------------------------------------
describe("resolverPerfilParaContexto — 1 perfil / legado (Fase H mudou o caminho multi-perfil)", () => {
  // Cobertura COMPLETA do caminho multi-perfil (prova de PIN, bypass, isolamento)
  // está em test/pin-selecao-perfil.test.js. Aqui só o que a Fase H NÃO mudou:
  // conta de 1 perfil e conta sem perfil.
  const perfil = (id, ativo = true, conta = U, pin = null) => ({ id, nome: `Perfil ${id.slice(0, 4)}`, ativo, conta_id: conta, pin_hash: pin });

  test("22) conta com 1 perfil ativo, perfilId AUSENTE -> resolve automaticamente, sem prova", async () => {
    const r = await resolverPerfilParaContexto(
      { contaId: U, perfilId: undefined },
      { buscarPerfisAtivosDaConta: async () => [perfil(P1)] },
    );
    assert.equal(r.id, P1);
    assert.equal(r.selecaoNonce, null); // 1 perfil = sem prova de PIN
  });

  test("22b) conta com 1 perfil ativo + perfilId EXPLÍCITO igual -> ok", async () => {
    const r = await resolverPerfilParaContexto(
      { contaId: U, perfilId: P1 },
      { buscarPerfisAtivosDaConta: async () => [perfil(P1)] },
    );
    assert.equal(r.id, P1);
  });

  test("22c) conta com 1 perfil + perfilId de OUTRO perfil -> 404 (não vaza)", async () => {
    await esperaErro(() => resolverPerfilParaContexto(
      { contaId: U, perfilId: P2 },
      { buscarPerfisAtivosDaConta: async () => [perfil(P1)] },
    ), 404);
  });

  test("23) conta com 0 perfil ativo -> 403 tratado", async () => {
    await esperaErro(() => resolverPerfilParaContexto(
      { contaId: U, perfilId: undefined },
      { buscarPerfisAtivosDaConta: async () => [] },
    ), 403);
  });

  test("24) conta com 2 perfis SEM prova -> NEGADO (nunca escolhe 'o primeiro')", async () => {
    let consultou = false;
    await esperaErro(() => resolverPerfilParaContexto(
      { contaId: U, perfilId: P1 }, // só o perfilId do corpo — insuficiente
      { buscarPerfisAtivosDaConta: async () => { consultou = true; return [perfil(P1, true, U, "s1:x"), perfil(P2, true, U, "s1:y")]; } },
    ), 400);
    assert.equal(consultou, true);
  });
});

// ---------------------------------------------------------------------------
describe("criarSessao — invariantes de perfil/impersonação", () => {
  test("sessão normal SEM perfilId -> erro (mais estrito que a migration)", async () => {
    await esperaErro(() => criarSessao({
      contaId: U, perfilId: null, organizacaoId: ORG, unidadeId: null,
      papel: "operations", permissoes: [], impersonadoPor: null,
    }));
  });

  test("impersonação COM perfilId -> erro", async () => {
    await esperaErro(() => criarSessao({
      contaId: SUPER, perfilId: P1, organizacaoId: ORG, unidadeId: null,
      papel: "organization_admin", permissoes: [], impersonadoPor: SUPER,
    }));
  });

  test("sem contaId -> erro", async () => {
    await esperaErro(() => criarSessao({
      perfilId: P1, organizacaoId: ORG, unidadeId: null, papel: "operations", permissoes: [], impersonadoPor: null,
    }));
  });
});

// ---------------------------------------------------------------------------
describe("revogarSessoes — nunca revoga tudo (Model Y)", () => {
  test("chamada SEM escopo -> LANÇA (não é no-op, não revoga a plataforma)", async () => {
    await esperaErro(() => revogarSessoes({}));
    await esperaErro(() => revogarSessoes({ motivo: "só motivo" }));
  });

  test("aceita `usuarioId` e `contaId` como o MESMO escopo (compat callers admin)", () => {
    assert.match(SESSAO_SVC, /const conta = contaId \?\? usuarioId/);
    assert.match(SESSAO_SVC, /filtros\.push\(\["usuario_id", conta\]\)/);
  });

  test("escopos suportados: sessionId | perfilId | conta | organizacaoId | unidadeId", () => {
    assert.match(SESSAO_SVC, /filtros\.push\(\["id", sessionId\]\)/);
    assert.match(SESSAO_SVC, /filtros\.push\(\["perfil_id", perfilId\]\)/);
    assert.match(SESSAO_SVC, /filtros\.push\(\["organizacao_id", organizacaoId\]\)/);
    assert.match(SESSAO_SVC, /filtros\.push\(\["unidade_id", unidadeId\]\)/);
    assert.match(SESSAO_SVC, /for \(const \[coluna, valor\] of filtros\) \{[\s\S]{0,160}q\.eq\(/); // AND
  });
});

// ---------------------------------------------------------------------------
describe("Model Y — scans de fonte (cenários 1-7, 44)", () => {
  // extrai o corpo de criarSessao
  const criarSessaoBody = SESSAO_SVC.slice(
    SESSAO_SVC.indexOf("export async function criarSessao"),
    SESSAO_SVC.indexOf("export async function revogarSessoes"),
  );

  test("criarSessao NÃO revoga sessões da conta/perfil (só a `revogarSessionId` explícita)", () => {
    assert.doesNotMatch(criarSessaoBody, /revogarSessoes\(\{\s*usuarioId/);
    assert.doesNotMatch(criarSessaoBody, /revogarSessoes\(\{\s*contaId/);
    assert.doesNotMatch(criarSessaoBody, /revogarSessoes\(\{\s*perfilId/);
    // a ÚNICA revogação permitida:
    assert.match(criarSessaoBody, /if \(revogarSessionId\)\s*\{[\s\S]*revogarSessoes\(\{ sessionId: revogarSessionId/);
  });

  test("criarSessao grava perfil_id e emite token com perfilId", () => {
    assert.match(criarSessaoBody, /perfil_id: perfilId/);
    assert.match(criarSessaoBody, /emitirContextToken\(\{[\s\S]*perfilId,/);
  });

  test("encerrarContexto (logout) revoga por sessionId, NUNCA por usuarioId (cenários 3/4/10)", () => {
    const body = SESSAO_SVC.slice(SESSAO_SVC.indexOf("export async function encerrarContexto"), SESSAO_SVC.indexOf("export async function definirNovaSenha"));
    assert.match(body, /revogarSessoes\(\{ sessionId: acesso\.sessionId/);
    assert.doesNotMatch(body, /revogarSessoes\(\{ usuarioId/);
  });

  test("selecionarContexto escopa TODOS os vínculos por perfil.id (isolamento — cenários 19-21)", () => {
    const body = SESSAO_SVC.slice(SESSAO_SVC.indexOf("export async function selecionarContexto"), SESSAO_SVC.indexOf("export async function trocarUnidadeDoContexto"));
    assert.match(body, /buscarVinculoOrg\(\{ perfilId: perfil\.id/);  // vínculo de empresa
    assert.match(body, /checarUnidade\(\{ perfilId: perfil\.id/);      // vínculo de unidade
    assert.doesNotMatch(body, /\.eq\("usuario_id", usuario\.id\)/);   // nunca pela conta
    assert.match(body, /const perfil = await resolver\(/);            // resolve/valida ANTES
  });

  test("trocarUnidadeDoContexto revoga só a sessão atual (sessionIdAtual)", () => {
    const body = SESSAO_SVC.slice(SESSAO_SVC.indexOf("export async function trocarUnidadeDoContexto"), SESSAO_SVC.indexOf("export async function criarSessao"));
    assert.match(body, /revogarSessionId: sessionIdAtual/);
  });
});

// ---------------------------------------------------------------------------
describe("requireContexto — pid + req.perfil (scan)", () => {
  const body = AUTH.slice(AUTH.indexOf("export async function requireContexto"), AUTH.indexOf("function erroContexto"));

  test("lê perfil_id da sessão e busca perfis_operacionais", () => {
    assert.match(body, /perfil_id/);
    assert.match(body, /perfis_operacionais/);
  });
  test("aplica validarPidContraSessao e recusa em pid.ok === false", () => {
    assert.match(body, /validarPidContraSessao\(\{/);
    assert.match(body, /if \(!pid\.ok\) return next\(erroContexto\(pid\.motivo\)\)/);
  });
  test("seta req.perfil (null em impersonação) + req.acesso.perfilId", () => {
    assert.match(body, /req\.perfil = sessao\.perfil_id\s*\?\s*\{ id: sessao\.perfil_id, nome:/);
    assert.match(body, /perfilId: sessao\.perfil_id \?\? null/);
  });
  test("NÃO sobrescreve req.user.id nem mistura perfil em req.user (proibido — item 13)", () => {
    assert.doesNotMatch(AUTH, /req\.user\.id\s*=[^=]/);              // reatribuição de req.user.id
    assert.doesNotMatch(AUTH, /req\.user\.(perfilId|perfil_id|perfilOperacional)/); // perfil misturado na conta
    assert.doesNotMatch(AUTH, /req\.user\s*=\s*req\.perfil/);
    // req.perfil e req.acesso.perfilId são as ÚNICAS portas do perfil no request
    assert.match(body, /req\.perfil =/);
    assert.match(body, /perfilId: sessao\.perfil_id/);
  });
});

// ---------------------------------------------------------------------------
describe("logout do frontend — scope local (cenário 43)", () => {
  test("logout() usa signOut({ scope: 'local' }), nunca signOut() sem escopo", () => {
    const i = FRONT_SESSAO.indexOf("export async function logout");
    const body = FRONT_SESSAO.slice(i, i + 1400);
    assert.match(body, /signOut\(\{\s*scope:\s*["']local["']\s*\}\)/);
    assert.doesNotMatch(FRONT_SESSAO, /auth\.signOut\(\)/); // nenhum signOut() sem escopo em todo o arquivo
  });
});

// ---------------------------------------------------------------------------
describe("impersonação — entrarComoEmpresa (scan, cenários 26-29)", () => {
  const EMPRESAS = src("../src/modules/plataforma/plataforma.empresas.service.js");
  test("criarSessao com perfilId: null + impersonadoPor setado", () => {
    const body = EMPRESAS.slice(EMPRESAS.indexOf("export async function entrarComoEmpresa"), EMPRESAS.indexOf("export async function entrarComoEmpresa") + 1500);
    assert.match(body, /perfilId: null/);
    assert.match(body, /impersonadoPor: req\.user\.id/);
  });
});
