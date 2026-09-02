// Testes das decisões puras da tela de integração iFood — unit, sem DOM.
// Rodar: node --test frontend/test/ifood.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  derivarEstadoIntegracao, prepararSelecaoMerchant, contadorExpiracao,
  precisaConfirmarTrocaMerchant, textoConfirmacaoTroca, mensagemErroAutorizacao, avisoDesconexao,
} from "../src/ifoodEstado.js";

const app = (conectado, status = conectado ? "ativa" : null) => ({ conectado, status, expiraEm: null });
const status = ({ a = app(false), f = app(false), merchant = null, s = "nao_conectado" } = {}) => ({
  conectado: !!merchant && f.conectado,
  status: s,
  merchant,
  apps: { analytics: a, financial: f },
  conectadaEm: merchant ? "2026-08-28T12:00:00Z" : null,
});
const MERCHANT = { id: "550e8400-e29b-41d4-a716-446655440000", idMascarado: "550e****0000", nome: "Subway Saci", razaoSocial: "Saci LTDA" };

describe("derivarEstadoIntegracao — matriz de conexão dos apps", () => {
  test("nenhum app conectado -> Não conectado", () => {
    const e = derivarEstadoIntegracao(status());
    assert.equal(e.chave, "nao_conectado");
    assert.equal(e.rotulo, "Não conectado");
    assert.equal(e.apps.analytics.conectado, false);
    assert.equal(e.apps.financial.conectado, false);
    assert.equal(e.podeDesconectar, false);
    assert.equal(e.podeConectarAnalytics, true);
    assert.equal(e.podeConectarFinancial, true);
  });

  test("null / status ausente -> Não conectado (nunca lança)", () => {
    assert.equal(derivarEstadoIntegracao(null).chave, "nao_conectado");
    assert.equal(derivarEstadoIntegracao(undefined).chave, "nao_conectado");
    assert.equal(derivarEstadoIntegracao({}).chave, "nao_conectado");
  });

  test("só analytics conectado -> Parcialmente conectado", () => {
    const e = derivarEstadoIntegracao(status({ a: app(true), s: "pendente" }));
    assert.equal(e.chave, "parcial");
    assert.equal(e.rotulo, "Parcialmente conectado");
    assert.equal(e.apps.analytics.rotulo, "Conectado");
    assert.equal(e.apps.financial.rotulo, "Não conectado");
    assert.equal(e.podeConectarAnalytics, false);
    assert.equal(e.podeConectarFinancial, true);
    assert.equal(e.podeDesconectar, true);
  });

  test("só financial conectado, com merchant, SEM analytics -> Parcialmente conectado", () => {
    const e = derivarEstadoIntegracao(status({ f: app(true), merchant: MERCHANT, s: "ativa" }));
    assert.equal(e.chave, "parcial");
    assert.equal(e.apps.financial.conectado, true);
    assert.equal(e.merchant.idMascarado, "550e****0000");
  });

  test("só financial conectado SEM merchant -> Parcialmente conectado", () => {
    const e = derivarEstadoIntegracao(status({ f: app(true), s: "pendente" }));
    assert.equal(e.chave, "parcial");
    assert.equal(e.merchant, null);
  });

  test("ambos conectados + merchant -> Conectado", () => {
    const e = derivarEstadoIntegracao(status({ a: app(true), f: app(true), merchant: MERCHANT, s: "ativa" }));
    assert.equal(e.chave, "conectado");
    assert.equal(e.rotulo, "Conectado");
    assert.equal(e.apps.analytics.conectado, true);
    assert.equal(e.apps.financial.conectado, true);
    assert.equal(e.podeConectarAnalytics, false);
    assert.equal(e.podeConectarFinancial, false);
    assert.equal(e.podeDesconectar, true);
  });

  test("reauth_required em qualquer app -> Reconexão necessária", () => {
    const e = derivarEstadoIntegracao(status({ a: app(true), f: { conectado: false, status: "reauth_required" }, merchant: MERCHANT, s: "reauth_required" }));
    assert.equal(e.chave, "reauth");
    assert.equal(e.rotulo, "Reconexão necessária");
    assert.equal(e.precisaReconectar, true);
    assert.equal(e.apps.financial.rotulo, "Reconexão necessária");
    assert.equal(e.podeConectarFinancial, true, "reauth reabre a possibilidade de reconectar");
  });
});

