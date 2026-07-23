// Testes do adapter HTTP para o worker remoto.
// Servidor FALSO local — nenhuma chamada real ao Cloud Run nem à Martin Brower.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac, createHash } from "node:crypto";

const SEGREDO = "segredo-de-teste-com-mais-de-32-caracteres!!";

// Servidor que VERIFICA a assinatura como o worker real faria, e responde o
// que o teste programar.
let servidor, baseUrl;
const recebidas = [];
let proximaResposta = { status: 200, corpo: {} };

function conferirAssinatura(req, corpo) {
  const ts = req.headers["x-mb-timestamp"];
  const nonce = req.headers["x-mb-nonce"];
  const sig = req.headers["x-mb-signature"];
  if (!ts || !nonce || !sig) return { ok: false, motivo: "cabecalho ausente" };

  const hashCorpo = createHash("sha256").update(corpo ?? "").digest("hex");
  const mensagem = [ts, nonce, req.method.toUpperCase(), req.url, hashCorpo].join("\n");
  const esperada = createHmac("sha256", SEGREDO).update(mensagem).digest("hex");
  return { ok: sig === esperada, motivo: "assinatura divergente", esperada, recebida: sig };
}

before(async () => {
  servidor = createServer((req, res) => {
    let corpo = "";
    req.on("data", (c) => { corpo += c; });
    req.on("end", () => {
      const verif = conferirAssinatura(req, corpo);
      recebidas.push({
        metodo: req.method, url: req.url, corpo, headers: req.headers, assinaturaOk: verif.ok,
      });
      if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"ok":true}'); }
      if (!verif.ok) { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"error":"unauthorized"}'); }
      res.writeHead(proximaResposta.status, { "content-type": "application/json" });
      res.end(JSON.stringify(proximaResposta.corpo));
    });
  });
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;

  process.env.MB_WORKER_URL = baseUrl;
  process.env.MB_WORKER_SECRET = SEGREDO;
  process.env.MB_WORKER_SKIP_OIDC = "true";   // fora do GCP, sem metadata server
});

after(() => servidor?.close());

const tenant = { organizacaoId: "org-1", unidadeId: "uni-1", usuarioId: "user-1" };
const carregar = () => import("../src/modules/martinbrower/martinbrower.remote.worker.js");

test.beforeEach(() => { recebidas.length = 0; proximaResposta = { status: 200, corpo: {} }; });

test("iniciar assina a requisição corretamente e devolve precisa2fa", async () => {
  const { remoteWorker } = await carregar();
  proximaResposta = { status: 201, corpo: { remoteSessionId: "sess-remota-1", precisa2fa: true, status: "aguardando_codigo" } };

  const r = await remoteWorker.iniciar({
    clientId: "4532", credenciais: { usuario: "loja", senha: "SenhaSecreta" }, tenant,
  });

  assert.equal(r.precisa2fa, true);
  assert.equal(r.remoteSessionId, "sess-remota-1");

  const req = recebidas.at(-1);
  assert.equal(req.assinaturaOk, true, "o worker real recusaria esta assinatura");
  assert.equal(req.url, "/internal/martin-brower/sessions");
  // O tenant vai no corpo — é o que amarra a sessão remota ao dono.
  const corpo = JSON.parse(req.corpo);
  assert.equal(corpo.organizationId, "org-1");
  assert.equal(corpo.unidadeId, "uni-1");
  assert.equal(corpo.userId, "user-1");
  // STRING, sempre: o adapter não pode "numerizar" o identificador no caminho.
  assert.equal(corpo.clientId, "4532");
  assert.equal(typeof corpo.clientId, "string");
});

test("os cabeçalhos HMAC vão completos e no formato esperado", async () => {
  const { remoteWorker } = await carregar();
  proximaResposta = { status: 201, corpo: { remoteSessionId: "s", precisa2fa: false } };
  await remoteWorker.iniciar({ clientId: "1", credenciais: { usuario: "u", senha: "p" }, tenant });

  const h = recebidas.at(-1).headers;
  assert.match(h["x-mb-timestamp"], /^\d{13}$/);
  assert.match(h["x-mb-nonce"], /^[A-Za-z0-9_-]{16,64}$/);
  assert.match(h["x-mb-signature"], /^[0-9a-f]{64}$/);
});

