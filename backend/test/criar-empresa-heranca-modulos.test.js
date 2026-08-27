// =====================================================================
// TESTE DE INTEGRAÇÃO — Herança inicial de módulos: Empresa -> Matriz
// =====================================================================
// Regra (plataforma.empresas.service.js#criarEmpresa): ao criar uma
// empresa, o sistema já cria a unidade "Matriz" E copia para ela os
// MESMOS módulos escolhidos para a empresa — a Matriz "nasce configurada",
// sem uma segunda etapa manual.
//
// É HERANÇA INICIAL, não sincronização: mexer nos módulos da empresa
// DEPOIS não reescreve a Matriz (definirModulosEmpresa não toca
// unidade_modulos).
//
// Este teste reproduz os passos de criarEmpresa contra um Supabase
// DESCARTÁVEL (mesmo padrão de exclusao-empresa.test.js /
// estrutura-organizacional.test.js — a suíte não sobe o servidor HTTP nem
// aponta o cliente singleton para o projeto de teste; ela refaz a
// sequência com o próprio `admin`). Cobre os casos do pedido:
//   * empresa com 1 módulo    -> Matriz com o mesmo 1
//   * empresa com N módulos    -> Matriz com os mesmos N
//   * empresa sem módulos      -> Matriz sem nenhum
//   * reexecução / PK duplicada -> sem duplicar linha
//   * alteração posterior da empresa -> NÃO sobrescreve a Matriz
//
// SEGURANÇA: só roda com TEST_SUPABASE_* + ISOLATION_TEST_DISPOSABLE=1;
// sem isso, PULA (não falha).
//
// COMO RODAR
//   node --env-file=.env.test --test test/criar-empresa-heranca-modulos.test.js
// =====================================================================
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { motivoParaPular, verificarCredencial, verificarTabelas } from "./helpers/preflight-supabase.js";

if (!globalThis.WebSocket) globalThis.WebSocket = ws;

// Cópias locais das funções PURAS de src/shared/modulos.js. Não importamos de
// src/ aqui de propósito: src/config/env.js faz process.exit(1) sem as
// SUPABASE_* de produção, e os testes de integração rodam com .env.test (só
// TEST_SUPABASE_*). Mesmo motivo pelo qual estrutura-organizacional.test.js /
// exclusao-empresa.test.js também não importam de src/. A lógica em si já é
// coberta unitariamente em modulos.test.js — aqui ela só serve de oráculo.
const interseccaoModulos = (empresa, unidade) => {
  const set = new Set(empresa);
  return unidade.filter((id) => set.has(id));
};
const calcularDiffModulos = (atuais, desejados) => {
  const a = new Set(atuais), d = new Set(desejados);
  return { habilitados: desejados.filter((id) => !a.has(id)), desabilitados: atuais.filter((id) => !d.has(id)) };
};

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const CONFIRMA_DESCARTAVEL = process.env.ISOLATION_TEST_DISPOSABLE === "1";
const motivoSkip = motivoParaPular({
  url: URL, service: SERVICE, anon: ANON,
  urlProducao: process.env.SUPABASE_URL,
  confirmaDescartavel: CONFIRMA_DESCARTAVEL,
});

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const ATOR = "00000000-0000-0000-0000-000000000000";

