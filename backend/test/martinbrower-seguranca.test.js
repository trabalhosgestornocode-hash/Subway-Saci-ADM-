// Testes de SEGURANÇA da integração: sanitização de logs, ciclo de vida das
// credenciais efêmeras, isolamento de sessão e controle de concorrência.
import test from "node:test";
import assert from "node:assert/strict";

import { sanitizar, mascararClientId } from "../src/modules/martinbrower/martinbrower.logsafe.js";
import * as sessions from "../src/modules/martinbrower/martinbrower.sessions.js";
import { MB_STATUS } from "../src/modules/martinbrower/martinbrower.constants.js";
import { MB_ERROS } from "../src/modules/martinbrower/martinbrower.errors.js";
import * as v from "../src/modules/martinbrower/martinbrower.validators.js";

const ORG = "11111111-1111-1111-1111-111111111111";
const UNI = "aaaaaaaa-1111-1111-1111-111111111111";
const USER = "99999999-9999-9999-9999-999999999999";
const JWT_FALSO = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcDEF-_123456789";

// --- sanitização ----------------------------------------------------------

test("senha, token, cookie e código 2FA nunca sobrevivem à sanitização", () => {
  const entrada = {
    usuario: "loja.saci",
    senha: "SenhaSuperSecreta123",
    password: "outra",
    authorization: `Bearer ${JWT_FALSO}`,
    cookie: "JSESSIONID=abc123; path=/",
    codigo2fa: "482913",
    accessToken: JWT_FALSO,
    refresh_token: "rt_xyz",
    apiKey: "sk-live-123",
  };
  const saida = JSON.stringify(sanitizar(entrada));

  for (const segredo of ["SenhaSuperSecreta123", "outra", "abc123", "482913", "rt_xyz", "sk-live-123", JWT_FALSO]) {
    assert.ok(!saida.includes(segredo), `vazou: ${segredo}`);
  }
  assert.ok(saida.includes("loja.saci"), "dado não sensível deve ser preservado");
});

test("JWT solto no meio de uma string é mascarado", () => {
  const s = sanitizar(`falha ao chamar api com token ${JWT_FALSO} no header`);
  assert.ok(!s.includes(JWT_FALSO));
  assert.ok(s.includes("[REDACTED]"));
});

test("Bearer e cookies de sessão em texto livre são mascarados", () => {
  assert.ok(!sanitizar("Authorization: Bearer abc.def.ghi").includes("abc.def.ghi"));
  assert.ok(!sanitizar("Set-Cookie: JSESSIONID=segredo123; HttpOnly").includes("segredo123"));
});

test("sanitização é recursiva e não muta a entrada", () => {
  const original = { nivel1: { nivel2: { senha: "x1", ok: "visivel" } } };
  const saida = sanitizar(original);
  assert.equal(saida.nivel1.nivel2.senha, "[REDACTED]");
  assert.equal(saida.nivel1.nivel2.ok, "visivel");
  assert.equal(original.nivel1.nivel2.senha, "x1", "a entrada não pode ser mutada");
});

test("variações de grafia da chave sensível também são pegas", () => {
  for (const chave of ["Senha", "SENHA", "access_token", "accessToken", "set-cookie", "Codigo2FA", "credenciais"]) {
    const s = sanitizar({ [chave]: "segredo" });
    assert.equal(s[chave], "[REDACTED]", `chave "${chave}" não foi mascarada`);
  }
});

test("Error é sanitizado sem carregar stack nem credencial", () => {
  const e = new Error(`login falhou com senha SenhaX e token ${JWT_FALSO}`);
  const s = sanitizar(e);
  assert.ok(!JSON.stringify(s).includes(JWT_FALSO));
  assert.equal(s.stack, undefined);
});

test("clientId é mascarado na exibição", () => {
  assert.equal(mascararClientId(4532), "••32");
  assert.equal(mascararClientId(7), "••");
  assert.equal(mascararClientId(null), null);
});

// --- ciclo de vida das credenciais ---------------------------------------