test("cada chamada usa um nonce NOVO — nunca reaproveita", async () => {
  const { remoteWorker } = await carregar();
  proximaResposta = { status: 201, corpo: { remoteSessionId: "s", precisa2fa: false } };
  for (let i = 0; i < 5; i += 1) {
    await remoteWorker.iniciar({ clientId: "1", credenciais: { usuario: "u", senha: "p" }, tenant });
  }
  const nonces = new Set(recebidas.map((r) => r.headers["x-mb-nonce"]));
  assert.equal(nonces.size, 5, "nonce repetido — o worker rejeitaria como replay");
});

test("a senha NÃO aparece em nenhum cabeçalho", async () => {
  const { remoteWorker } = await carregar();
  proximaResposta = { status: 201, corpo: { remoteSessionId: "s", precisa2fa: false } };
  await remoteWorker.iniciar({ clientId: "1", credenciais: { usuario: "loja", senha: "SenhaUltraSecreta" }, tenant });

  const h = JSON.stringify(recebidas.at(-1).headers);
  assert.ok(!h.includes("SenhaUltraSecreta"), "a senha vazou para um cabecalho");
});

test("coletar devolve os payloads CRUS e valida a forma do catálogo", async () => {
  const { remoteWorker } = await carregar();
  const catalogo = { data: { groups: [{ group: "G", itens: [] }] } };
  proximaResposta = { status: 200, corpo: { pedido: { data: { orderId: 612694 } }, catalogo } };

  const r = await remoteWorker.coletar({ remoteSessionId: "sess-1", tenant });
  assert.equal(r.pedido.data.orderId, 612694);
  assert.deepEqual(r.catalogo, catalogo);
  assert.equal(recebidas.at(-1).url, "/internal/martin-brower/sessions/sess-1/collect");
});

test("coletar recusa catálogo sem data.groups", async () => {
  const { remoteWorker } = await carregar();
  proximaResposta = { status: 200, corpo: { pedido: {}, catalogo: { data: {} } } };
  await assert.rejects(() => remoteWorker.coletar({ remoteSessionId: "s", tenant }),
    (e) => e.codigo === "MARTIN_BROWER_CATALOG_INVALID");
});

test("o adapter NUNCA envia orderId — ele é descoberto dentro do worker", async () => {
  const { remoteWorker } = await carregar();
  proximaResposta = { status: 200, corpo: { pedido: { data: { orderId: 1 } }, catalogo: { data: { groups: [] } } } };
  await remoteWorker.coletar({ remoteSessionId: "s", tenant });
  assert.ok(!recebidas.at(-1).corpo.includes("orderId"), "orderId nao pode partir do backend");
});

test("código do worker é repassado sem tradução", async () => {
  const { remoteWorker } = await carregar();
  for (const [codigo, status] of [
    ["MARTIN_BROWER_2FA_INVALID", 400],
    ["MARTIN_BROWER_AUTH_FAILED", 401],
    ["MARTIN_BROWER_MANUAL_VERIFICATION_REQUIRED", 423],
    ["MARTIN_BROWER_ORDER_NOT_FOUND", 404],
  ]) {
    proximaResposta = { status, corpo: { error: codigo } };
    await assert.rejects(() => remoteWorker.coletar({ remoteSessionId: "s", tenant }),
      (e) => e.codigo === codigo, `codigo ${codigo} nao foi repassado`);
  }
});

test("410 do worker vira REMOTE_SESSION_LOST", async () => {
  const { remoteWorker } = await carregar();
  proximaResposta = { status: 410, corpo: {} };
  await assert.rejects(() => remoteWorker.coletar({ remoteSessionId: "s", tenant }),
    (e) => e.codigo === "MARTIN_BROWER_REMOTE_SESSION_LOST");
});

