// Fase H — PIN individual do perfil + prova segura de seleção.
//
// Unit/estático, SEM banco (060/064 não aplicadas). Cobre os testes numerados
// 1–47 do pedido da Fase H:
//   * hash do PIN (scrypt): nunca texto puro, salt por PIN, verificação,
//     hash malformado sem 500, hash nunca serializado;
//   * lockout por perfil: incremento, limite, bloqueio, expiração, reset;
//   * isolamento: conta A não testa PIN de conta B; Fulana 1 != Fulana 2;
//   * BYPASS (crítico): /sessao/selecionar de conta multi-perfil sem prova ->
//     NEGADO; prova de Fulana 1 não serve para Fulana 2; prova de outra conta
//     -> NEGADO; expirada -> NEGADO; assinatura alterada -> NEGADO; purpose
//     trocado -> NEGADO; Context Token != Selection Token (nos dois sentidos);
//   * compatibilidade: conta de 1 perfil sem PIN continua; frontend antigo;
//   * sessão: prova consumida = uso único; reload não pede PIN;
//   * reset administrativo: revoga só o perfil, não os irmãos; nunca audita PIN.
//
// Rodar: node --env-file-if-exists=.env --test test/pin-selecao-perfil.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { hashPin, verificarPin, validarFormatoPin, PIN_PARAMS } from "../src/shared/pin.js";
import {
  emitirProfileSelectionToken, verificarProfileSelectionToken, PROFILE_SELECTION_META,
} from "../src/shared/profileSelectionToken.js";
import { emitirContextToken, verificarContextToken } from "../src/shared/contextToken.js";
import {
  selecionarPerfil, validarPinParaSelecao, resolverPerfilParaContexto,
} from "../src/modules/sessao/perfil.service.js";
import { ApiError } from "../src/shared/ApiError.js";

const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const PERFIL_SVC = src("../src/modules/sessao/perfil.service.js");
const SESSAO_SVC = src("../src/modules/sessao/sessao.service.js");
const SESSAO_CTRL = src("../src/modules/sessao/sessao.controller.js");
const PIN_SRC = src("../src/shared/pin.js");
const TOKEN_SRC = src("../src/shared/profileSelectionToken.js");

const CONTA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FULANA_1 = "11111111-1111-4111-8111-111111111111";
const FULANA_2 = "22222222-2222-4222-8222-222222222222";

async function erro(fn, status, codigo) {
  try { await fn(); assert.fail("esperava ApiError"); }
  catch (e) {
    assert.ok(e instanceof ApiError, `veio ${e?.stack || e}`);
    if (status) assert.equal(e.statusCode, status, `status: ${e.message}`);
    if (codigo) assert.equal(e.details?.codigo, codigo);
    return e;
  }
}

// perfil ativo com PIN "1234" já hasheado (compartilhado entre testes p/ velocidade)
let HASH_1234;
test("setup: hash de referência", async () => { HASH_1234 = await hashPin("1234"); });