test("paraCliente NUNCA expõe credencial, código 2FA ou controle interno", () => {
  sessions._resetarEstado();
  const s = sessions.criarSessao({
    organizacaoId: ORG, unidadeId: UNI, clientId: "4532", usuarioId: USER,
    credenciais: { usuario: "loja", senha: "SenhaSecreta" },
  });
  sessions.informarCodigo2fa(s, "482913");

  const projecao = sessions.paraCliente(s);
  const json = JSON.stringify(projecao);
  assert.ok(!json.includes("SenhaSecreta"));
  assert.ok(!json.includes("482913"));
  assert.ok(!json.includes("_credenciais"));
  // Só o que o frontend precisa:
  assert.deepEqual(Object.keys(projecao).sort(),
    ["aguardandoCodigo", "erro", "etapa", "expiraEm", "resultado", "sessionId", "status"]);
});

test("finalizar a sessão apaga credenciais e código 2FA da memória", () => {
  sessions._resetarEstado();
  const s = sessions.criarSessao({
    organizacaoId: ORG, unidadeId: UNI, clientId: "4532", usuarioId: USER,
    credenciais: { usuario: "loja", senha: "SenhaSecreta" },
  });
  sessions.informarCodigo2fa(s, "482913");
  assert.equal(s._credenciais.senha, "SenhaSecreta");

  sessions.finalizarSessao(s.sessionId, MB_STATUS.CONCLUIDO);

  assert.equal(s._credenciais, null, "credenciais devem ser descartadas");
  assert.equal(s._codigo2fa, null, "código 2FA deve ser descartado");
});

test("cancelar aborta o sinal e descarta os segredos", () => {
  sessions._resetarEstado();
  const s = sessions.criarSessao({
    organizacaoId: ORG, unidadeId: UNI, clientId: "4532", usuarioId: USER,
    credenciais: { usuario: "loja", senha: "SenhaSecreta" },
  });
  sessions.cancelarSessao(s);
  assert.equal(s._controle.signal.aborted, true);
  assert.equal(s.status, MB_STATUS.CANCELADO);
  assert.equal(s._credenciais, null);
});

test("sessionId é aleatório e longo — não sequencial, não adivinhável", () => {
  sessions._resetarEstado();
  const ids = new Set();
  for (let i = 0; i < 50; i += 1) {
    const s = sessions.criarSessao({ organizacaoId: ORG, unidadeId: UNI, clientId: "4532", usuarioId: USER });
    assert.ok(s.sessionId.length >= 30);
    ids.add(s.sessionId);
  }
  assert.equal(ids.size, 50, "nenhum sessionId pode se repetir");
});

// --- isolamento da sessão -------------------------------------------------

test("outro usuário não alcança a sessão, mesmo com o sessionId correto", () => {
  sessions._resetarEstado();
  const s = sessions.criarSessao({ organizacaoId: ORG, unidadeId: UNI, clientId: "4532", usuarioId: USER });

  assert.ok(sessions.obterSessao({ sessionId: s.sessionId, usuarioId: USER, organizacaoId: ORG, unidadeId: UNI }));
  assert.equal(sessions.obterSessao({ sessionId: s.sessionId, usuarioId: "outro-user", organizacaoId: ORG, unidadeId: UNI }), null);
  assert.equal(sessions.obterSessao({ sessionId: s.sessionId, usuarioId: USER, organizacaoId: "outra-org", unidadeId: UNI }), null);
  assert.equal(sessions.obterSessao({ sessionId: s.sessionId, usuarioId: USER, organizacaoId: ORG, unidadeId: "outra-uni" }), null);
});

test("sessão expirada não é mais alcançável", () => {
  sessions._resetarEstado();
  const s = sessions.criarSessao({ organizacaoId: ORG, unidadeId: UNI, clientId: "4532", usuarioId: USER });
  s.expiraEm = Date.now() - 1;
  assert.equal(sessions.obterSessao({ sessionId: s.sessionId, usuarioId: USER, organizacaoId: ORG, unidadeId: UNI }), null);
});

test("tentativas de login e de 2FA são limitadas", () => {
  sessions._resetarEstado();
  const s = sessions.criarSessao({ organizacaoId: ORG, unidadeId: UNI, clientId: "4532", usuarioId: USER });
  for (let i = 0; i < 3; i += 1) sessions.registrarTentativaLogin(s);
  assert.throws(() => sessions.registrarTentativaLogin(s), (e) => e.codigo === MB_ERROS.MARTIN_BROWER_AUTH_FAILED);

  const s2 = sessions.criarSessao({ organizacaoId: ORG, unidadeId: UNI, clientId: "4532", usuarioId: USER });
  for (let i = 0; i < 3; i += 1) sessions.informarCodigo2fa(s2, "1234");
  assert.throws(() => sessions.informarCodigo2fa(s2, "1234"), (e) => e.codigo === MB_ERROS.MARTIN_BROWER_2FA_INVALID);
});

