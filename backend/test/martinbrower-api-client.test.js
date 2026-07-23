// Testes do cliente da API com transporte FALSO. Nenhuma chamada real à
// Martin Brower — nem aqui, nem no CI.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getCurrentOrder, loadItems } from "../src/modules/martinbrower/martinbrower.api.client.js";
import { descobrirPedidoAtual } from "../src/modules/martinbrower/martinbrower.order.service.js";
import { MB_ERROS } from "../src/modules/martinbrower/martinbrower.errors.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const PEDIDO = JSON.parse(readFileSync(join(aqui, "fixtures/martinbrower/prox-pedido.json"), "utf8"));
const CATALOGO = JSON.parse(readFileSync(join(aqui, "fixtures/martinbrower/load-itens.json"), "utf8"));

// Transporte falso: registra as URLs chamadas e devolve o que for programado.
function sessaoFalsa(respostas) {
  if (!Array.isArray(respostas) || respostas.length === 0) {
    throw new Error("sessaoFalsa: informe ao menos uma resposta programada.");
  }
  const chamadas = [];
  const fila = [...respostas];
  // A ÚLTIMA resposta programada é repetida indefinidamente — é o que permite
  // testar retry com uma linha só (ex.: [{status:503}] cobre as 3 tentativas).
  let ultima = respostas.at(-1);

  return {
    chamadas,
    async fetch(url, opts) {
      chamadas.push({ url, headers: opts?.headers });

      // `fila.shift() ?? fila.at(-1)` devolvia undefined quando a fila
      // esvaziava (at(-1) de array vazio é undefined), e o teste morria com
      // "Cannot read properties of undefined (reading 'erroRede')" — um erro
      // que não diz nada sobre a causa. Guardamos a última resposta à parte.
      if (fila.length) ultima = fila.shift();
      const r = ultima;

      if (r.erroRede) throw new Error("ECONNRESET");
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: (h) => (h.toLowerCase() === "content-type" ? (r.contentType ?? "application/json") : null) },
        text: async () => (typeof r.corpo === "string" ? r.corpo : JSON.stringify(r.corpo ?? {})),
      };
    },
  };
}

const okJson = (corpo) => ({ status: 200, corpo });

test("getCurrentOrder monta a URL confirmada do findProxPedidoV2", async () => {
  const s = sessaoFalsa([okJson(PEDIDO)]);
  const r = await getCurrentOrder("4532", s);
  assert.equal(r.data.orderId, 612694);
  assert.equal(s.chamadas[0].url,
    "https://portal.martinbrower.com.br/mbbr/portal-api/order/findProxPedidoV2?clientId=4532");
});

test("loadItens usa size=1000 e o orderId recebido — nunca um valor fixo", async () => {
  const s = sessaoFalsa([okJson(CATALOGO)]);
  await loadItems("4532", "612694", s);
  assert.equal(s.chamadas[0].url,
    "https://portal.martinbrower.com.br/mbbr/portal-api/order/loadItens?size=1000&orderId=612694&clientId=4532");
});

test("401 vira SESSION_EXPIRED e NÃO é repetido", async () => {
  const s = sessaoFalsa([{ status: 401 }]);
  await assert.rejects(() => getCurrentOrder("4532", s), (e) => {
    assert.equal(e.codigo, MB_ERROS.MARTIN_BROWER_SESSION_EXPIRED);
    return true;
  });
  assert.equal(s.chamadas.length, 1, "401 não pode gerar retry");
});

test("403 vira ACCESS_DENIED e NÃO é repetido", async () => {
  const s = sessaoFalsa([{ status: 403 }]);
  await assert.rejects(() => getCurrentOrder("4532", s), (e) => e.codigo === MB_ERROS.MARTIN_BROWER_ACCESS_DENIED);
  assert.equal(s.chamadas.length, 1);
});

test("429 vira RATE_LIMITED e NÃO é repetido", async () => {
  const s = sessaoFalsa([{ status: 429 }]);
  await assert.rejects(() => getCurrentOrder("4532", s), (e) => e.codigo === MB_ERROS.MARTIN_BROWER_RATE_LIMITED);
  assert.equal(s.chamadas.length, 1);
});

