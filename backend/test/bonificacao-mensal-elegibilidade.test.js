// Testes do motor de elegibilidade da bonificação mensal
// (bonificacaoMensal.elegibilidade.js). Puro, sem rede.
// Rodar: node --test test/bonificacao-mensal-elegibilidade.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  avaliarElegibilidadeBonificacao, STATUS_ELEGIBILIDADE_BONIFICACAO as S,
  avaliarSuperRestaurante,
} from "../src/modules/bonificacao-mensal/bonificacaoMensal.elegibilidade.js";

const MIN = { notaIfood: 4.7, rev: 80, pesquisas: 60 };
const criterios = (notaIfood, rev, pesquisas) => ({
  notaIfood: { valor: notaIfood, minimo: MIN.notaIfood },
  rev: { valor: rev, minimo: MIN.rev },
  pesquisas: { valor: pesquisas, minimo: MIN.pesquisas },
});

describe("Cenário 1 — valores exatos do limite são aceitos (inclusive)", () => {
  test("4,70 / 80 / 60 -> elegível", () => {
    const r = avaliarElegibilidadeBonificacao({ ...criterios(4.70, 80, 60), mesFechado: true });
    assert.equal(r.status, S.ELEGIVEL);
    assert.deepEqual(r.motivosInelegibilidade, []);
    assert.equal(r.criterios.nota_ifood.atingido, true);
    assert.equal(r.criterios.rev.atingido, true);
    assert.equal(r.criterios.pesquisas.atingido, true);
  });
});

describe("Cenário 2 — só Nota iFood falha", () => {
  test("4,69 / 90 / 100 -> não elegível, motivo Nota iFood", () => {
    const r = avaliarElegibilidadeBonificacao({ ...criterios(4.69, 90, 100), mesFechado: true });
    assert.equal(r.status, S.NAO_ELEGIVEL);
    assert.equal(r.criterios.nota_ifood.atingido, false);
    assert.equal(r.criterios.rev.atingido, true);
    assert.equal(r.criterios.pesquisas.atingido, true);
    assert.equal(r.motivosInelegibilidade.length, 1);
    assert.match(r.motivosInelegibilidade[0], /nota ifood/i);
  });
});

describe("Cenário 3 — só REV falha", () => {
  test("4,90 / 79 / 100 -> não elegível, motivo REV", () => {
    const r = avaliarElegibilidadeBonificacao({ ...criterios(4.90, 79, 100), mesFechado: true });
    assert.equal(r.status, S.NAO_ELEGIVEL);
    assert.equal(r.criterios.rev.atingido, false);
    assert.equal(r.motivosInelegibilidade.length, 1);
    assert.match(r.motivosInelegibilidade[0], /rev/i);
  });
});

describe("Cenário 4 — só Pesquisas falha", () => {
  test("4,90 / 90 / 59 -> não elegível, motivo Pesquisas", () => {
    const r = avaliarElegibilidadeBonificacao({ ...criterios(4.90, 90, 59), mesFechado: true });
    assert.equal(r.status, S.NAO_ELEGIVEL);
    assert.equal(r.criterios.pesquisas.atingido, false);
    assert.equal(r.motivosInelegibilidade.length, 1);
    assert.match(r.motivosInelegibilidade[0], /pesquisa/i);
  });
});

describe("Cenário 5 — os três falham", () => {
  test("4,60 / 70 / 40 -> não elegível, 3 motivos", () => {
    const r = avaliarElegibilidadeBonificacao({ ...criterios(4.60, 70, 40), mesFechado: true });
    assert.equal(r.status, S.NAO_ELEGIVEL);
    assert.equal(r.criterios.nota_ifood.atingido, false);
    assert.equal(r.criterios.rev.atingido, false);
    assert.equal(r.criterios.pesquisas.atingido, false);
    assert.equal(r.motivosInelegibilidade.length, 3);
  });
});

describe("Punição é integral, nunca parcial", () => {
  test("2 de 3 atingidos ainda é totalmente não elegível — sem meio-termo", () => {
    const r = avaliarElegibilidadeBonificacao({ ...criterios(4.9, 90, 10), mesFechado: true });
    assert.equal(r.status, S.NAO_ELEGIVEL);
    // não existe status intermediário tipo "parcialmente elegível"
    assert.ok(Object.values(S).includes(r.status));
  });
});

describe("EM ACOMPANHAMENTO: mês aberto nunca é 'definitivamente não elegível'", () => {
  test("critério não atingido, mas mês ainda aberto -> em acompanhamento, não não_elegível", () => {
    const r = avaliarElegibilidadeBonificacao({ ...criterios(4.9, 90, 42), mesFechado: false });
    assert.equal(r.status, S.EM_ACOMPANHAMENTO);
    assert.deepEqual(r.motivosInelegibilidade, []); // nunca "vaza" motivo de reprovação antes do fechamento
  });
  test("todos atingidos, mês aberto -> já pode ser elegível (não precisa esperar fechar)", () => {
    const r = avaliarElegibilidadeBonificacao({ ...criterios(4.9, 90, 73), mesFechado: false });
    assert.equal(r.status, S.ELEGIVEL);
  });
});