// --- concorrência ---------------------------------------------------------

test("duas sincronizações simultâneas na mesma loja são bloqueadas", () => {
  sessions._resetarEstado();
  const alvo = { organizacaoId: ORG, unidadeId: UNI, clientId: "4532" };
  sessions.adquirirLock({ ...alvo, sessionId: "s1" });
  assert.throws(() => sessions.adquirirLock({ ...alvo, sessionId: "s2" }),
    (e) => e.codigo === MB_ERROS.MARTIN_BROWER_SYNC_CONFLICT);
});

test("o lock é por organização + unidade + clientId — lojas diferentes não se bloqueiam", () => {
  sessions._resetarEstado();
  sessions.adquirirLock({ organizacaoId: ORG, unidadeId: UNI, clientId: "4532", sessionId: "s1" });
  // Outra unidade da MESMA organização: livre.
  sessions.adquirirLock({ organizacaoId: ORG, unidadeId: "outra-unidade", clientId: "9999", sessionId: "s2" });
  // Outra organização: livre.
  sessions.adquirirLock({ organizacaoId: "outra-org", unidadeId: UNI, clientId: "4532", sessionId: "s3" });
  assert.ok(true);
});

test("liberar o lock permite uma nova sincronização", () => {
  sessions._resetarEstado();
  const alvo = { organizacaoId: ORG, unidadeId: UNI, clientId: "4532" };
  const chave = sessions.adquirirLock({ ...alvo, sessionId: "s1" });
  sessions.liberarLock(chave, "s1");
  assert.doesNotThrow(() => sessions.adquirirLock({ ...alvo, sessionId: "s2" }));
});

test("só o dono libera o lock — cancelamento tardio não derruba sync nova", () => {
  sessions._resetarEstado();
  const alvo = { organizacaoId: ORG, unidadeId: UNI, clientId: "4532" };
  const chave = sessions.adquirirLock({ ...alvo, sessionId: "s1" });
  sessions.liberarLock(chave, "s-intruso");
  assert.ok(sessions.lockAtivo(alvo), "o lock não podia ter sido liberado por outra sessão");
});

test("lock expirado libera sozinho — processo morto não trava a loja", () => {
  sessions._resetarEstado();
  const alvo = { organizacaoId: ORG, unidadeId: UNI, clientId: "4532" };
  sessions.adquirirLock({ ...alvo, sessionId: "s1" });
  assert.equal(sessions.lockAtivo(alvo).expiraEm > Date.now(), true);
  // Simula o TTL vencido (Render hibernou e o processo morreu).
  sessions.lockAtivo(alvo).expiraEm = Date.now() - 1;
  assert.equal(sessions.lockAtivo(alvo), null);
  assert.doesNotThrow(() => sessions.adquirirLock({ ...alvo, sessionId: "s2" }));
});

// --- validadores ----------------------------------------------------------

test("clientId inválido é recusado antes de virar query string externa", () => {
  for (const ruim of ["abc", "4532; DROP TABLE", -1, 0, 1.5, null, "", "4532 OR 1=1",
    "45 32", "4532.0", "-4532", "0", "000", "1".repeat(33), undefined, {}, []]) {
    assert.throws(() => v.validarClientId(ruim), `deveria recusar: ${JSON.stringify(ruim)}`);
  }
});

// --- clientId como IDENTIFICADOR (migration 019) --------------------------

test("clientId é devolvido como STRING, nunca como número", () => {
  const r = v.validarClientId("4532");
  assert.equal(typeof r, "string", "converter para Number destruiria zeros à esquerda");
  assert.equal(r, "4532");
});

test("ZEROS À ESQUERDA são preservados exatamente", () => {
  // O ponto central da migration 019: "04532" não pode virar 4532.
  assert.equal(v.validarClientId("04532"), "04532");
  assert.equal(v.validarClientId("000123"), "000123");
  assert.equal(v.validarClientId("0000000001"), "0000000001");
});

