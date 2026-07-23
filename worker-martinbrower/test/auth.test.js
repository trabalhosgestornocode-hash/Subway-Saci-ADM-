// Testes do HMAC. Sem rede, sem Chromium, sem Martin Brower.
import test from "node:test";
import assert from "node:assert/strict";
import { assinar, montarMensagem, exigirHmac, _resetarNonces, JANELA_MS } from "../src/auth.middleware.js";

const SEGREDO = "segredo-de-teste-com-mais-de-32-caracteres-aqui";
const OUTRO_SEGREDO = "outro-segredo-de-teste-com-mais-de-32-caract";

// Simula o par (req, res) do Express sem subir servidor.
function requisicaoFalsa({ metodo = "POST", caminho = "/internal/martin-brower/sessions",
  corpo = '{"a":1}', timestamp, nonce, assinatura } = {}) {
  const headers = {
    "x-mb-timestamp": timestamp, "x-mb-nonce": nonce, "x-mb-signature": assinatura,
  };
  return {
    method: metodo, originalUrl: caminho, body: Buffer.from(corpo, "utf8"),
    get: (h) => headers[h.toLowerCase()],
  };
}

function respostaFalsa() {
  const r = { statusCode: null, corpo: null };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (j) => { r.corpo = j; return r; };
  return r;
}

// Executa o middleware e diz se passou.
function executar(req) {
  const res = respostaFalsa();
  let passou = false;
  exigirHmac(SEGREDO)(req, res, () => { passou = true; });
  return { passou, status: res.statusCode, corpo: res.corpo, req };
}

