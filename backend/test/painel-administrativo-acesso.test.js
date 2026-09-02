// Testes de AUTORIZAÇÃO do Painel Administrativo — Fase B.
//
// Escopo: só o middleware PURO `requirePainelAdministrativo` (olha `req.user`,
// não toca banco) — mesmo padrão de modulos.test.js / context-token.test.js:
// unit test não bate em rede/banco. A query que popula
// `req.user.painelAdministrativo` em `requireAuth` é a mesma linha-espelho de
// `plataforma_admins` e será coberta pelos testes de integração de sessão
// numa fase posterior (exigem Supabase descartável, com a migration 061).
//
// Rodar: node --env-file-if-exists=.env --test test/painel-administrativo-acesso.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { requirePainelAdministrativo } from "../src/middlewares/auth.js";

/** Espião de `next` — captura se foi chamado e com qual erro (undefined = passou). */
function espiao() {
  let chamado = false;
  let erro = null;
  return {
    next: (e) => { chamado = true; erro = e ?? null; },
    chamado: () => chamado,
    erro: () => erro,
  };
}

const rodar = (user) => {
  const { next, erro } = espiao();
  requirePainelAdministrativo(user === undefined ? {} : { user }, {}, next);
  return erro();
};

describe("requirePainelAdministrativo", () => {
  test("usuário comum (sem flag, não superadmin) -> 403, NÃO passa", () => {
    const erro = rodar({ id: "u1", superadmin: false, painelAdministrativo: false });
    assert.ok(erro, "deveria bloquear");
    assert.equal(erro.statusCode, 403);
  });

  test("usuário com o flag do Painel Administrativo -> passa", () => {
    assert.equal(rodar({ id: "u2", superadmin: false, painelAdministrativo: true }), null);
  });

  test("SuperAdmin SEM o flag -> passa por bypass (o painel é uma visão a menos, não a mais)", () => {
    assert.equal(rodar({ id: "u3", superadmin: true, painelAdministrativo: false }), null);
  });

  test("SuperAdmin E flag -> passa", () => {
    assert.equal(rodar({ id: "u4", superadmin: true, painelAdministrativo: true }), null);
  });

  test("sem req.user (rota fora de requireAuth por engano) -> 403 explícito, nunca passa", () => {
    const erro = rodar(undefined);
    assert.ok(erro);
    assert.equal(erro.statusCode, 403);
  });

  test("req.user sem os campos -> 403 (não deixa passar por `undefined` truthy-check)", () => {
    const erro = rodar({ id: "u5" });
    assert.ok(erro);
    assert.equal(erro.statusCode, 403);
  });

  test("campos com valor falso explícito ainda bloqueiam", () => {
    const erro = rodar({ id: "u6", superadmin: null, painelAdministrativo: 0 });
    assert.ok(erro);
    assert.equal(erro.statusCode, 403);
  });

  test("a mensagem do 403 fala em Painel Administrativo e NÃO cita SuperAdmin (são ambientes distintos)", () => {
    const erro = rodar({ id: "u7" });
    assert.match(erro.message, /Painel Administrativo/i);
    assert.ok(!/SuperAdmin/i.test(erro.message), "não deve sugerir que o caminho é virar SuperAdmin");
  });

  test("nunca responde sozinho — sempre delega ao `next` (padrão de middleware Express)", () => {
    const { next, chamado } = espiao();
    requirePainelAdministrativo({ user: { id: "u8", painelAdministrativo: true } }, {}, next);
    assert.equal(chamado(), true);
  });
});
