// Testes das sessões efêmeras. Sem Chromium — os recursos do Playwright são
// substituídos por dublês que registram se `close()` foi chamado.
import test from "node:test";
import assert from "node:assert/strict";
import * as s from "../src/sessions.js";
import { CODIGOS } from "../src/errors.js";

const ORG = "org-1", UNI = "uni-1", USER = "user-1";
const base = { organizationId: ORG, unidadeId: UNI, userId: USER, clientId: 4532 };

const credenciais = () => ({ usuario: "loja.saci", senha: "SenhaSecreta123" });

// Dublê que registra o fechamento — prova que o cleanup roda de verdade.
function recursosFalsos(sessao) {
  const fechados = [];
  sessao.page = { close: async () => fechados.push("page") };
  sessao.browserContext = { close: async () => fechados.push("context") };
  sessao.browser = { close: async () => fechados.push("browser") };
  return fechados;
}

test.beforeEach(() => s._resetar());

test("cria sessão com os campos exigidos e status inicial", () => {
  const sessao = s.criarSessao({ ...base, credenciais: credenciais() });
  for (const campo of ["remoteSessionId", "organizationId", "unidadeId", "userId", "clientId",
    "status", "createdAt", "lastActivityAt", "expiresAt", "tentativasLogin", "tentativas2FA", "abortController"]) {
    assert.ok(campo in sessao, `campo ausente: ${campo}`);
  }
  assert.equal(sessao.status, s.STATUS.INICIANDO);
  assert.ok(sessao.remoteSessionId.length >= 30, "id precisa ser longo e aleatório");
});

test("remoteSessionId é aleatório — nunca sequencial", async () => {
  const ids = new Set();
  for (let i = 0; i < 30; i += 1) {
    const sessao = s.criarSessao({ ...base, unidadeId: `uni-${i}`, credenciais: credenciais() });
    ids.add(sessao.remoteSessionId);
    // Encerra antes da próxima: o teto de sessões simultâneas é 1.
    await s.encerrar(sessao.remoteSessionId);
  }
  assert.equal(ids.size, 30);
});

test("uma sincronização por unidade — a segunda é recusada", () => {
  s.criarSessao({ ...base, credenciais: credenciais() });
  assert.throws(() => s.criarSessao({ ...base, credenciais: credenciais() }),
    (e) => e.codigo === CODIGOS.CONFLITO);
});

test("teto de sessões simultâneas é respeitado (concurrency=1)", () => {
  s.criarSessao({ ...base, credenciais: credenciais() });
  // Outra unidade, mas o teto global do container é 1.
  assert.throws(() => s.criarSessao({ ...base, unidadeId: "uni-2", credenciais: credenciais() }),
    (e) => e.codigo === CODIGOS.CONFLITO);
});

test("sessão só responde ao tenant e usuário que a criaram", () => {
  const sessao = s.criarSessao({ ...base, credenciais: credenciais() });
  const id = sessao.remoteSessionId;

  assert.ok(s.obterSessao(id, base), "o dono deveria alcançar a sessão");
  for (const intruso of [
    { ...base, organizationId: "org-2" },
    { ...base, unidadeId: "uni-9" },
    { ...base, userId: "user-9" },
  ]) {
    assert.throws(() => s.obterSessao(id, intruso), (e) => e.codigo === CODIGOS.SESSAO_PERDIDA);
  }
});

test("sessão inexistente vira SESSAO_PERDIDA (instância reciclada)", () => {
  assert.throws(() => s.obterSessao("id-que-nunca-existiu", base),
    (e) => e.codigo === CODIGOS.SESSAO_PERDIDA);
});

test("a senha é descartada assim que o formulário é preenchido", () => {
  const sessao = s.criarSessao({ ...base, credenciais: credenciais() });
  assert.equal(sessao._credenciais.senha, "SenhaSecreta123");
  s.descartarSenha(sessao);
  assert.equal(sessao._credenciais, null, "credenciais deveriam ter sido apagadas");
});

test("encerrar apaga senha e código 2FA e fecha os recursos na ordem certa", async () => {
  const sessao = s.criarSessao({ ...base, credenciais: credenciais() });
  const fechados = recursosFalsos(sessao);
  s.informarCodigo2fa(sessao, "482913");

  await s.encerrar(sessao.remoteSessionId, s.STATUS.CONCLUIDA);

  assert.deepEqual(fechados, ["page", "context", "browser"], "ordem de fechamento incorreta");
  assert.equal(sessao._credenciais, null);
  assert.equal(sessao._codigo2fa, null);
  assert.equal(sessao.abortController.signal.aborted, true);
  assert.equal(s.sessoesAtivas(), 0);
});

test("encerrar é IDEMPOTENTE", async () => {
  const sessao = s.criarSessao({ ...base, credenciais: credenciais() });
  recursosFalsos(sessao);
  await s.encerrar(sessao.remoteSessionId);
  await s.encerrar(sessao.remoteSessionId);   // não pode lançar
  await s.encerrar("id-inexistente");
  assert.equal(s.sessoesAtivas(), 0);
});

