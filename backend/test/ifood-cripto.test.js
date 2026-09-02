// Testes do helper de criptografia em repouso (shared/cripto.js).
// Não depende de Supabase nem de config/env.js — só do process.env.

import test from "node:test";
import assert from "node:assert/strict";

process.env.IFOOD_TOKEN_SECRET = process.env.IFOOD_TOKEN_SECRET || "teste-secret-fixo-para-cripto-1234567890";

const { cifrar, decifrar, mascarar, _resetarChaveCache } = await import("../src/shared/cripto.js");

test("cifrar -> decifrar devolve o texto original", () => {
  const original = "AT-abc123.def456.ghi789";
  const cifrado = cifrar(original);
  assert.notEqual(cifrado, original);
  assert.match(cifrado, /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.equal(decifrar(cifrado), original);
});

test("cada cifragem usa IV novo (dois textos iguais -> saídas diferentes)", () => {
  const a = cifrar("mesmo-token");
  const b = cifrar("mesmo-token");
  assert.notEqual(a, b, "IV aleatório deveria produzir ciphertexts distintos");
  assert.equal(decifrar(a), "mesmo-token");
  assert.equal(decifrar(b), "mesmo-token");
});

test("null / undefined / '' passam como null nos dois sentidos", () => {
  assert.equal(cifrar(null), null);
  assert.equal(cifrar(undefined), null);
  assert.equal(cifrar(""), null);
  assert.equal(decifrar(null), null);
  assert.equal(decifrar(""), null);
});

test("adulteração do ciphertext faz decifrar lançar (authTag GCM)", () => {
  const cifrado = cifrar("token-sensivel");
  const partes = cifrado.split(":");
  // Vira o último caractere do ciphertext.
  const ct = partes[3];
  partes[3] = ct.slice(0, -1) + (ct.at(-1) === "A" ? "B" : "A");
  assert.throws(() => decifrar(partes.join(":")));
});

test("formato inválido / versão desconhecida é rejeitado", () => {
  assert.throws(() => decifrar("v2:aaa:bbb:ccc"));
  assert.throws(() => decifrar("nao-tem-o-formato"));
  assert.throws(() => decifrar("v1:só:duas"));
});

test("secret diferente não decifra o que o outro cifrou", () => {
  const cifrado = cifrar("segredo");
  _resetarChaveCache();
  process.env.IFOOD_TOKEN_SECRET = "outro-secret-completamente-diferente-000";
  assert.throws(() => decifrar(cifrado));
  // restaura para não afetar outros testes do arquivo
  _resetarChaveCache();
  process.env.IFOOD_TOKEN_SECRET = "teste-secret-fixo-para-cripto-1234567890";
});

test("mascarar mostra só início e fim", () => {
  assert.equal(mascarar("550e8400-e29b-41d4-a716-446655440000"), "550e****0000");
  assert.equal(mascarar("curto"), "****");
  assert.equal(mascarar(""), null);
  assert.equal(mascarar(null), null);
});
