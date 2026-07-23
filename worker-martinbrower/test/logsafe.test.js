// Sanitização de logs do worker: precisa mascarar segredo SEM esconder
// diagnóstico. Os dois erros custam caro — um vaza, o outro cega.
import test from "node:test";
import assert from "node:assert/strict";
import { sanitizar, mascararClientId, prefixoAssinatura } from "../src/logsafe.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcDEF-_123456789";

test("mascara todo segredo conhecido", () => {
  const entrada = {
    senha: "SenhaSecreta123",
    password: "outra",
    codigo: "482913",                 // este É o código 2FA
    codigo2fa: "482913",
    authorization: `Bearer ${JWT}`,
    cookie: "JSESSIONID=abc123",
    accessToken: JWT,
    refresh_token: "rt_xyz",
    apiKey: "sk-live-1",
    signature: "assinatura-inteira-nao-pode-vazar",
    "x-mb-signature": "idem",
  };
  const saida = JSON.stringify(sanitizar(entrada));
  for (const segredo of ["SenhaSecreta123", "outra", "482913", "abc123", "rt_xyz",
    "sk-live-1", "assinatura-inteira-nao-pode-vazar", JWT]) {
    assert.ok(!saida.includes(segredo), `vazou: ${segredo}`);
  }
});

test("NÃO mascara o código do ERRO — é diagnóstico, não segredo", () => {
  // Regressão: "codigo" como substring redigia `codigoErro`, escondendo a
  // única informação útil da linha de log.
  const s = sanitizar({ codigoErro: "MARTIN_BROWER_AUTH_FAILED", rota: "/sessions" });
  assert.equal(s.codigoErro, "MARTIN_BROWER_AUTH_FAILED");
  assert.equal(s.rota, "/sessions");
});

test("chave ambígua só é mascarada em match EXATO", () => {
  assert.equal(sanitizar({ codigo: "482913" }).codigo, "[REDACTED]", "codigo puro é o 2FA");
  assert.equal(sanitizar({ codigoErro: "X" }).codigoErro, "X");
  assert.equal(sanitizar({ codigoInterno: "2664329" }).codigoInterno, "2664329");
  assert.equal(sanitizar({ codigoProduto: "1001088" }).codigoProduto, "1001088");
  assert.equal(sanitizar({ statusCode: 401 }).statusCode, 401);
});

test("chave inequívoca é mascarada mesmo composta", () => {
  for (const chave of ["accessToken", "refresh_token", "setCookie", "authorizationHeader",
    "userPassword", "codigo2fa", "xMbSignature"]) {
    assert.equal(sanitizar({ [chave]: "segredo" })[chave], "[REDACTED]", `nao mascarou: ${chave}`);
  }
});

test("dados estruturais do log sobrevivem intactos", () => {
  // Tudo que o primeiro teste real precisa observar.
  const linha = sanitizar({
    evento: "coleta.concluida", etapa: "Carregando catálogo", seletor: "campoUsuario",
    fallback: 1, duracaoMs: 1320, status: 200, grupos: 4, produtos: 312,
    rssMb: 480, heapUsadoMb: 62, remoteSessionId: "ZAtuPz3uZM6hsBn3",
  });
  assert.equal(linha.etapa, "Carregando catálogo");
  assert.equal(linha.seletor, "campoUsuario");
  assert.equal(linha.duracaoMs, 1320);
  assert.equal(linha.status, 200);
  assert.equal(linha.produtos, 312);
  assert.equal(linha.rssMb, 480);
  assert.equal(linha.remoteSessionId, "ZAtuPz3uZM6hsBn3");
});

test("JWT, Bearer e cookie soltos em texto livre são mascarados", () => {
  assert.ok(!sanitizar(`falha com token ${JWT}`).includes(JWT));
  assert.ok(!sanitizar("Authorization: Bearer abc.def.ghi").includes("abc.def.ghi"));
  assert.ok(!sanitizar("Set-Cookie: JSESSIONID=segredo1; HttpOnly").includes("segredo1"));
});

test("Error vira objeto seguro, sem stack", () => {
  const e = new Error(`login falhou com token ${JWT}`);
  const s = sanitizar(e);
  assert.ok(!JSON.stringify(s).includes(JWT));
  assert.equal(s.stack, undefined);
});

test("não muta a entrada", () => {
  const original = { nivel: { senha: "x" } };
  sanitizar(original);
  assert.equal(original.nivel.senha, "x");
});

test("assinatura no log é só o prefixo", () => {
  const p = prefixoAssinatura("a".repeat(64));
  assert.equal(p, "aaaaaaaa…");
  assert.ok(p.length < 12, "prefixo curto demais para reconstruir a assinatura");
});

test("clientId é mascarado", () => {
  assert.equal(mascararClientId(4532), "••32");
  assert.equal(mascararClientId(null), null);
});
