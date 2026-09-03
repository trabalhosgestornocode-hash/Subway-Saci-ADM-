// Testes da camada de rate limiting (shared/rateLimit.js).
//
// O que protegem: o limite tem de (a) barrar rajada acima do teto, (b) liberar
// quando a janela desliza, (c) ISOLAR contas/IPs entre si (o limite de um não
// come o do outro), (d) NUNCA bloquear quando não há chave confiável
// (requireAuth é quem barra anônimo — o limite não pode ser a única porta),
// (e) responder 429 genérico com Retry-After.
//
// Não toca banco nem env — importa só rateLimit.js (que depende só de ApiError).
// Rodar: node --test test/rate-limit.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import { limiteDeTaxa, combinar, ipCliente, _resetarLimites } from "../src/shared/rateLimit.js";

/** Simula uma passagem por um middleware Express. Devolve o erro (ou null) e o header Retry-After. */
function passar(mw, req) {
  let erro = null;
  const res = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
  };
  mw(req, res, (e) => { erro = e ?? null; });
  return { erro, retryAfter: res.headers["Retry-After"] ?? null };
}

const reqConta = (id) => ({ user: { id }, ip: "10.0.0.1", socket: {} });

test("bloqueia a partir da (max+1)-ésima requisição na janela", () => {
  _resetarLimites();
  const mw = limiteDeTaxa({ escopo: "t1", max: 3, janelaMs: 60_000 });
  const req = reqConta("conta-A");
  assert.equal(passar(mw, req).erro, null, "1ª passa");
  assert.equal(passar(mw, req).erro, null, "2ª passa");
  assert.equal(passar(mw, req).erro, null, "3ª passa");
  const r = passar(mw, req);
  assert.ok(r.erro, "4ª bloqueia");
  assert.equal(r.erro.statusCode, 429);
  assert.equal(r.erro.details?.codigo, "RATE_LIMITED"); // convenção do projeto: codigo dentro de details
  assert.ok(Number(r.retryAfter) > 0, "manda Retry-After em segundos");
  // mensagem NÃO revela nada sobre a conta/perfil
  assert.doesNotMatch(r.erro.message, /conta|perfil|usu[aá]rio|existe/i);
});

test("a janela deslizante libera quando os timestamps envelhecem", () => {
  _resetarLimites();
  let agora = 1_000_000;
  const _dateNow = Date.now;
  Date.now = () => agora;
  try {
    const mw = limiteDeTaxa({ escopo: "t2", max: 2, janelaMs: 10_000 });
    const req = reqConta("conta-B");
    assert.equal(passar(mw, req).erro, null);
    assert.equal(passar(mw, req).erro, null);
    assert.ok(passar(mw, req).erro, "3ª dentro da janela bloqueia");
    agora += 10_001; // passa a janela inteira
    assert.equal(passar(mw, req).erro, null, "depois da janela, libera");
  } finally {
    Date.now = _dateNow;
  }
});

test("contas diferentes têm orçamentos independentes", () => {
  _resetarLimites();
  const mw = limiteDeTaxa({ escopo: "t3", max: 2, janelaMs: 60_000 });
  const a = reqConta("conta-X");
  const b = reqConta("conta-Y");
  passar(mw, a); passar(mw, a);
  assert.ok(passar(mw, a).erro, "conta X estourou");
  assert.equal(passar(mw, b).erro, null, "conta Y não foi afetada");
});

test("sem chave confiável (usuário ausente) NÃO bloqueia — requireAuth é a porta", () => {
  _resetarLimites();
  const mw = limiteDeTaxa({ escopo: "t4", max: 1, janelaMs: 60_000 });
  const anon = { user: undefined, ip: "1.2.3.4", socket: {} };
  for (let i = 0; i < 20; i++) assert.equal(passar(mw, anon).erro, null);
});

test("limite por IP: mesma origem, contas diferentes -> compartilham orçamento", () => {
  _resetarLimites();
  const mw = limiteDeTaxa({ escopo: "t5", max: 3, janelaMs: 60_000, chave: ipCliente });
  const mkReq = (conta) => ({ user: { id: conta }, ip: "203.0.113.9", socket: {} });
  assert.equal(passar(mw, mkReq("c1")).erro, null);
  assert.equal(passar(mw, mkReq("c2")).erro, null);
  assert.equal(passar(mw, mkReq("c3")).erro, null);
  assert.ok(passar(mw, mkReq("c4")).erro, "4ª tentativa da MESMA origem bloqueia, mesmo trocando de conta");
});

test("combinar(): o limite mais apertado vence e nenhum é pulado", () => {
  _resetarLimites();
  const mw = combinar(
    limiteDeTaxa({ escopo: "c-conta", max: 5, janelaMs: 60_000 }),          // por conta
    limiteDeTaxa({ escopo: "c-ip", max: 2, janelaMs: 60_000, chave: ipCliente }), // por IP (mais apertado)
  );
  const req = reqConta("conta-Z");
  assert.equal(passar(mw, req).erro, null);
  assert.equal(passar(mw, req).erro, null);
  const r = passar(mw, req);
  assert.ok(r.erro, "3ª bloqueia pelo limite de IP mesmo com orçamento de conta sobrando");
  assert.equal(r.erro.statusCode, 429);
});

test("ipCliente prefere req.ip (que respeita trust proxy) e cai pra socket", () => {
  assert.equal(ipCliente({ ip: "9.9.9.9", socket: { remoteAddress: "1.1.1.1" } }), "9.9.9.9");
  assert.equal(ipCliente({ ip: undefined, socket: { remoteAddress: "1.1.1.1" } }), "1.1.1.1");
  assert.equal(ipCliente({ socket: {} }), null);
});

test("config: parâmetros obrigatórios são validados", () => {
  assert.throws(() => limiteDeTaxa({ escopo: "x", max: 0, janelaMs: 1000 }));
  assert.throws(() => limiteDeTaxa({ escopo: "", max: 1, janelaMs: 1000 }));
  assert.throws(() => limiteDeTaxa({ escopo: "x", max: 1, janelaMs: 0 }));
});