// ===========================================================================
describe("hash do PIN — scrypt (testes 1–6, 20)", () => {
  test("1) PIN nunca é armazenado puro — o hash não contém o PIN", async () => {
    const h = await hashPin("4821");
    assert.ok(!h.includes("4821"));
    assert.match(h, /^s1:\d+:\d+:\d+:\d+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    assert.equal(PIN_PARAMS.versao, "s1");
  });

  test("2) o MESMO PIN em perfis diferentes gera hashes diferentes (salt por PIN)", async () => {
    const a = await hashPin("999999");
    const b = await hashPin("999999");
    assert.notEqual(a, b);
    assert.ok(await verificarPin("999999", a));
    assert.ok(await verificarPin("999999", b));
  });

  test("3) PIN correto valida", async () => {
    assert.equal(await verificarPin("1234", HASH_1234), true);
  });

  test("4) PIN incorreto falha", async () => {
    assert.equal(await verificarPin("1235", HASH_1234), false);
    assert.equal(await verificarPin("12340", HASH_1234), false);
  });

  test("5) hash malformado/nulo -> false, NUNCA lança (sem 500 inseguro)", async () => {
    for (const bad of [null, undefined, "", "lixo", "s1:só:dois", "s9:32768:8:1:32:x:y", 123]) {
      assert.equal(await verificarPin("1234", bad), false);
    }
  });

  test("6) resposta/serialização nunca contém pin_hash", () => {
    // o cliente só recebe `temPin` booleano — nunca o hash / contador / bloqueio.
    assert.match(PERFIL_SVC, /temPin: !!.*pin_hash/);
    // as respostas das funções EXPORTADAS de fluxo do usuário:
    for (const nome of ["listarPerfisDaConta", "selecionarPerfil"]) {
      const i = PERFIL_SVC.indexOf(`export async function ${nome}`);
      const corpo = PERFIL_SVC.slice(i, PERFIL_SVC.indexOf("\nexport ", i + 30));
      const respostas = corpo.match(/return \{[\s\S]*?\};/g) ?? [];
      for (const r of respostas) {
        const semTemPin = r.replace(/!!\s*[\w.]*pin_hash/g, "");
        assert.ok(!/pin_hash|pin_tentativas|pin_bloqueado/.test(semTemPin), `${nome} vaza PIN:\n${r}`);
      }
    }
  });

  test("scrypt é memory-hard, não SHA/HMAC/base64", () => {
    assert.match(PIN_SRC, /crypto\.scrypt\b/);
    assert.doesNotMatch(PIN_SRC, /createHash\(["']sha256["']\).*pin/i);
    assert.doesNotMatch(PIN_SRC, /createHmac\(.*pin/i);
    assert.match(PIN_SRC, /timingSafeEqual/);
  });
});

// ===========================================================================
describe("formato do PIN (teste 13)", () => {
  test("aceita 4 a 6 dígitos", () => {
    for (const ok of ["0000", "1234", "12345", "123456", "999999"]) {
      assert.equal(validarFormatoPin(ok), ok);
    }
  });
  test("rejeita vazio / não-numérico / tamanho fora", () => {
    for (const bad of ["", "123", "1234567", "12a4", "abcd", null, undefined, {}, "12 4"]) {
      assert.throws(() => validarFormatoPin(bad), (e) => e instanceof ApiError && e.statusCode === 400);
    }
  });
  test("número puro é normalizado para string", () => {
    assert.equal(validarFormatoPin(1234), "1234");
  });
});

// ===========================================================================
describe("Profile Selection Token — assinatura, propósito, expiração (testes 26–28, 45)", () => {
  test("emite e verifica um token válido", () => {
    const { token, nonce } = emitirProfileSelectionToken({ contaId: CONTA_A, perfilId: FULANA_1 });
    const r = verificarProfileSelectionToken(token);
    assert.equal(r.ok, true);
    assert.equal(r.payload.acc, CONTA_A);
    assert.equal(r.payload.pid, FULANA_1);
    assert.equal(r.payload.jti, nonce);
    assert.equal(r.payload.purpose, "profile_selection");
    assert.equal(r.payload.v, 1);
  });

  test("27) assinatura alterada -> NEGADO", () => {
    const { token } = emitirProfileSelectionToken({ contaId: CONTA_A, perfilId: FULANA_1 });
    const [corpo, sig] = token.split(".");
    assert.equal(verificarProfileSelectionToken(`${corpo}.${sig.slice(0, -4)}AAAA`).ok, false);
    assert.equal(verificarProfileSelectionToken(`${corpo}x.${sig}`).ok, false);
  });

  test("26) token expirado -> NEGADO", () => {
    const { token } = emitirProfileSelectionToken({ contaId: CONTA_A, perfilId: FULANA_1, validadeS: -10 });
    const r = verificarProfileSelectionToken(token);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /expirada/i);
  });

  test("28) purpose diferente -> NEGADO", () => {
    // forja um corpo com purpose trocado e re-assina? não temos o secret aqui —
    // então validamos que a verificação CHECA o purpose no código-fonte + que
    // um Context Token (sem purpose) é recusado.
    assert.match(TOKEN_SRC, /payload\.purpose !== PROPOSITO.*NEGADO|purpose !== PROPOSITO/s);
    const ctx = emitirContextToken({ usuarioId: CONTA_A, sessionId: "s", organizacaoId: "o", perfilId: FULANA_1, papel: "viewer" });
    assert.equal(verificarProfileSelectionToken(ctx.token).ok, false);
  });

  test("29/30) Context Token e Selection Token NÃO são intercambiáveis", () => {
    const sel = emitirProfileSelectionToken({ contaId: CONTA_A, perfilId: FULANA_1 });
    const ctx = emitirContextToken({ usuarioId: CONTA_A, sessionId: "s", organizacaoId: "o", perfilId: FULANA_1, papel: "viewer" });
    assert.equal(verificarContextToken(sel.token).ok, false); // selection usado como context
    assert.equal(verificarProfileSelectionToken(ctx.token).ok, false); // context usado como selection
  });

  test("token malformado -> NEGADO sem lançar", () => {
    for (const bad of [null, undefined, "", "semponto", "a.b.c.d", 42]) {
      assert.equal(verificarProfileSelectionToken(bad).ok, false);
    }
  });

  test("duração é curta (5 min) e documentada", () => {
    assert.equal(PROFILE_SELECTION_META.validadeS, 300);
  });
});

// ===========================================================================
describe("selecionarPerfil — conta 1 perfil × multi-perfil (testes 19–20, 31–36)", () => {
  const perfil = (id, { ativo = true, pin = null, conta = CONTA_A } = {}) =>
    ({ id, nome: `P ${id.slice(0, 4)}`, ativo, conta_id: conta, pin_hash: pin });
  const buscarPerfilDaConta = (lista) => async ({ contaId, perfilId }) => {
    const p = lista.find((x) => x.id === perfilId);
    return p && p.conta_id === contaId ? p : null;
  };
  const provaFake = () => ({ token: "PROVA", expiraEm: new Date(Date.now() + 300_000) });

  test("31/33) conta com 1 perfil (sem PIN) -> emite prova SEM pedir PIN", async () => {
    const p1 = perfil(FULANA_1);
    const r = await selecionarPerfil({ contaId: CONTA_A, perfilId: FULANA_1 }, {
      buscarPerfilDaConta: buscarPerfilDaConta([p1]),
      buscarPerfisAtivosDaConta: async () => [p1],
      emitirProva: provaFake,
    });
    assert.equal(r.precisaPin, false);
    assert.equal(r.profileSelectionToken, "PROVA");
    assert.equal(r.proximoPasso, "selecionar_contexto");
  });

  test("34) conta com 2 perfis (ambos com PIN) sem `pin` no corpo -> precisaPin:true, SEM prova", async () => {
    const ps = [perfil(FULANA_1, { pin: "s1:x" }), perfil(FULANA_2, { pin: "s1:y" })];
    const r = await selecionarPerfil({ contaId: CONTA_A, perfilId: FULANA_1 }, {
      buscarPerfilDaConta: buscarPerfilDaConta(ps),
      buscarPerfisAtivosDaConta: async () => ps,
      emitirProva: provaFake,
    });
    assert.equal(r.precisaPin, true);
    assert.ok(!("profileSelectionToken" in r));
  });

  test("35) conta com 2 perfis e UM sem PIN -> CONFIGURACAO_PIN_INCOMPLETA, ninguém entra", async () => {
    const ps = [perfil(FULANA_1, { pin: "s1:x" }), perfil(FULANA_2, { pin: null })];
    await erro(() => selecionarPerfil({ contaId: CONTA_A, perfilId: FULANA_1, pin: "1234" }, {
      buscarPerfilDaConta: buscarPerfilDaConta(ps),
      buscarPerfisAtivosDaConta: async () => ps,
      emitirProva: provaFake,
    }), 403, "CONFIGURACAO_PIN_INCOMPLETA");
  });

  test("2 perfis, pin correto -> valida e emite prova", async () => {
    const ps = [perfil(FULANA_1, { pin: HASH_1234 }), perfil(FULANA_2, { pin: "s1:y" })];
    const r = await selecionarPerfil({ contaId: CONTA_A, perfilId: FULANA_1, pin: "1234" }, {
      buscarPerfilDaConta: buscarPerfilDaConta(ps),
      buscarPerfisAtivosDaConta: async () => ps,
      buscarPerfilComPin: async () => ({ ...ps[0], pin_tentativas: 0, pin_bloqueado_ate: null }),
      registrarFalha: async () => ({}),
      registrarSucesso: async () => {},
      emitirProva: provaFake,
    });
    assert.equal(r.precisaPin, false);
    assert.equal(r.profileSelectionToken, "PROVA");
  });

  test("2 perfis, pin ERRADO -> 401, sem prova", async () => {
    const ps = [perfil(FULANA_1, { pin: HASH_1234 }), perfil(FULANA_2, { pin: "s1:y" })];
    await erro(() => selecionarPerfil({ contaId: CONTA_A, perfilId: FULANA_1, pin: "0000" }, {
      buscarPerfilDaConta: buscarPerfilDaConta(ps),
      buscarPerfisAtivosDaConta: async () => ps,
      buscarPerfilComPin: async () => ({ ...ps[0], pin_tentativas: 0, pin_bloqueado_ate: null }),
      registrarFalha: async () => ({ tentativas: 1, bloqueadoAte: null }),
      registrarSucesso: async () => {},
      emitirProva: provaFake,
    }), 401);
  });

  test("18/8/A) perfil de outra conta -> 404 genérico (não vaza)", async () => {
    await erro(() => selecionarPerfil({ contaId: CONTA_A, perfilId: FULANA_2 }, {
      buscarPerfilDaConta: buscarPerfilDaConta([perfil(FULANA_2, { conta: CONTA_B })]),
      buscarPerfisAtivosDaConta: async () => [],
      emitirProva: provaFake,
    }), 404);
  });
});

// ===========================================================================
describe("validarPinParaSelecao — lockout por perfil (testes 7–13, 15–19, 41–42)", () => {
  const base = { id: FULANA_1, nome: "Fulana 1", ativo: true, conta_id: CONTA_A, pin_hash: null, pin_tentativas: 0, pin_bloqueado_ate: null };
  const deps = (over = {}, cont = {}) => ({
    buscarPerfilComPin: async () => ({ ...base, ...over }),
    verificarPin: async (pin) => pin === "1234",
    registrarFalha: cont.registrarFalha ?? (async () => ({ tentativas: 1, bloqueadoAte: null })),
    registrarSucesso: cont.registrarSucesso ?? (async () => {}),
    agora: cont.agora,
  });

  test("15/18) perfil de outra conta -> 404; perfil inexistente -> 404 (mesma resposta)", async () => {
    await erro(() => validarPinParaSelecao({ contaId: CONTA_A, perfilId: FULANA_1, pin: "1234" }, {
      buscarPerfilComPin: async () => null, verificarPin: async () => true,
    }), 404);
  });

  test("41) perfil INATIVO -> 403 ANTES de qualquer hash", async () => {
    let hasheou = false;
    await erro(() => validarPinParaSelecao({ contaId: CONTA_A, perfilId: FULANA_1, pin: "1234" }, {
      buscarPerfilComPin: async () => ({ ...base, ativo: false, pin_hash: HASH_1234 }),
      verificarPin: async () => { hasheou = true; return true; },
      registrarFalha: async () => ({}), registrarSucesso: async () => {},
    }), 403);
    assert.equal(hasheou, false);
  });

  test("10/42) perfil BLOQUEADO por PIN -> 429, mesmo com PIN correto, SEM hash", async () => {
    let hasheou = false;
    const e = await erro(() => validarPinParaSelecao({ contaId: CONTA_A, perfilId: FULANA_1, pin: "1234" }, {
      buscarPerfilComPin: async () => ({ ...base, pin_hash: HASH_1234, pin_bloqueado_ate: new Date(Date.now() + 600_000).toISOString() }),
      verificarPin: async () => { hasheou = true; return true; },
      registrarFalha: async () => ({}), registrarSucesso: async () => {},
    }), 429, "PIN_TEMPORARIAMENTE_BLOQUEADO");
    assert.equal(hasheou, false);
    assert.doesNotMatch(e.message, /hash|scrypt|s1:/i); // mensagem genérica
  });

  test("11) após a expiração do bloqueio pode tentar de novo", async () => {
    const r = await validarPinParaSelecao({ contaId: CONTA_A, perfilId: FULANA_1, pin: "1234" }, deps({
      pin_hash: HASH_1234, pin_bloqueado_ate: new Date(Date.now() - 1000).toISOString(),
    }));
    assert.deepEqual(r, { ok: true });
  });

  test("7/8) PIN errado -> incrementa (registrarFalha chamado com as tentativas atuais)", async () => {
    let chamada = null;
    await erro(() => validarPinParaSelecao({ contaId: CONTA_A, perfilId: FULANA_1, pin: "9999" }, deps(
      { pin_hash: HASH_1234, pin_tentativas: 2 },
      { registrarFalha: async (id, atuais) => { chamada = { id, atuais }; return { tentativas: 3, bloqueadoAte: null }; } },
    )), 401);
    assert.deepEqual(chamada, { id: FULANA_1, atuais: 2 });
  });

  test("9) ao atingir o limite, registrarFalha devolve bloqueio -> 429", async () => {
    await erro(() => validarPinParaSelecao({ contaId: CONTA_A, perfilId: FULANA_1, pin: "9999" }, deps(
      { pin_hash: HASH_1234, pin_tentativas: 4 },
      { registrarFalha: async () => ({ tentativas: 5, bloqueadoAte: new Date(Date.now() + 900_000).toISOString() }) },
    )), 429, "PIN_TEMPORARIAMENTE_BLOQUEADO");
  });

  test("12/13) PIN correto -> registrarSucesso chamado (zera tentativas/bloqueio)", async () => {
    let resetou = false;
    const r = await validarPinParaSelecao({ contaId: CONTA_A, perfilId: FULANA_1, pin: "1234" }, deps(
      { pin_hash: HASH_1234, pin_tentativas: 3 },
      { registrarSucesso: async (id) => { resetou = id; } },
    ));
    assert.deepEqual(r, { ok: true });
    assert.equal(resetou, FULANA_1);
  });

  test("14) o incremento é atômico via RPC (com fallback CAS documentado)", () => {
    assert.match(PERFIL_SVC, /supabase\.rpc\("perfil_pin_registrar_falha"/);
    assert.match(PERFIL_SVC, /supabase\.rpc\("perfil_pin_registrar_sucesso"/);
    assert.match(PERFIL_SVC, /\.eq\("pin_tentativas", tentativasAtuais\)/); // CAS de fallback
  });

  test("16/17) Fulana 1 e Fulana 2: verificação é escopada por (conta, perfil)", () => {
    // buscarPerfilComPin filtra por id E confere conta_id === contaId
    const fn = PERFIL_SVC.slice(PERFIL_SVC.indexOf("async function buscarPerfilComPin"), PERFIL_SVC.indexOf("async function buscarPerfilComPin") + 500);
    assert.match(fn, /\.eq\("id", perfilId\)/);
    assert.match(fn, /data\.conta_id !== contaId\) return null/);
  });
});

// ===========================================================================
describe("BYPASS — /sessao/selecionar de conta multi-perfil (testes 21–25) — CRÍTICO", () => {
  const perfilAtivo = (id, pin = "s1:hash") => ({ id, nome: `P ${id.slice(0, 4)}`, ativo: true, conta_id: CONTA_A, pin_hash: pin });
  const doisPerfis = async () => [perfilAtivo(FULANA_1), perfilAtivo(FULANA_2)];

  test("21) conta com 2 perfis, só `perfilId` no corpo (SEM prova) -> NEGADO", async () => {
    await erro(() => resolverPerfilParaContexto(
      { contaId: CONTA_A, perfilId: FULANA_2 },
      { buscarPerfisAtivosDaConta: doisPerfis },
    ), 400, "PROVA_PERFIL_OBRIGATORIA");
  });

  test("22) conta com 2 perfis, prova ausente/vazia -> NEGADO", async () => {
    for (const p of [undefined, null, ""]) {
      await erro(() => resolverPerfilParaContexto(
        { contaId: CONTA_A, perfilId: FULANA_1, provaSelecao: p },
        { buscarPerfisAtivosDaConta: doisPerfis },
      ), 400);
    }
  });

  test("23) prova de Fulana 1 + perfilId Fulana 2 no corpo -> NEGADO (divergente)", async () => {
    const { token } = emitirProfileSelectionToken({ contaId: CONTA_A, perfilId: FULANA_1 });
    await erro(() => resolverPerfilParaContexto(
      { contaId: CONTA_A, perfilId: FULANA_2, provaSelecao: token },
      { buscarPerfisAtivosDaConta: doisPerfis },
    ), 400, "PROVA_PERFIL_DIVERGENTE");
  });

  test("23b) prova de Fulana 1 -> resolve Fulana 1, NUNCA Fulana 2", async () => {
    const { token, nonce } = emitirProfileSelectionToken({ contaId: CONTA_A, perfilId: FULANA_1 });
    const r = await resolverPerfilParaContexto(
      { contaId: CONTA_A, provaSelecao: token },
      { buscarPerfisAtivosDaConta: doisPerfis },
    );
    assert.equal(r.id, FULANA_1);
    assert.equal(r.selecaoNonce, nonce); // vai virar sessoes_contexto.selecao_nonce (uso único)
  });

  test("24) prova cujo `pid` não é perfil ativo da conta -> NEGADO", async () => {
    const { token } = emitirProfileSelectionToken({ contaId: CONTA_A, perfilId: "99999999-9999-4999-8999-999999999999" });
    await erro(() => resolverPerfilParaContexto(
      { contaId: CONTA_A, provaSelecao: token },
      { buscarPerfisAtivosDaConta: doisPerfis },
    ), 400, "PROVA_PERFIL_INVALIDA");
  });

  test("25) prova emitida para a Conta A, usada pela Conta B -> NEGADO (acc != req.user.id)", async () => {
    const { token } = emitirProfileSelectionToken({ contaId: CONTA_A, perfilId: FULANA_1 });
    await erro(() => resolverPerfilParaContexto(
      { contaId: CONTA_B, provaSelecao: token },
      { buscarPerfisAtivosDaConta: async () => [{ id: FULANA_1, nome: "x", ativo: true, conta_id: CONTA_B, pin_hash: "s1:h" }, { id: FULANA_2, nome: "y", ativo: true, conta_id: CONTA_B, pin_hash: "s1:h" }] },
    ), 400, "PROVA_PERFIL_INVALIDA");
  });

  test("26) prova EXPIRADA -> NEGADO, sem fallback para perfilId", async () => {
    const { token } = emitirProfileSelectionToken({ contaId: CONTA_A, perfilId: FULANA_1, validadeS: -5 });
    await erro(() => resolverPerfilParaContexto(
      { contaId: CONTA_A, perfilId: FULANA_1, provaSelecao: token },
      { buscarPerfisAtivosDaConta: doisPerfis },
    ), 400, "PROVA_PERFIL_INVALIDA");
  });

  test("config de PIN incompleta bloqueia ANTES de exigir prova", async () => {
    await erro(() => resolverPerfilParaContexto(
      { contaId: CONTA_A, perfilId: FULANA_1, provaSelecao: "qualquer" },
      { buscarPerfisAtivosDaConta: async () => [perfilAtivo(FULANA_1, "s1:h"), perfilAtivo(FULANA_2, null)] },
    ), 403, "CONFIGURACAO_PIN_INCOMPLETA");
  });

  test("selecionarContexto encaminha a prova e o nonce (scan de fonte)", () => {
    assert.match(SESSAO_SVC, /provaSelecao\b/);
    assert.match(SESSAO_SVC, /resolver\(\{ contaId: usuario\.id, perfilId, provaSelecao \}\)/);
    assert.match(SESSAO_SVC, /selecaoNonce: perfil\.selecaoNonce \?\? null/);
    assert.match(SESSAO_CTRL, /provaSelecao: body\.profileSelectionToken/);
  });
});

// ===========================================================================
describe("uso único da prova (teste — Fase H ponto 6) + sessão (37–41)", () => {
  test("criarSessao grava selecao_nonce e rejeita reuso (UNIQUE parcial 064)", () => {
    const i = SESSAO_SVC.indexOf("export async function criarSessao");
    const fn = SESSAO_SVC.slice(i, SESSAO_SVC.indexOf("export ", i + 30));
    assert.match(fn, /selecaoNonce = null/);
    assert.match(fn, /if \(selecaoNonce\) linhaNova\.selecao_nonce = selecaoNonce/);
    assert.match(fn, /uq_sessoes_selecao_nonce/);
    assert.match(fn, /PROVA_PERFIL_CONSUMIDA/);
    assert.match(fn, /selecao_nonce\|schema cache\|could not find/); // degrada pré-064
  });

  test("38/47) reload com Context Token válido NÃO passa por PIN (requireContexto não conhece PIN)", () => {
    const AUTH = src("../src/middlewares/auth.js");
    assert.doesNotMatch(AUTH, /\bpin\b/i);
    assert.doesNotMatch(SESSAO_SVC.slice(SESSAO_SVC.indexOf("trocarUnidadeDoContexto")), /provaSelecao|profileSelectionToken/);
  });

  test("44) PIN não entra no Context Token", () => {
    const CTX = src("../src/shared/contextToken.js");
    assert.doesNotMatch(CTX, /pin/i);
  });
});

// ===========================================================================
describe("reset administrativo do PIN (testes 42–47)", () => {
  test("42/43/44) definirPinDoPerfil: hash + zera tentativas + limpa bloqueio + pin_atualizado_em", () => {
    const fn = PERFIL_SVC.slice(PERFIL_SVC.indexOf("export async function definirPinDoPerfil"), PERFIL_SVC.indexOf("export async function trocarPinDoPerfil"));
    assert.match(fn, /pin_hash: hash/);
    assert.match(fn, /pin_tentativas: 0/);
    assert.match(fn, /pin_bloqueado_ate: null/);
    assert.match(fn, /pin_atualizado_em: new Date/);
    assert.match(fn, /pin_atualizado_em\|schema cache\|could not find/); // degrada pré-064
  });

  test("45/46) reset revoga SÓ as sessões do perfil (escopo perfilId), não os irmãos", () => {
    const fn = PERFIL_SVC.slice(PERFIL_SVC.indexOf("export async function definirPinDoPerfil"), PERFIL_SVC.indexOf("export async function trocarPinDoPerfil"));
    assert.match(fn, /revogarSessoes\)\(\{ perfilId: pId, motivo \}\)/);
    assert.doesNotMatch(fn, /\{ usuarioId/);
  });

  test("47) auditoria do PIN nunca grava o valor nem o hash", () => {
    const PLAT = src("../src/modules/plataforma/plataforma.usuarios.service.js");
    const bloco = PLAT.slice(PLAT.indexOf("definirPinPerfil"), PLAT.indexOf("removerPinPerfil") + 400);
    assert.doesNotMatch(bloco, /detalhes:\s*\{[^}]*pin\b/i);
    assert.doesNotMatch(bloco, /pin_hash|body\.pin|hash/);
    assert.match(bloco, /acao: ACOES\.PERFIL_PIN_DEFINIDO/);
  });

  test("removerPinDoPerfil bloqueia se a conta ficar multi-perfil sem PIN", () => {
    const fn = PERFIL_SVC.slice(PERFIL_SVC.indexOf("export async function removerPinDoPerfil"));
    assert.match(fn, /ativos\.length >= 2 && ativos\.some\(\(p\) => p\.id === pId\)/);
    assert.match(fn, /CONFIGURACAO_PIN_INCOMPLETA/);
  });
});

// ===========================================================================
describe("compatibilidade (testes 31–36, backward compat A–D)", () => {
  test("conta de 1 perfil: resolverPerfilParaContexto resolve sem prova, selecaoNonce null", async () => {
    const r = await resolverPerfilParaContexto(
      { contaId: CONTA_A, perfilId: undefined },
      { buscarPerfisAtivosDaConta: async () => [{ id: FULANA_1, nome: "F1", ativo: true, conta_id: CONTA_A, pin_hash: null }] },
    );
    assert.equal(r.id, FULANA_1);
    assert.equal(r.selecaoNonce, null);
  });

  test("pré-060: buscarPerfisAtivosDaConta lança -> conta = próprio perfil, sem prova", async () => {
    const r = await resolverPerfilParaContexto(
      { contaId: CONTA_A, perfilId: undefined },
      { buscarPerfisAtivosDaConta: async () => { throw new Error('column perfis_operacionais does not exist'); } },
    );
    assert.equal(r.id, CONTA_A);
    assert.equal(r.selecaoNonce, null);
  });

  test("frontend antigo (perfilId ausente, sem prova) + 1 perfil -> funciona", async () => {
    const r = await resolverPerfilParaContexto(
      { contaId: CONTA_A },
      { buscarPerfisAtivosDaConta: async () => [{ id: FULANA_1, nome: "F1", ativo: true, conta_id: CONTA_A, pin_hash: "s1:h" }] },
    );
    assert.equal(r.id, FULANA_1); // 1 perfil: PIN existe mas NÃO é exigido
  });
});
