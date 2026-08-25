// Testes de produtosCmvBusca.js — escolha de produto por nome, pura, sem
// I/O. O que protege: nunca escolher silenciosamente entre produtos
// plausíveis (ex.: "cookie" com 3 cookies cadastrados) e tolerar pequenos
// erros de grafia sem virar correspondência irresponsável.
//
// Rodar: node --test test/agente-produtos-cmv-busca.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { escolherCandidato } from "../src/modules/agente/tools/produtosCmvBusca.js";

const BMT_15 = { id: "1", nome: "BMT 15cm" };
const BMT_30 = { id: "2", nome: "BMT 30cm" };
const FRANGO_TERIYAKI = { id: "3", nome: "Frango Teriyaki 15cm" };
const COOKIE_CHOC = { id: "4", nome: "Cookie Chocolate" };
const COOKIE_AVEIA = { id: "5", nome: "Cookie Aveia" };
const FANTA_UVA = { id: "6", nome: "Fanta Uva" };

describe("escolherCandidato — casos exatos e naturais", () => {
  test("nome exato (ignorando caixa) resolve sem ambiguidade", () => {
    const r = escolherCandidato([FRANGO_TERIYAKI, FANTA_UVA], "frango teriyaki 15cm");
    assert.equal(r.status, "unico");
    assert.equal(r.produto.id, FRANGO_TERIYAKI.id);
  });

  test("nome com pontuação (b.m.t.) casa com o produto sem pontuação", () => {
    const r = escolherCandidato([BMT_15], "b.m.t. 15cm");
    assert.equal(r.status, "unico");
    assert.equal(r.produto.id, BMT_15.id);
  });

  test("pequeno erro de grafia (frango teriaki -> teriyaki) ainda resolve", () => {
    const r = escolherCandidato([FRANGO_TERIYAKI, FANTA_UVA], "frango teriaki");
    assert.equal(r.status, "unico");
    assert.equal(r.produto.id, FRANGO_TERIYAKI.id);
  });

  test("nome parcial único no conjunto (só 1 candidato bate) resolve", () => {
    const r = escolherCandidato([FANTA_UVA], "fanta");
    assert.equal(r.status, "unico");
  });
});

describe("escolherCandidato — ambiguidade (nunca escolhe sozinho)", () => {
  test("'cookie' com 2 cookies cadastrados -> ambíguo, devolve os 2 candidatos", () => {
    const r = escolherCandidato([COOKIE_CHOC, COOKIE_AVEIA], "cookie");
    assert.equal(r.status, "ambiguo");
    assert.equal(r.candidatos.length, 2);
    assert.deepEqual(r.candidatos.map((c) => c.id).sort(), ["4", "5"]);
  });

  test("'BMT' sem tamanho, com 2 tamanhos cadastrados -> ambíguo", () => {
    const r = escolherCandidato([BMT_15, BMT_30], "BMT");
    assert.equal(r.status, "ambiguo");
    assert.equal(r.candidatos.length, 2);
  });

  test("'BMT 15cm' específico, mesmo com BMT 30cm no conjunto, resolve único (o exato vence o parcial)", () => {
    const r = escolherCandidato([BMT_15, BMT_30], "BMT 15cm");
    assert.equal(r.status, "unico");
    assert.equal(r.produto.id, BMT_15.id);
  });
});

describe("escolherCandidato — não encontrado", () => {
  test("nenhum candidato no conjunto -> não encontrado", () => {
    const r = escolherCandidato([], "produto que não existe");
    assert.equal(r.status, "nao_encontrado");
  });

  test("termo completamente diferente de todos os candidatos -> não encontrado", () => {
    const r = escolherCandidato([FANTA_UVA, BMT_15], "xpto123");
    assert.equal(r.status, "nao_encontrado");
  });

  test("termo vazio -> não encontrado, nunca lança exceção", () => {
    const r = escolherCandidato([FANTA_UVA], "");
    assert.equal(r.status, "nao_encontrado");
  });
});
