// Testes do catálogo de módulos e da lógica de diff/validação.
//
// Escopo: só as funções PURAS de backend/src/shared/modulos.js
// (validarModulos, calcularDiffModulos, rotuloModulo, o catálogo em si) e
// `requireModulo` (que só olha `req.acesso`, sem tocar o banco). O que
// depende de Supabase (modulosDaEmpresa, definirModulosEmpresa,
// provisionarModulosEmpresa) fica fora — segue o padrão do resto da suíte
// (ver context-token.test.js): unit test não bate em rede/banco.
//
// Rodar: node --env-file-if-exists=.env --test test/modulos.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MODULOS, CATALOGO_MODULOS, validarModulos, calcularDiffModulos, rotuloModulo,
  interseccaoModulos,
} from "../src/shared/modulos.js";
import { requireModulo } from "../src/middlewares/auth.js";

describe("catálogo de módulos", () => {
  test("todo valor de MODULOS existe no catálogo", () => {
    const ids = new Set(CATALOGO_MODULOS.map((m) => m.id));
    for (const id of Object.values(MODULOS)) assert.ok(ids.has(id), `MODULOS aponta para "${id}", ausente do catálogo`);
  });

  test("ids do catálogo são únicos", () => {
    const ids = CATALOGO_MODULOS.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("categoria de todo módulo é operacao ou integracao", () => {
    for (const m of CATALOGO_MODULOS) assert.ok(["operacao", "integracao"].includes(m.categoria), m.id);
  });
});

describe("validarModulos", () => {
  test("aceita lista vazia", () => {
    assert.deepEqual(validarModulos([]), []);
  });

  test("aceita ids conhecidos e remove duplicatas", () => {
    const r = validarModulos([MODULOS.DASHBOARD, MODULOS.SALES, MODULOS.DASHBOARD]);
    assert.deepEqual(r, [MODULOS.DASHBOARD, MODULOS.SALES]);
  });

  test("rejeita id desconhecido", () => {
    assert.throws(() => validarModulos(["modulo_inventado"]), /desconhecido/);
  });

  test("rejeita valor que não é lista", () => {
    assert.throws(() => validarModulos("dashboard"));
    assert.throws(() => validarModulos(undefined));
  });
});

describe("calcularDiffModulos", () => {
  test("tudo novo -> tudo habilitado, nada desabilitado", () => {
    const r = calcularDiffModulos([], [MODULOS.DASHBOARD, MODULOS.SALES]);
    assert.deepEqual(r.habilitados.sort(), [MODULOS.DASHBOARD, MODULOS.SALES].sort());
    assert.deepEqual(r.desabilitados, []);
  });

  test("remover tudo -> tudo desabilitado, nada habilitado", () => {
    const r = calcularDiffModulos([MODULOS.DASHBOARD, MODULOS.SALES], []);
    assert.deepEqual(r.habilitados, []);
    assert.deepEqual(r.desabilitados.sort(), [MODULOS.DASHBOARD, MODULOS.SALES].sort());
  });

  test("sobreposição parcial: só o que mudou entra no diff", () => {
    const atuais = [MODULOS.DASHBOARD, MODULOS.SALES, MODULOS.INGREDIENTS];
    const desejados = [MODULOS.DASHBOARD, MODULOS.MARTIN_BROWER, MODULOS.INGREDIENTS];
    const r = calcularDiffModulos(atuais, desejados);
    assert.deepEqual(r.habilitados, [MODULOS.MARTIN_BROWER]);
    assert.deepEqual(r.desabilitados, [MODULOS.SALES]);
  });

  test("nenhuma mudança -> diff vazio dos dois lados", () => {
    const lista = [MODULOS.DASHBOARD, MODULOS.SALES];
    const r = calcularDiffModulos(lista, [...lista]);
    assert.deepEqual(r.habilitados, []);
    assert.deepEqual(r.desabilitados, []);
  });
});

describe("rotuloModulo", () => {
  test("devolve o nome do catálogo", () => {
    assert.equal(rotuloModulo(MODULOS.MONTHLY_BONUS), "Bonificação Mensal");
  });

  test("id desconhecido devolve o próprio id (nunca lança)", () => {
    assert.equal(rotuloModulo("xyz"), "xyz");
  });
});

describe("requireModulo", () => {
  function proximo() { let chamado = false, erro = null; const next = (e) => { chamado = true; erro = e; }; return { next, chamado: () => chamado, erro: () => erro }; }

  test("sem req.acesso -> 403 explícito, não deixa passar por engano", () => {
    const { next, erro } = proximo();
    requireModulo(MODULOS.DASHBOARD)({ acesso: null }, {}, next);
    assert.equal(erro().statusCode, 403);
  });

  test("impersonação bypassa a checagem de módulo", () => {
    const { next, erro } = proximo();
    requireModulo(MODULOS.DASHBOARD)({ acesso: { impersonando: true, modulos: [] } }, {}, next);
    assert.equal(erro(), undefined);
  });

  test("módulo contratado passa", () => {
    const { next, erro } = proximo();
    requireModulo(MODULOS.DASHBOARD)({ acesso: { impersonando: false, modulos: [MODULOS.DASHBOARD] } }, {}, next);
    assert.equal(erro(), undefined);
  });

  test("módulo não contratado -> 403", () => {
    const { next, erro } = proximo();
    requireModulo(MODULOS.MARTIN_BROWER)({ acesso: { impersonando: false, modulos: [MODULOS.DASHBOARD] } }, {}, next);
    assert.equal(erro().statusCode, 403);
  });
});

// ---------------------------------------------------------------------------
// interseccaoModulos — regra central da herança Empresa -> Unidade (item 4 do
// pedido de gerenciamento de Unidades): efetivo = empresa ∩ unidade, SEMPRE.
// ---------------------------------------------------------------------------
describe("interseccaoModulos", () => {
  test("unidade pode ter qualquer SUBCONJUNTO do que a empresa tem", () => {
    const empresa = [MODULOS.DASHBOARD, MODULOS.PRODUTOS_CMV, MODULOS.INGREDIENTS, MODULOS.IFOOD_DASHBOARD, MODULOS.MONTHLY_BONUS];
    const unidade = [MODULOS.DASHBOARD, MODULOS.PRODUTOS_CMV, MODULOS.INGREDIENTS, MODULOS.IFOOD_DASHBOARD];
    assert.deepEqual(interseccaoModulos(empresa, unidade), unidade);
  });

  test("unidade NUNCA recebe um módulo que a empresa não tem, mesmo que a linha exista em unidade_modulos", () => {
    // Cenário do pedido: empresa sem Martin Brower não pode dar Martin Brower pra unidade.
    const empresa = [MODULOS.DASHBOARD, MODULOS.PRODUTOS_CMV];
    const unidade = [MODULOS.DASHBOARD, MODULOS.PRODUTOS_CMV, MODULOS.MARTIN_BROWER];
    const efetivo = interseccaoModulos(empresa, unidade);
    assert.ok(!efetivo.includes(MODULOS.MARTIN_BROWER));
    assert.deepEqual(efetivo, [MODULOS.DASHBOARD, MODULOS.PRODUTOS_CMV]);
  });

  test("empresa perde um módulo depois: a preferência da unidade fica 'adormecida', não é descartada", () => {
    // interseccaoModulos é pura/sem estado — o teste aqui é só a garantia de
    // que o cálculo do efetivo reage ONLINE à empresa, sem precisar reescrever
    // unidade_modulos (a linha da unidade continua existindo, só não conta).
    const unidade = [MODULOS.DASHBOARD, MODULOS.MONTHLY_BONUS];
    assert.deepEqual(interseccaoModulos([MODULOS.DASHBOARD, MODULOS.MONTHLY_BONUS], unidade), unidade);
    assert.deepEqual(interseccaoModulos([MODULOS.DASHBOARD], unidade), [MODULOS.DASHBOARD]); // empresa perdeu monthly_bonus
    assert.deepEqual(interseccaoModulos([MODULOS.DASHBOARD, MODULOS.MONTHLY_BONUS], unidade), unidade); // empresa reganha -> volta sozinho
  });

  test("empresa ou unidade vazias -> efetivo vazio", () => {
    assert.deepEqual(interseccaoModulos([], [MODULOS.DASHBOARD]), []);
    assert.deepEqual(interseccaoModulos([MODULOS.DASHBOARD], []), []);
    assert.deepEqual(interseccaoModulos([], []), []);
  });

  test("preserva a ordem dos módulos da UNIDADE (não da empresa)", () => {
    const empresa = [MODULOS.INGREDIENTS, MODULOS.DASHBOARD, MODULOS.PRODUTOS_CMV];
    const unidade = [MODULOS.DASHBOARD, MODULOS.PRODUTOS_CMV, MODULOS.INGREDIENTS];
    assert.deepEqual(interseccaoModulos(empresa, unidade), unidade);
  });
});
