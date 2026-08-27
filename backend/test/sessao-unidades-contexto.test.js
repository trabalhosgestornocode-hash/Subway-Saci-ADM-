// Testes de `listarUnidadesContexto` (sessao.service.js) — a fonte de dados
// do seletor global do topbar (Fase G: corrige o "contexto sem saída", ver
// PR/descrição). Unit test, sem rede/Supabase: `buscarUnidadesAtivas` e
// `listarAcessos` são injetados (mesmo padrão de cmv-tabela-oficial.test.js).
//
// O que este arquivo protege, na ordem do pedido original:
//   * empresa com 2+ unidades e vínculo normal -> lista só as do usuário
//     NAQUELA empresa (nunca as de outra empresa do mesmo `acessos`);
//   * usuário só tem acesso a 1 das várias unidades -> só ela aparece;
//   * empresa bloqueada/inacessível -> não entra na lista;
//   * impersonação -> ignora vínculo pessoal, usa TODAS as unidades ativas
//     da empresa (é o caminho que resolve o caso do Grupo Saci);
//   * `listarAcessos` devolvendo só a opção consolidada (org sem nenhuma
//     unidade cadastrada ainda) -> lista vazia, corretamente (não há nada
//     pra oferecer). NÃO é mais o caso de "vínculo só de empresa com
//     unidades reais" — isso listarAcessos já resolve por herança desde a
//     correção em sessao-heranca-empresa-unidade.test.js; este teste aqui
//     cobre só o filtro de listarUnidadesContexto em cima do que
//     listarAcessos devolver.
//
// Rodar: node --env-file-if-exists=.env --test test/sessao-unidades-contexto.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { listarUnidadesContexto } from "../src/modules/sessao/sessao.service.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USUARIO_ID = "usr-1";

describe("listarUnidadesContexto — sessão normal (com vínculo)", () => {
  test("empresa com 2+ unidades: lista só as da empresa do contexto atual", async () => {
    const deps = {
      buscarUnidadesAtivas: async () => { throw new Error("não deveria chamar — não é impersonação"); },
      listarAcessos: async () => ({
        opcoes: [
          { organizacaoId: ORG_A, unidadeId: "u1", unidadeNome: "Loja 1", acessivel: true },
          { organizacaoId: ORG_A, unidadeId: "u2", unidadeNome: "Loja 2", acessivel: true },
          { organizacaoId: ORG_B, unidadeId: "u3", unidadeNome: "Outra empresa", acessivel: true },
        ],
      }),
    };
    const r = await listarUnidadesContexto({ usuarioId: USUARIO_ID, organizacaoId: ORG_A, impersonando: false }, deps);
    assert.equal(r.modo, "vinculo");
    assert.deepEqual(r.unidades.map((u) => u.id), ["u1", "u2"]);
  });

  test("usuário só tem acesso a 1 das várias unidades: só a autorizada aparece", async () => {
    const deps = {
      buscarUnidadesAtivas: async () => [],
      listarAcessos: async () => ({
        opcoes: [{ organizacaoId: ORG_A, unidadeId: "u1", unidadeNome: "Subway Ideal Mall", acessivel: true }],
      }),
    };
    const r = await listarUnidadesContexto({ usuarioId: USUARIO_ID, organizacaoId: ORG_A, impersonando: false }, deps);
    assert.equal(r.unidades.length, 1);
    assert.equal(r.unidades[0].id, "u1");
  });

  test("opção não acessível (empresa bloqueada/suspensa) não entra na lista", async () => {
    const deps = {
      buscarUnidadesAtivas: async () => [],
      listarAcessos: async () => ({
        opcoes: [{ organizacaoId: ORG_A, unidadeId: "u1", unidadeNome: "Loja 1", acessivel: false, motivo: "Empresa bloqueada." }],
      }),
    };
    const r = await listarUnidadesContexto({ usuarioId: USUARIO_ID, organizacaoId: ORG_A, impersonando: false }, deps);
    assert.deepEqual(r.unidades, []);
  });

  test("listarAcessos devolve só a opção consolidada (empresa sem nenhuma unidade cadastrada) -> lista vazia, nada pra oferecer", async () => {
    const deps = {
      buscarUnidadesAtivas: async () => { throw new Error("não deveria chamar"); },
      listarAcessos: async () => ({
        opcoes: [{ organizacaoId: ORG_A, unidadeId: null, unidadeNome: null, acessivel: true }],
      }),
    };
    const r = await listarUnidadesContexto({ usuarioId: USUARIO_ID, organizacaoId: ORG_A, impersonando: false }, deps);
    assert.deepEqual(r.unidades, []);
  });
});

describe("listarUnidadesContexto — impersonação (SuperAdmin em suporte)", () => {
  test("ignora vínculo pessoal — usa TODAS as unidades ativas da empresa", async () => {
    let orgConsultada = null;
    const deps = {
      buscarUnidadesAtivas: async (organizacaoId) => {
        orgConsultada = organizacaoId;
        return [
          { id: "u1", nome: "Loja Florianópolis-SC 1", cidade: "Florianópolis" },
          { id: "u2", nome: "Subway Ideal Mall", cidade: "Fortaleza" },
        ];
      },
      listarAcessos: async () => { throw new Error("não deveria chamar — é impersonação"); },
    };
    const r = await listarUnidadesContexto({ usuarioId: USUARIO_ID, organizacaoId: ORG_A, impersonando: true }, deps);
    assert.equal(orgConsultada, ORG_A);
    assert.equal(r.modo, "impersonacao");
    assert.equal(r.unidades.length, 2);
  });

  test("empresa com 1 unidade só em impersonação: ainda assim devolve a lista (quem decide auto-seleção é o chamador)", async () => {
    const deps = {
      buscarUnidadesAtivas: async () => [{ id: "u1", nome: "Matriz", cidade: null }],
      listarAcessos: async () => { throw new Error("não deveria chamar"); },
    };
    const r = await listarUnidadesContexto({ usuarioId: USUARIO_ID, organizacaoId: ORG_A, impersonando: true }, deps);
    assert.equal(r.unidades.length, 1);
  });
});