test("valores longos não perdem precisão", () => {
  // Acima de Number.MAX_SAFE_INTEGER (9007199254740991), Number() arredondaria.
  const longo = "90071992547409911234";
  assert.equal(v.validarClientId(longo), longo);
  assert.notEqual(String(Number(longo)), longo, "confirma que Number() ARREDONDARIA este valor");
});

test("espaço nas bordas é aparado, mas o identificador não muda", () => {
  // Colar do portal costuma trazer espaço; aparar não altera o identificador.
  assert.equal(v.validarClientId("  04532  "), "04532");
  assert.equal(v.validarClientId("\n4532\t"), "4532");
});

test("aceita número na entrada, mas SEMPRE devolve string", () => {
  // Compatibilidade com chamadas antigas e com o que o banco devolvia.
  assert.equal(v.validarClientId(4532), "4532");
  assert.equal(typeof v.validarClientId(4532), "string");
});

test("mesmoClientId compara como identificador — '04532' ≠ '4532'", () => {
  assert.equal(v.mesmoClientId("04532", "04532"), true);
  assert.equal(v.mesmoClientId("4532", 4532), true, "string e número com mesmo dígito são o mesmo id");
  assert.equal(v.mesmoClientId("04532", "4532"), false, "zero à esquerda faz diferença");
  assert.equal(v.mesmoClientId(null, "4532"), false);
  assert.equal(v.mesmoClientId("4532", undefined), false);
  assert.equal(v.mesmoClientId(null, null), false, "ausência não é igualdade");
});

test("código 2FA fora do formato é recusado", () => {
  for (const ruim of ["", "12", "a".repeat(20), "12 34", "<script>"]) {
    assert.throws(() => v.validarCodigo2fa({ codigo: ruim }));
  }
  assert.equal(v.validarCodigo2fa({ codigo: "482913" }), "482913");
});

test("erro de validação de credencial nunca ecoa a senha", () => {
  try {
    v.validarCredenciais({ usuario: "", senha: "MinhaSenhaSecreta" });
    assert.fail("deveria ter lançado");
  } catch (e) {
    assert.ok(!e.message.includes("MinhaSenhaSecreta"));
    assert.ok(!JSON.stringify(e.details ?? {}).includes("MinhaSenhaSecreta"));
  }
});

test("payload de catálogo sem data.groups é recusado", () => {
  assert.throws(() => v.validarPayloadCatalogo({ payload: { data: {} } }),
    (e) => e.codigo === MB_ERROS.MARTIN_BROWER_CATALOG_INVALID);
  assert.throws(() => v.validarPayloadCatalogo({ payload: "nada" }));
  assert.ok(v.validarPayloadCatalogo({ payload: { data: { groups: [] } } }));
});

// --- sanitização do termo de busca (filtro PostgREST) --------------------
// O termo vai para .or("codigo.ilike.%X%,descricao.ilike.%X%"), onde vírgula,
// ponto e parênteses são SINTAXE. Sem sanitizar, o termo digitado poderia
// acrescentar condições à consulta.

test("termo de busca não consegue injetar sintaxe do PostgREST", () => {
  const ataques = [
    "bacon,organizacao_id.neq.00000000-0000-0000-0000-000000000000",
    "x,ignorado.eq.true",
    "a.b.c",
    "(x,y)",
    'aspas"duplas',
    "*curinga*",
    "a:b",
  ];
  for (const ataque of ataques) {
    const limpo = String(v.sanitizarTermoBusca(ataque) ?? "");
    for (const proibido of [",", ".", "(", ")", '"', "*", ":"]) {
      assert.ok(!limpo.includes(proibido), `"${proibido}" sobreviveu em: ${ataque} -> ${limpo}`);
    }
  }
});

test("termo de busca legítimo é preservado, inclusive com acento", () => {
  assert.equal(v.sanitizarTermoBusca("BACON TIRAS"), "BACON TIRAS");
  assert.equal(v.sanitizarTermoBusca("  pão   integral "), "pão integral");
  assert.equal(v.sanitizarTermoBusca("1001088"), "1001088");
  assert.equal(v.sanitizarTermoBusca("CX 4 PCT X 1 KG"), "CX 4 PCT X 1 KG");
  assert.equal(v.sanitizarTermoBusca(""), null);
  assert.equal(v.sanitizarTermoBusca(null), null);
  assert.equal(v.sanitizarTermoBusca("!!!"), null, "termo só com pontuação vira nulo, não filtro vazio");
});