describe("Sem meta cadastrada não é reprovação (não inventar regra)", () => {
  test("nenhum critério com meta -> em acompanhamento, não não_elegível", () => {
    const r = avaliarElegibilidadeBonificacao({
      notaIfood: { valor: null, minimo: null }, rev: { valor: null, minimo: null }, pesquisas: { valor: null, minimo: null },
      mesFechado: true,
    });
    assert.equal(r.status, S.EM_ACOMPANHAMENTO);
  });
  test("critério sem meta fica fora da decisão; os outros 2, com meta e atingidos, bastam pra elegível", () => {
    const r = avaliarElegibilidadeBonificacao({
      notaIfood: { valor: null, minimo: null }, rev: { valor: 90, minimo: 80 }, pesquisas: { valor: 100, minimo: 60 },
      mesFechado: true,
    });
    assert.equal(r.status, S.ELEGIVEL);
    assert.equal(r.criterios.nota_ifood.temMeta, false);
  });
});

describe("Mês fechado sem dado informado = não elegível (nunca vira aprovação por omissão)", () => {
  test("meta cadastrada mas valor nunca lançado, mês fechado -> não elegível", () => {
    const r = avaliarElegibilidadeBonificacao({
      notaIfood: { valor: 4.9, minimo: 4.7 }, rev: { valor: null, minimo: 80 }, pesquisas: { valor: 100, minimo: 60 },
      mesFechado: true,
    });
    assert.equal(r.status, S.NAO_ELEGIVEL);
    assert.equal(r.criterios.rev.atingido, null);
  });
});

// ---------------------------------------------------------------------------
// SUPER RESTAURANTE — agrupamento "Ifood: Super Restaurante" da planilha
// (Avaliação + Cancelamentos + Pedidos com Chamado). Concentração diferente
// da elegibilidade acima: aqui é só contagem "X de 3 dentro da meta" +
// pontos de atenção, NUNCA um portão de bonificação, pontuação própria ou
// média entre os três. Pesquisas nunca entra aqui — é critério próprio da
// Bonificação Mensal (item 5/11 da correção).
// ---------------------------------------------------------------------------
const MIN_SR = { avaliacaoIfood: 4.7, cancelamentos: 1, pedidosChamado: 2.5 };
const criteriosSR = (avaliacao, cancelamentos, pedidosChamado) => ({
  avaliacaoIfood: { valor: avaliacao, minimo: MIN_SR.avaliacaoIfood },
  cancelamentos: { valor: cancelamentos, minimo: MIN_SR.cancelamentos },
  pedidosChamado: { valor: pedidosChamado, minimo: MIN_SR.pedidosChamado },
});

describe("Super Restaurante — dentro da meta (exemplo da planilha)", () => {
  test("4,8 / 0,28% / 1,34% -> 3 de 3 dentro da meta, sem pontos de atenção", () => {
    const r = avaliarSuperRestaurante(criteriosSR(4.8, 0.28, 1.34));
    assert.equal(r.totalComMeta, 3);
    assert.equal(r.dentroDaMeta, 3);
    assert.deepEqual(r.pontosDeAtencao, []);
  });
});

describe("Super Restaurante — valores exatos do limite são aceitos (inclusive)", () => {
  test("Avaliação exatamente 4,7 -> dentro da meta", () => {
    const r = avaliarSuperRestaurante(criteriosSR(4.7, 0.28, 1.34));
    assert.equal(r.criterios.avaliacao_ifood.atingido, true);
  });
  test("Cancelamentos exatamente 1% -> dentro da meta", () => {
    const r = avaliarSuperRestaurante(criteriosSR(4.8, 1, 1.34));
    assert.equal(r.criterios.cancelamentos.atingido, true);
  });
  test("Pedidos com Chamado exatamente 2,5% -> dentro da meta", () => {
    const r = avaliarSuperRestaurante(criteriosSR(4.8, 0.28, 2.5));
    assert.equal(r.criterios.pedidos_chamado.atingido, true);
  });
});

describe("Super Restaurante — cada indicador fora da meta isoladamente", () => {
  test("Avaliação 4,69 -> fora da meta", () => {
    const r = avaliarSuperRestaurante(criteriosSR(4.69, 0.28, 1.34));
    assert.equal(r.criterios.avaliacao_ifood.atingido, false);
    assert.equal(r.dentroDaMeta, 2);
    assert.equal(r.pontosDeAtencao.length, 1);
    assert.match(r.pontosDeAtencao[0], /avaliação/i);
  });
  test("Cancelamentos 1,01% -> fora da meta", () => {
    const r = avaliarSuperRestaurante(criteriosSR(4.8, 1.01, 1.34));
    assert.equal(r.criterios.cancelamentos.atingido, false);
    assert.equal(r.dentroDaMeta, 2);
    assert.match(r.pontosDeAtencao[0], /cancelamento/i);
  });
  test("Pedidos com Chamado 2,51% -> fora da meta", () => {
    const r = avaliarSuperRestaurante(criteriosSR(4.8, 0.28, 2.51));
    assert.equal(r.criterios.pedidos_chamado.atingido, false);
    assert.equal(r.dentroDaMeta, 2);
    assert.match(r.pontosDeAtencao[0], /pedidos com chamado/i);
  });
});

describe("Super Restaurante nunca inventa pontuação própria", () => {
  test("não devolve nenhum campo de percentual/nota geral — só contagem e critérios", () => {
    const r = avaliarSuperRestaurante(criteriosSR(4.69, 1.01, 2.51));
    assert.deepEqual(Object.keys(r).sort(), ["criterios", "dentroDaMeta", "pontosDeAtencao", "totalComMeta"]);
    assert.equal(r.dentroDaMeta, 0);
    assert.equal(r.pontosDeAtencao.length, 3);
  });
  test("Pesquisas não é um critério do Super Restaurante", () => {
    const r = avaliarSuperRestaurante(criteriosSR(4.8, 0.28, 1.34));
    assert.equal(r.criterios.pesquisas, undefined);
  });
});