test("falha ao fechar um recurso não impede o encerramento dos demais", async () => {
  const sessao = s.criarSessao({ ...base, credenciais: credenciais() });
  const fechados = [];
  sessao.page = { close: async () => { throw new Error("page travada"); } };
  sessao.browserContext = { close: async () => fechados.push("context") };
  sessao.browser = { close: async () => fechados.push("browser") };

  await s.encerrar(sessao.remoteSessionId);
  assert.deepEqual(fechados, ["context", "browser"], "os demais recursos deveriam fechar mesmo assim");
  assert.equal(s.sessoesAtivas(), 0);
});

test("TTL total expirado torna a sessão inalcançável", () => {
  const sessao = s.criarSessao({ ...base, credenciais: credenciais() });
  sessao.expiresAt = Date.now() - 1;
  assert.throws(() => s.obterSessao(sessao.remoteSessionId, base),
    (e) => e.codigo === CODIGOS.SESSAO_EXPIRADA);
});

test("inatividade expira a sessão", () => {
  const sessao = s.criarSessao({ ...base, credenciais: credenciais() });
  sessao.lastActivityAt = Date.now() - s.TTL_INATIVIDADE_MS - 1000;
  assert.throws(() => s.obterSessao(sessao.remoteSessionId, base),
    (e) => e.codigo === CODIGOS.SESSAO_EXPIRADA);
});

test("aguardando 2FA usa o TTL maior — o humano tem tempo de ler o e-mail", () => {
  const sessao = s.criarSessao({ ...base, credenciais: credenciais() });
  s.atualizar(sessao, { status: s.STATUS.AGUARDANDO_CODIGO });
  // Tempo que expiraria por inatividade comum, mas não durante o 2FA.
  sessao.lastActivityAt = Date.now() - s.TTL_INATIVIDADE_MS - 1000;
  assert.ok(s.obterSessao(sessao.remoteSessionId, base), "não deveria expirar durante a espera do 2FA");

  sessao.lastActivityAt = Date.now() - s.TTL_AGUARDANDO_2FA_MS - 1000;
  assert.throws(() => s.obterSessao(sessao.remoteSessionId, base),
    (e) => e.codigo === CODIGOS.SESSAO_EXPIRADA, "deveria expirar após o TTL de 2FA");
});

test("tentativas de login são limitadas", () => {
  const sessao = s.criarSessao({ ...base, credenciais: credenciais() });
  for (let i = 0; i < s.MAX_TENTATIVAS_LOGIN; i += 1) s.registrarTentativaLogin(sessao);
  assert.throws(() => s.registrarTentativaLogin(sessao), (e) => e.codigo === CODIGOS.AUTH_FAILED);
});

test("tentativas de 2FA são limitadas", () => {
  const sessao = s.criarSessao({ ...base, credenciais: credenciais() });
  for (let i = 0; i < s.MAX_TENTATIVAS_2FA; i += 1) s.informarCodigo2fa(sessao, "1234");
  assert.throws(() => s.informarCodigo2fa(sessao, "1234"), (e) => e.codigo === CODIGOS.DOIS_FA_INVALIDO);
});

test("paraBackend NUNCA expõe credencial, código, browser ou page", () => {
  const sessao = s.criarSessao({ ...base, credenciais: credenciais() });
  recursosFalsos(sessao);
  s.informarCodigo2fa(sessao, "482913");

  const projecao = s.paraBackend(sessao);
  const json = JSON.stringify(projecao);
  for (const proibido of ["SenhaSecreta123", "loja.saci", "482913", "browser", "page", "_credenciais"]) {
    assert.ok(!json.includes(proibido), `vazou na projeção: ${proibido}`);
  }
  assert.deepEqual(Object.keys(projecao).sort(),
    ["aguardandoCodigo", "etapa", "expiresAt", "remoteSessionId", "status", "tentativas2FA", "tentativasLogin"]);
});

test("encerrarTodas destrói tudo — usado em SIGTERM", async () => {
  const sessao = s.criarSessao({ ...base, credenciais: credenciais() });
  const fechados = recursosFalsos(sessao);
  await s.encerrarTodas("SIGTERM");
  assert.equal(s.sessoesAtivas(), 0);
  assert.deepEqual(fechados, ["page", "context", "browser"]);
});

test("cancelar aborta o sinal — a coleta em andamento para", async () => {
  const sessao = s.criarSessao({ ...base, credenciais: credenciais() });
  recursosFalsos(sessao);
  const sinal = sessao.abortController.signal;
  assert.equal(sinal.aborted, false);
  await s.encerrar(sessao.remoteSessionId, s.STATUS.CANCELADA);
  assert.equal(sinal.aborted, true);
});