test("401/403 SEM código = falha de autenticação NOSSA, não do portal", async () => {
  const { remoteWorker } = await carregar();
  // Não pode virar AUTH_FAILED: isso mandaria o usuário conferir a senha do
  // portal quando o problema é a configuração do HMAC/IAM.
  proximaResposta = { status: 403, corpo: {} };
  await assert.rejects(() => remoteWorker.coletar({ remoteSessionId: "s", tenant }),
    (e) => e.codigo === "MARTIN_BROWER_WORKER_UNREACHABLE");
});

test("worker inalcançável vira WORKER_UNREACHABLE", async () => {
  const { remoteWorker } = await carregar();
  const urlBoa = process.env.MB_WORKER_URL;
  process.env.MB_WORKER_URL = "http://127.0.0.1:1";   // porta sem ninguém
  try {
    await assert.rejects(() => remoteWorker.coletar({ remoteSessionId: "s", tenant }),
      (e) => e.codigo === "MARTIN_BROWER_WORKER_UNREACHABLE");
  } finally {
    process.env.MB_WORKER_URL = urlBoa;
  }
});

test("sem MB_WORKER_URL ou MB_WORKER_SECRET, o adapter recusa chamar", async () => {
  const { remoteWorker } = await carregar();
  const url = process.env.MB_WORKER_URL;
  process.env.MB_WORKER_URL = "";
  try {
    await assert.rejects(() => remoteWorker.coletar({ remoteSessionId: "s", tenant }),
      (e) => e.codigo === "MARTIN_BROWER_WORKER_DISABLED");
  } finally {
    process.env.MB_WORKER_URL = url;
  }
});

test("cancelamento externo interrompe a chamada", async () => {
  const { remoteWorker } = await carregar();
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    () => remoteWorker.coletar({ remoteSessionId: "s", tenant, sinal: ctrl.signal }),
    (e) => e.codigo === "MARTIN_BROWER_SYNC_CANCELLED");
});

test("encerrar é idempotente e NUNCA lança — roda em finally", async () => {
  const { remoteWorker } = await carregar();
  proximaResposta = { status: 500, corpo: { error: "boom" } };
  await remoteWorker.encerrar({ remoteSessionId: "s", tenant });      // erro do worker
  await remoteWorker.encerrar({ remoteSessionId: null, tenant });      // sem sessão
  const url = process.env.MB_WORKER_URL;
  process.env.MB_WORKER_URL = "http://127.0.0.1:1";
  await remoteWorker.encerrar({ remoteSessionId: "s", tenant });       // worker fora do ar
  process.env.MB_WORKER_URL = url;
  assert.ok(true, "nenhuma dessas chamadas pode lancar");
});

test("status monta a query com o tenant", async () => {
  const { remoteWorker } = await carregar();
  proximaResposta = { status: 200, corpo: { status: "autenticado" } };
  await remoteWorker.status({ remoteSessionId: "sess-9", tenant });
  const url = recebidas.at(-1).url;
  assert.match(url, /^\/internal\/martin-brower\/sessions\/sess-9\/status\?/);
  assert.match(url, /organizationId=org-1/);
  assert.match(url, /unidadeId=uni-1/);
  assert.match(url, /userId=user-1/);
});

test("a assinatura cobre a query string — trocar a sessão invalida", async () => {
  const { _assinar } = await carregar();
  const comum = { segredo: SEGREDO, timestamp: "1700000000000", nonce: "nonceDeTeste123456", metodo: "POST", corpo: "{}" };
  const a = _assinar({ ...comum, caminho: "/internal/martin-brower/sessions/AAA/collect" });
  const b = _assinar({ ...comum, caminho: "/internal/martin-brower/sessions/BBB/collect" });
  assert.notEqual(a, b, "redirecionar a chamada para outra sessao deveria quebrar a assinatura");
});

test("a assinatura cobre o corpo — trocar a senha invalida", async () => {
  const { _assinar } = await carregar();
  const comum = { segredo: SEGREDO, timestamp: "1700000000000", nonce: "nonceDeTeste123456", metodo: "POST", caminho: "/x" };
  const a = _assinar({ ...comum, corpo: '{"senha":"original"}' });
  const b = _assinar({ ...comum, corpo: '{"senha":"trocada"}' });
  assert.notEqual(a, b);
});