test("5xx é transitório: tenta de novo e sobe UNAVAILABLE ao esgotar", async () => {
  const s = sessaoFalsa([{ status: 503 }]);
  await assert.rejects(() => getCurrentOrder("4532", s), (e) => e.codigo === MB_ERROS.MARTIN_BROWER_UNAVAILABLE);
  assert.equal(s.chamadas.length, 3, "deveria usar as 3 tentativas");
});

test("5xx seguido de sucesso se recupera", async () => {
  const s = sessaoFalsa([{ status: 500 }, okJson(PEDIDO)]);
  const r = await getCurrentOrder("4532", s);
  assert.equal(r.data.orderId, 612694);
  assert.equal(s.chamadas.length, 2);
});

test("content-type não-JSON é tratado como sessão expirada (redirect p/ login)", async () => {
  const s = sessaoFalsa([{ status: 200, contentType: "text/html", corpo: "<html>login</html>" }]);
  await assert.rejects(() => getCurrentOrder("4532", s), (e) => e.codigo === MB_ERROS.MARTIN_BROWER_SESSION_EXPIRED);
});

test("JSON inválido vira CATALOG_INVALID", async () => {
  const s = sessaoFalsa([{ status: 200, corpo: "{isso nao e json" }]);
  await assert.rejects(() => loadItems("4532", "1", s), (e) => e.codigo === MB_ERROS.MARTIN_BROWER_CATALOG_INVALID);
});

test("falha de rede é repetida e vira UNAVAILABLE", async () => {
  const s = sessaoFalsa([{ erroRede: true }]);
  await assert.rejects(() => getCurrentOrder("4532", s), (e) => e.codigo === MB_ERROS.MARTIN_BROWER_UNAVAILABLE);
  assert.equal(s.chamadas.length, 3);
});

test("cancelamento externo interrompe a chamada", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const s = sessaoFalsa([{ erroRede: true }]);
  await assert.rejects(() => getCurrentOrder("4532", s, { sinal: ctrl.signal }),
    (e) => e.codigo === MB_ERROS.MARTIN_BROWER_SYNC_CANCELLED);
});

test("nenhum header Authorization ou Cookie é enviado pelo cliente", async () => {
  // A sessão autenticada carrega os cookies; o cliente não monta credencial.
  const s = sessaoFalsa([okJson(PEDIDO)]);
  await getCurrentOrder("4532", s);
  const h = s.chamadas[0].headers ?? {};
  assert.deepEqual(Object.keys(h), ["Accept"]);
});

// --- descoberta de pedido -------------------------------------------------

test("descobrirPedidoAtual extrai o orderId da resposta real", async () => {
  const s = sessaoFalsa([okJson(PEDIDO)]);
  const p = await descobrirPedidoAtual({ clientId: "4532", sessao: s });
  assert.equal(p.orderId, 612694);
  assert.match(p.janelaInicio, /^2026-07-25T/);
});

test("ausência de orderId vira ORDER_NOT_FOUND", async () => {
  const s = sessaoFalsa([okJson({ data: { orderId: null }, errors: [] })]);
  await assert.rejects(() => descobrirPedidoAtual({ clientId: "4532", sessao: s }),
    (e) => e.codigo === MB_ERROS.MARTIN_BROWER_ORDER_NOT_FOUND);
});

test("sem orderId E com restrição financeira, a restrição é o erro reportado", async () => {
  const s = sessaoFalsa([okJson({ data: { orderId: null, financialRestriction: "Título em aberto" }, errors: [] })]);
  await assert.rejects(() => descobrirPedidoAtual({ clientId: "4532", sessao: s }), (e) => {
    assert.equal(e.codigo, MB_ERROS.MARTIN_BROWER_FINANCIAL_RESTRICTION);
    assert.equal(e.details.restricao, "Título em aberto");
    return true;
  });
});

test("restrição financeira COM pedido disponível não bloqueia — só é registrada", async () => {
  const s = sessaoFalsa([okJson({ data: { orderId: 999, financialRestriction: "Aviso de limite" }, errors: [] })]);
  const p = await descobrirPedidoAtual({ clientId: "4532", sessao: s });
  assert.equal(p.orderId, 999);
  assert.equal(p.financialRestriction, "Aviso de limite");
});