describe("Herança inicial de módulos Empresa -> Matriz (criarEmpresa)", { skip: motivoSkip }, () => {
  const admin = createClient(URL, SERVICE, opts);
  const tag = `heranca_${Date.now()}`;
  const criados = { organizacoes: new Set() };

  // Refaz o miolo de criarEmpresa: cria a org, a Matriz, grava os módulos
  // da empresa e — a parte em teste — herda os mesmos na Matriz.
  async function criarEmpresaComMatriz(nome, moduloIds) {
    const { data: org, error: eOrg } = await admin.from("organizacoes")
      .insert({ nome: `${nome} ${tag}`, status: "teste", ativo: true }).select("id, nome").single();
    assert.ifError(eOrg);
    criados.organizacoes.add(org.id);

    const { data: matriz, error: eUni } = await admin.from("unidades")
      .insert({ organizacao_id: org.id, nome: "Matriz", ativo: true }).select("id").single();
    assert.ifError(eUni);

    if (moduloIds.length) {
      const { error: eOrgMod } = await admin.from("organizacao_modulos")
        .insert(moduloIds.map((modulo_id) => ({ organizacao_id: org.id, modulo_id, habilitado_por: ATOR })));
      assert.ifError(eOrgMod);

      // Herança: mesma chamada que o service faz —
      // provisionarModulosUnidade(matriz, moduloIds, moduloIds, ator).
      const herdados = interseccaoModulos(moduloIds, moduloIds);
      const { error: eUniMod } = await admin.from("unidade_modulos")
        .insert(herdados.map((modulo_id) => ({ unidade_id: matriz.id, modulo_id, habilitado_por: ATOR })));
      assert.ifError(eUniMod);
    }
    return { org, matriz };
  }

  const modulosDaMatriz = async (matrizId) => {
    const { data, error } = await admin.from("unidade_modulos").select("modulo_id").eq("unidade_id", matrizId);
    assert.ifError(error);
    return (data ?? []).map((r) => r.modulo_id).sort();
  };
  const modulosDaEmpresa = async (orgId) => {
    const { data, error } = await admin.from("organizacao_modulos").select("modulo_id").eq("organizacao_id", orgId);
    assert.ifError(error);
    return (data ?? []).map((r) => r.modulo_id).sort();
  };

  before(async () => {
    await verificarCredencial(admin, SERVICE);
    await verificarTabelas(admin, ["organizacoes", "unidades", "modulos", "organizacao_modulos", "unidade_modulos"]);
  });

  after(async () => {
    for (const id of criados.organizacoes) {
      try { await admin.from("organizacoes").delete().eq("id", id); } catch { /* cascade cobre unidade_/organizacao_modulos */ }
    }
  });

  it("empresa com 1 módulo -> Matriz herda exatamente esse 1", async () => {
    const { org, matriz } = await criarEmpresaComMatriz("Um", ["dashboard"]);
    assert.deepEqual(await modulosDaEmpresa(org.id), ["dashboard"]);
    assert.deepEqual(await modulosDaMatriz(matriz.id), ["dashboard"]);
  });

  it("empresa com vários módulos -> Matriz herda os mesmos N", async () => {
    const ids = ["dashboard", "products_cmv", "ingredients", "ifood_dashboard", "monthly_bonus", "parser_food_delivery"];
    const { org, matriz } = await criarEmpresaComMatriz("Varios", ids);
    assert.deepEqual(await modulosDaMatriz(matriz.id), [...ids].sort());
    assert.deepEqual(await modulosDaMatriz(matriz.id), await modulosDaEmpresa(org.id));
  });

  it("empresa sem módulos -> Matriz nasce sem nenhum (e a Matriz existe mesmo assim)", async () => {
    const { org, matriz } = await criarEmpresaComMatriz("Vazia", []);
    assert.deepEqual(await modulosDaEmpresa(org.id), []);
    assert.deepEqual(await modulosDaMatriz(matriz.id), []);
    const { data: u } = await admin.from("unidades").select("id, nome").eq("organizacao_id", org.id);
    assert.equal(u.length, 1);
    assert.equal(u[0].nome, "Matriz");
  });

  it("PK (unidade_id, modulo_id): reinserir o mesmo módulo na Matriz é recusado, não duplica", async () => {
    const { matriz } = await criarEmpresaComMatriz("Dup", ["dashboard", "sales"]);
    const { error } = await admin.from("unidade_modulos")
      .insert({ unidade_id: matriz.id, modulo_id: "dashboard", habilitado_por: ATOR });
    assert.ok(error, "esperava violação de PK ao reinserir");
    assert.match(`${error.code} ${error.message}`, /23505|duplicate|unique/i);
    assert.deepEqual(await modulosDaMatriz(matriz.id), ["dashboard", "sales"]);
  });

  it("alterar os módulos da EMPRESA depois NÃO reescreve a Matriz (herança inicial != sincronização)", async () => {
    const inicial = ["dashboard", "products_cmv", "monthly_bonus"];
    const { org, matriz } = await criarEmpresaComMatriz("Evolui", inicial);

    // Simula definirModulosEmpresa: empresa passa a ter {dashboard, ingredients}.
    // A função real só mexe em organizacao_modulos — nunca em unidade_modulos.
    const desejado = ["dashboard", "ingredients"];
    const { habilitados, desabilitados } = calcularDiffModulos(inicial, desejado);
    if (habilitados.length) {
      await admin.from("organizacao_modulos")
        .insert(habilitados.map((modulo_id) => ({ organizacao_id: org.id, modulo_id, habilitado_por: ATOR })));
    }
    if (desabilitados.length) {
      await admin.from("organizacao_modulos").delete().eq("organizacao_id", org.id).in("modulo_id", desabilitados);
    }

    // unidade_modulos da Matriz: intacto (ainda os 3 iniciais).
    assert.deepEqual(await modulosDaMatriz(matriz.id), [...inicial].sort());
    // Efetivo = empresa ∩ Matriz -> só o que sobrou na empresa.
    assert.deepEqual(
      interseccaoModulos(await modulosDaEmpresa(org.id), await modulosDaMatriz(matriz.id)).sort(),
      ["dashboard"],
    );
  });
});