function assinada(over = {}) {
  const timestamp = String(over.timestamp ?? Date.now());
  // >= 16 caracteres: é o mínimo que o middleware aceita.
  const nonce = over.nonce ?? `nonce${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
  const metodo = over.metodo ?? "POST";
  const caminho = over.caminho ?? "/internal/martin-brower/sessions";
  const corpo = over.corpo ?? '{"a":1}';
  const assinatura = assinar({ segredo: over.segredo ?? SEGREDO, timestamp, nonce, metodo, caminho, corpo });
  return requisicaoFalsa({ metodo, caminho, corpo, timestamp, nonce, assinatura });
}

test.beforeEach(() => _resetarNonces());

test("assinatura válida é aceita e o corpo é parseado", () => {
  const r = executar(assinada());
  assert.equal(r.passou, true);
  assert.deepEqual(r.req.corpoJson, { a: 1 });
});

test("worker recusa subir sem segredo", () => {
  assert.throws(() => exigirHmac(undefined), /MB_WORKER_SECRET ausente/);
  assert.throws(() => exigirHmac(""), /MB_WORKER_SECRET ausente/);
});

test("cabeçalho ausente é rejeitado", () => {
  for (const faltando of ["x-mb-timestamp", "x-mb-nonce", "x-mb-signature"]) {
    const req = assinada();
    const original = req.get;
    req.get = (h) => (h.toLowerCase() === faltando ? undefined : original(h));
    const r = executar(req);
    assert.equal(r.passou, false, `deveria rejeitar sem ${faltando}`);
    assert.equal(r.status, 401);
  }
});

test("assinatura inválida é rejeitada", () => {
  const req = assinada();
  const original = req.get;
  req.get = (h) => (h.toLowerCase() === "x-mb-signature" ? "a".repeat(64) : original(h));
  const r = executar(req);
  assert.equal(r.passou, false);
  assert.equal(r.status, 401);
});

test("assinatura feita com OUTRO segredo é rejeitada", () => {
  const r = executar(assinada({ segredo: OUTRO_SEGREDO }));
  assert.equal(r.passou, false);
  assert.equal(r.status, 401);
});

test("timestamp expirado é rejeitado (janela de 60s)", () => {
  const r = executar(assinada({ timestamp: Date.now() - JANELA_MS - 5_000 }));
  assert.equal(r.passou, false);
  assert.equal(r.status, 401);
});

test("timestamp muito no FUTURO também é rejeitado", () => {
  const r = executar(assinada({ timestamp: Date.now() + JANELA_MS + 5_000 }));
  assert.equal(r.passou, false);
});

test("timestamp dentro da janela é aceito nos dois sentidos", () => {
  assert.equal(executar(assinada({ timestamp: Date.now() - 30_000 })).passou, true);
  assert.equal(executar(assinada({ timestamp: Date.now() + 30_000 })).passou, true);
});

test("REPLAY: o mesmo nonce não passa duas vezes", () => {
  const req = assinada({ nonce: "nonceFixoDeTeste123" });
  assert.equal(executar(req).passou, true, "a primeira vez deve passar");

  // Reenvia a requisição IDÊNTICA — assinatura válida, mas nonce já usado.
  const replay = assinada({ nonce: "nonceFixoDeTeste123" });
  const r = executar(replay);
  assert.equal(r.passou, false, "REPLAY ACEITO — nonce nao esta sendo consumido");
  assert.equal(r.status, 401);
});

test("nonce só é consumido se a assinatura conferir", () => {
  // Um atacante não pode queimar nonces legítimos mandando lixo assinado errado.
  const nonce = "nonceQueDeveSobreviver";
  const req = assinada({ nonce });
  const original = req.get;
  req.get = (h) => (h.toLowerCase() === "x-mb-signature" ? "b".repeat(64) : original(h));
  assert.equal(executar(req).passou, false);

  // O mesmo nonce continua utilizável por quem assina corretamente.
  assert.equal(executar(assinada({ nonce })).passou, true, "nonce legitimo foi queimado indevidamente");
});

test("CORPO ALTERADO em trânsito invalida a assinatura", () => {
  const timestamp = String(Date.now());
  const nonce = "nonceCorpoAlterado01";
  const caminho = "/internal/martin-brower/sessions";
  const assinatura = assinar({ segredo: SEGREDO, timestamp, nonce, metodo: "POST", caminho, corpo: '{"senha":"original"}' });
  // Alguém troca a senha no meio do caminho, mantendo a assinatura.
  const req = requisicaoFalsa({ caminho, corpo: '{"senha":"trocada"}', timestamp, nonce, assinatura });
  assert.equal(executar(req).passou, false, "corpo adulterado passou pela verificacao");
});

test("PATH ou QUERY alterados invalidam a assinatura", () => {
  const timestamp = String(Date.now());
  const nonce = "noncePathAlterado001";
  const corpo = "{}";
  const assinatura = assinar({
    segredo: SEGREDO, timestamp, nonce, metodo: "POST",
    caminho: "/internal/martin-brower/sessions/AAA/collect", corpo,
  });
  // Redirecionar a chamada para OUTRA sessão tem que quebrar.
  const req = requisicaoFalsa({
    caminho: "/internal/martin-brower/sessions/BBB/collect", corpo, timestamp, nonce, assinatura,
  });
  assert.equal(executar(req).passou, false, "path adulterado passou pela verificacao");
});

test("MÉTODO alterado invalida a assinatura", () => {
  const timestamp = String(Date.now());
  const nonce = "nonceMetodoAlterado1";
  const caminho = "/internal/martin-brower/sessions/AAA";
  const corpo = "";
  const assinatura = assinar({ segredo: SEGREDO, timestamp, nonce, metodo: "GET", caminho, corpo });
  const req = requisicaoFalsa({ metodo: "DELETE", caminho, corpo, timestamp, nonce, assinatura });
  assert.equal(executar(req).passou, false);
});

test("nonce e timestamp malformados são rejeitados sem calcular HMAC", () => {
  assert.equal(executar(requisicaoFalsa({ timestamp: "abc", nonce: "n".repeat(20), assinatura: "x".repeat(64) })).passou, false);
  assert.equal(executar(requisicaoFalsa({ timestamp: String(Date.now()), nonce: "curto", assinatura: "x".repeat(64) })).passou, false);
  assert.equal(executar(requisicaoFalsa({ timestamp: String(Date.now()), nonce: "com espaço aqui!!", assinatura: "x".repeat(64) })).passou, false);
});

test("corpo que não é JSON válido é recusado com 400", () => {
  const r = executar(assinada({ corpo: "{isso nao e json" }));
  assert.equal(r.passou, false);
  assert.equal(r.status, 400);
});

test("mensagem canônica inclui todos os componentes assinados", () => {
  const msg = montarMensagem({ timestamp: "123", nonce: "abc", metodo: "post", caminho: "/x?y=1", corpo: "{}" });
  const linhas = msg.split("\n");
  assert.equal(linhas.length, 5);
  assert.equal(linhas[0], "123");
  assert.equal(linhas[1], "abc");
  assert.equal(linhas[2], "POST", "o metodo deve ser normalizado para maiusculas");
  assert.equal(linhas[3], "/x?y=1", "o caminho deve incluir a query string");
  assert.match(linhas[4], /^[0-9a-f]{64}$/, "o corpo entra como sha256 hex");
});

test("corpo vazio e corpo ausente produzem o mesmo hash", () => {
  const a = montarMensagem({ timestamp: "1", nonce: "n", metodo: "GET", caminho: "/x", corpo: "" });
  const b = montarMensagem({ timestamp: "1", nonce: "n", metodo: "GET", caminho: "/x", corpo: undefined });
  assert.equal(a, b);
});