describe("prepararSelecaoMerchant", () => {
  test("0 merchants -> modo 'vazio' com mensagem amigável", () => {
    const r = prepararSelecaoMerchant([]);
    assert.equal(r.modo, "vazio");
    assert.equal(r.merchants.length, 0);
    assert.match(r.mensagem, /nenhuma loja/i);
  });
  test("lista nula/indefinida -> 'vazio' (nunca lança)", () => {
    assert.equal(prepararSelecaoMerchant(null).modo, "vazio");
    assert.equal(prepararSelecaoMerchant(undefined).modo, "vazio");
  });
  test("1 merchant -> modo 'unico', ainda pede confirmação", () => {
    const r = prepararSelecaoMerchant([MERCHANT]);
    assert.equal(r.modo, "unico");
    assert.equal(r.merchants.length, 1);
    assert.match(r.mensagem, /confirme/i);
  });
  test("múltiplos merchants -> modo 'lista'", () => {
    const r = prepararSelecaoMerchant([MERCHANT, { ...MERCHANT, id: "b", idMascarado: "b***b" }, { ...MERCHANT, id: "c", idMascarado: "c***c" }]);
    assert.equal(r.modo, "lista");
    assert.equal(r.merchants.length, 3);
  });
  test("itens sem id são descartados", () => {
    const r = prepararSelecaoMerchant([MERCHANT, { nome: "sem id" }, null]);
    assert.equal(r.modo, "unico");
  });
});

describe("contadorExpiracao (10 min)", () => {
  const base = Date.parse("2026-08-28T12:00:00Z");
  test("faltando ~9:43 -> não expirado, rótulo mm:ss", () => {
    const r = contadorExpiracao(new Date(base + 583_000).toISOString(), base);
    assert.equal(r.expirado, false);
    assert.equal(r.rotulo, "09:43");
  });
  test("prazo no passado -> expirado", () => {
    const r = contadorExpiracao(new Date(base - 1000).toISOString(), base);
    assert.equal(r.expirado, true);
    assert.equal(r.rotulo, "expirado");
    assert.equal(r.restanteMs, 0);
  });
  test("exatamente no limite -> expirado", () => {
    assert.equal(contadorExpiracao(new Date(base).toISOString(), base).expirado, true);
  });
  test("data inválida -> expirado, rótulo '—'", () => {
    const r = contadorExpiracao("não é data", base);
    assert.equal(r.expirado, true);
    assert.equal(r.rotulo, "—");
  });
});

describe("precisaConfirmarTrocaMerchant", () => {
  test("nenhum merchant vinculado -> sem confirmação", () => {
    assert.equal(precisaConfirmarTrocaMerchant(status(), MERCHANT), false);
    assert.equal(precisaConfirmarTrocaMerchant(null, MERCHANT), false);
  });
  test("mesmo merchant (idempotente) -> sem confirmação", () => {
    const st = status({ f: app(true), merchant: MERCHANT, s: "ativa" });
    assert.equal(precisaConfirmarTrocaMerchant(st, MERCHANT), false);
  });
  test("merchant diferente -> exige confirmação", () => {
    const st = status({ f: app(true), merchant: MERCHANT, s: "ativa" });
    const outro = { id: "999", idMascarado: "9999****9999", nome: "Subway Centro" };
    assert.equal(precisaConfirmarTrocaMerchant(st, outro), true);
    assert.match(textoConfirmacaoTroca(st, outro), /substituir/i);
    assert.match(textoConfirmacaoTroca(st, outro), /Subway Saci/);
    assert.match(textoConfirmacaoTroca(st, outro), /Subway Centro/);
  });
});

describe("mensagemErroAutorizacao", () => {
  test("código expirado -> orienta a gerar outro", () => {
    assert.match(mensagemErroAutorizacao({ codigo: "IFOOD_OAUTH_SESSAO_EXPIRADA" }), /expirou/i);
  });
  test("authorizationCode inválido -> orienta a conferir/gerar novo", () => {
    assert.match(mensagemErroAutorizacao({ codigo: "IFOOD_OAUTH_CODIGO_INVALIDO" }), /código de autorização/i);
  });
  test("erro genérico -> usa a mensagem do backend", () => {
    assert.equal(mensagemErroAutorizacao({ message: "Falha X" }), "Falha X");
  });
  test("sem nada -> mensagem padrão, nunca undefined", () => {
    assert.match(mensagemErroAutorizacao({}), /autoriza/i);
  });
});

describe("avisoDesconexao", () => {
  test("explica que a remoção local não revoga no iFood e orienta o Portal do Parceiro", () => {
    const t = avisoDesconexao();
    assert.match(t, /apenas aqui/i);
    assert.match(t, /não revoga/i);
    assert.match(t, /Portal do Parceiro/i);
  });
});
