// Testes de `listarAcessos` e `acessoEfetivoDaUnidade` (sessao.service.js) —
// a REGRA DE ACESSO EFETIVO (empresa -> unidade) documentada no topo
// daquele arquivo. Unit test, sem rede/Supabase: as buscas são injetadas
// (mesmo padrão de cmv-tabela-oficial.test.js / sessao-unidades-contexto.test.js).
//
// Causa raiz corrigida aqui: um usuário com vínculo só de EMPRESA
// (usuarios_organizacoes) não herdava acesso às unidades dela — só via
// unidades com vínculo INDIVIDUAL em usuarios_unidades. Isso deixava
// qualquer usuário "só de empresa" (o caso real: Maria Auxiliadora / Subway
// Centro Montes Claros) sem NENHUMA unidade pra escolher no seletor global,
// mesmo a empresa tendo unidades ativas de verdade.
//
// Rodar: node --env-file-if-exists=.env --test test/sessao-heranca-empresa-unidade.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { listarAcessos, acessoEfetivoDaUnidade } from "../src/modules/sessao/sessao.service.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const U1 = "u1", U2 = "u2", U3 = "u3", U4 = "u4";
const USUARIO_ID = "usr-1";

const org = (id, nome, status = "ativa") => ({ id, nome, logo_url: null, status });

describe("listarAcessos — Cenário 1: vínculo só de empresa herda TODAS as unidades ativas dela", () => {
  test("empresa com 3 unidades, vínculo só de empresa -> 3 opções", async () => {
    const deps = {
      buscarVinculos: async () => ({
        superadmin: false,
        vinculosOrg: [{ papel: "organization_admin", organizacao_id: ORG_A, organizacoes: org(ORG_A, "Subway Centro Montes Claros - MG") }],
        vinculosUni: [], // nenhum vínculo individual — é exatamente o caso da Maria Auxiliadora
      }),
      buscarUnidadesAtivas: async (orgIds) => {
        assert.deepEqual(orgIds, [ORG_A]);
        return [
          { id: U1, nome: "Loja 1", organizacao_id: ORG_A, cidade: null, cnpj: null },
          { id: U2, nome: "Loja 2", organizacao_id: ORG_A, cidade: null, cnpj: null },
          { id: U3, nome: "Loja 3", organizacao_id: ORG_A, cidade: null, cnpj: null },
        ];
      },
      buscarInfoOrganizacoes: async () => { throw new Error("não deveria chamar — info já veio do vínculo de empresa"); },
    };
    const { opcoes } = await listarAcessos({ usuarioId: USUARIO_ID }, deps);
    assert.equal(opcoes.length, 3);
    assert.deepEqual(opcoes.map((o) => o.unidadeId).sort(), [U1, U2, U3].sort());
    assert.ok(opcoes.every((o) => o.organizacaoId === ORG_A && o.papel === "organization_admin" && o.acessivel));
  });

  test("Cenário 2 — nova unidade criada depois aparece automaticamente (nada é cacheado/duplicado)", async () => {
    const deps = {
      buscarVinculos: async () => ({
        superadmin: false,
        vinculosOrg: [{ papel: "organization_admin", organizacao_id: ORG_A, organizacoes: org(ORG_A, "Empresa A") }],
        vinculosUni: [],
      }),
      // A "nova unidade" (U4) simplesmente já está no retorno — não existe
      // nenhum estado intermediário pra invalidar; é sempre uma leitura fresca.
      buscarUnidadesAtivas: async () => [
        { id: U1, nome: "Loja 1", organizacao_id: ORG_A, cidade: null, cnpj: null },
        { id: U4, nome: "Loja Nova", organizacao_id: ORG_A, cidade: null, cnpj: null },
      ],
      buscarInfoOrganizacoes: async () => [],
    };
    const { opcoes } = await listarAcessos({ usuarioId: USUARIO_ID }, deps);
    assert.deepEqual(opcoes.map((o) => o.unidadeId).sort(), [U1, U4].sort());
  });

  test("empresa sem nenhuma unidade cadastrada -> 1 opção consolidada (nada pra herdar ainda)", async () => {
    const deps = {
      buscarVinculos: async () => ({
        superadmin: false,
        vinculosOrg: [{ papel: "organization_admin", organizacao_id: ORG_A, organizacoes: org(ORG_A, "Empresa Nova") }],
        vinculosUni: [],
      }),
      buscarUnidadesAtivas: async () => [],
      buscarInfoOrganizacoes: async () => [],
    };
    const { opcoes } = await listarAcessos({ usuarioId: USUARIO_ID }, deps);
    assert.equal(opcoes.length, 1);
    assert.equal(opcoes[0].unidadeId, null);
  });

  test("empresa com vínculo de empresa e exatamente 1 unidade ativa -> 1 opção, já a unidade (nunca duplica com consolidada)", async () => {
    const deps = {
      buscarVinculos: async () => ({
        superadmin: false,
        vinculosOrg: [{ papel: "organization_admin", organizacao_id: ORG_A, organizacoes: org(ORG_A, "Empresa Matriz Só") }],
        vinculosUni: [],
      }),
      buscarUnidadesAtivas: async () => [{ id: U1, nome: "Matriz", organizacao_id: ORG_A, cidade: null, cnpj: null }],
      buscarInfoOrganizacoes: async () => [],
    };
    const { opcoes } = await listarAcessos({ usuarioId: USUARIO_ID }, deps);
    assert.equal(opcoes.length, 1);
    assert.equal(opcoes[0].unidadeId, U1);
  });
});

describe("listarAcessos — Cenário 3: acesso SOMENTE à unidade (sem vínculo de empresa)", () => {
  test("usuário sem usuarios_organizacoes, só usuarios_unidades para Unidade 2 -> só ela aparece", async () => {
    const deps = {
      buscarVinculos: async () => ({
        superadmin: false,
        vinculosOrg: [], // sem NENHUM vínculo de empresa
        vinculosUni: [{ papel: "unit_manager", unidade_id: U2, unidades: { id: U2, nome: "Loja 2", organizacao_id: ORG_A, cidade: null, cnpj: null, ativo: true } }],
      }),
      buscarUnidadesAtivas: async () => { throw new Error("não deveria chamar — nenhuma empresa com vínculo de empresa"); },
      buscarInfoOrganizacoes: async (ids) => { assert.deepEqual(ids, [ORG_A]); return [org(ORG_A, "Empresa A")]; },
    };
    const { opcoes } = await listarAcessos({ usuarioId: USUARIO_ID }, deps);
    assert.equal(opcoes.length, 1);
    assert.equal(opcoes[0].unidadeId, U2);
    assert.equal(opcoes[0].papel, "unit_manager");
  });

  test("vínculo direto com papel nulo ('herda da empresa') e SEM vínculo de empresa -> não autoriza sozinho, não aparece", async () => {
    const deps = {
      buscarVinculos: async () => ({
        superadmin: false,
        vinculosOrg: [],
        vinculosUni: [{ papel: null, unidade_id: U2, unidades: { id: U2, nome: "Loja 2", organizacao_id: ORG_A, cidade: null, cnpj: null, ativo: true } }],
      }),
      buscarUnidadesAtivas: async () => { throw new Error("não deveria chamar"); },
      buscarInfoOrganizacoes: async () => [org(ORG_A, "Empresa A")],
    };
    const { opcoes } = await listarAcessos({ usuarioId: USUARIO_ID }, deps);
    assert.deepEqual(opcoes, []);
  });
});

describe("listarAcessos — Cenário 4: empresa + vínculo direto na mesma unidade — sem duplicar", () => {
  test("papel do vínculo DIRETO sobrepõe o da empresa, unidade aparece uma única vez", async () => {
    const deps = {
      buscarVinculos: async () => ({
        superadmin: false,
        vinculosOrg: [{ papel: "viewer", organizacao_id: ORG_A, organizacoes: org(ORG_A, "Empresa A") }],
        vinculosUni: [{ papel: "organization_admin", unidade_id: U2, unidades: { id: U2, nome: "Loja 2", organizacao_id: ORG_A, cidade: null, cnpj: null, ativo: true } }],
      }),
      buscarUnidadesAtivas: async () => [
        { id: U1, nome: "Loja 1", organizacao_id: ORG_A, cidade: null, cnpj: null },
        { id: U2, nome: "Loja 2", organizacao_id: ORG_A, cidade: null, cnpj: null },
        { id: U3, nome: "Loja 3", organizacao_id: ORG_A, cidade: null, cnpj: null },
      ],
      buscarInfoOrganizacoes: async () => [],
    };
    const { opcoes } = await listarAcessos({ usuarioId: USUARIO_ID }, deps);
    assert.equal(opcoes.length, 3, "cada unidade uma única vez, mesmo U2 tendo os dois vínculos");
    const u2 = opcoes.find((o) => o.unidadeId === U2);
    const u1 = opcoes.find((o) => o.unidadeId === U1);
    assert.equal(u2.papel, "organization_admin", "papel do vínculo DIRETO sobrepõe o da empresa");
    assert.equal(u1.papel, "viewer", "as outras unidades continuam com o papel da empresa");
  });
});

describe("listarAcessos — Cenário 5: unidade inativa nunca aparece", () => {
  test("herdada: buscarUnidadesAtivas já filtra ativo=true — inativa nunca chega aqui", async () => {
    const deps = {
      buscarVinculos: async () => ({
        superadmin: false,
        vinculosOrg: [{ papel: "organization_admin", organizacao_id: ORG_A, organizacoes: org(ORG_A, "Empresa A") }],
        vinculosUni: [],
      }),
      buscarUnidadesAtivas: async () => [{ id: U1, nome: "Loja 1", organizacao_id: ORG_A, cidade: null, cnpj: null }],
      buscarInfoOrganizacoes: async () => [],
    };
    const { opcoes } = await listarAcessos({ usuarioId: USUARIO_ID }, deps);
    assert.deepEqual(opcoes.map((o) => o.unidadeId), [U1]);
  });

  test("vínculo direto para unidade INATIVA não autoriza sozinho", async () => {
    const deps = {
      buscarVinculos: async () => ({
        superadmin: false,
        vinculosOrg: [],
        vinculosUni: [{ papel: "unit_manager", unidade_id: U2, unidades: { id: U2, nome: "Loja 2 (fechada)", organizacao_id: ORG_A, cidade: null, cnpj: null, ativo: false } }],
      }),
      buscarUnidadesAtivas: async () => { throw new Error("não deveria chamar"); },
      buscarInfoOrganizacoes: async () => { throw new Error("não deveria chamar — nenhuma organização sobra sem a unidade"); },
    };
    const { opcoes } = await listarAcessos({ usuarioId: USUARIO_ID }, deps);
    assert.deepEqual(opcoes, []);
  });
});

describe("listarAcessos — múltiplas empresas, empresa bloqueada, superadmin", () => {
  test("uma empresa via vínculo de empresa, outra via vínculo direto de unidade — nunca mistura unidades entre elas", async () => {
    const deps = {
      buscarVinculos: async () => ({
        superadmin: true,
        vinculosOrg: [{ papel: "organization_admin", organizacao_id: ORG_A, organizacoes: org(ORG_A, "Empresa A") }],
        vinculosUni: [{ papel: "viewer", unidade_id: U3, unidades: { id: U3, nome: "Loja 3", organizacao_id: ORG_B, cidade: null, cnpj: null, ativo: true } }],
      }),
      buscarUnidadesAtivas: async (ids) => {
        assert.deepEqual(ids, [ORG_A]);
        return [{ id: U1, nome: "Loja 1", organizacao_id: ORG_A, cidade: null, cnpj: null }];
      },
      buscarInfoOrganizacoes: async (ids) => { assert.deepEqual(ids, [ORG_B]); return [org(ORG_B, "Empresa B")]; },
    };
    const { superadmin, opcoes } = await listarAcessos({ usuarioId: USUARIO_ID }, deps);
    assert.equal(superadmin, true);
    assert.equal(opcoes.length, 2);
    assert.ok(opcoes.find((o) => o.organizacaoId === ORG_A && o.unidadeId === U1));
    assert.ok(opcoes.find((o) => o.organizacaoId === ORG_B && o.unidadeId === U3));
  });

  test("empresa bloqueada aparece desabilitada, com o motivo — nunca escondida", async () => {
    const deps = {
      buscarVinculos: async () => ({
        superadmin: false,
        vinculosOrg: [{ papel: "organization_admin", organizacao_id: ORG_A, organizacoes: org(ORG_A, "Empresa Bloqueada", "bloqueada") }],
        vinculosUni: [],
      }),
      buscarUnidadesAtivas: async () => [{ id: U1, nome: "Loja 1", organizacao_id: ORG_A, cidade: null, cnpj: null }],
      buscarInfoOrganizacoes: async () => [],
    };
    const { opcoes } = await listarAcessos({ usuarioId: USUARIO_ID }, deps);
    assert.equal(opcoes.length, 1);
    assert.equal(opcoes[0].acessivel, false);
    assert.match(opcoes[0].motivo, /bloqueada/i);
  });
});

describe("acessoEfetivoDaUnidade — a regra OR (empresa OU unidade direta)", () => {
  test("só vínculo de empresa: autoriza, busca a unidade avulsa", async () => {
    const deps = {
      buscarVinculoDireto: async () => null,
      buscarUnidade: async (id) => { assert.equal(id, U1); return { id: U1, nome: "Loja 1", organizacao_id: ORG_A, ativo: true }; },
    };
    const r = await acessoEfetivoDaUnidade({ usuarioId: USUARIO_ID, unidadeId: U1, organizacaoId: ORG_A, papelDaEmpresa: "organization_admin" }, deps);
    assert.equal(r.autorizado, true);
    assert.equal(r.papel, "organization_admin");
    assert.equal(r.unidade.id, U1);
  });

  test("só vínculo direto (sem vínculo de empresa): autoriza com o papel do vínculo direto", async () => {
    const deps = {
      buscarVinculoDireto: async () => ({ papel: "unit_manager", unidades: { id: U2, nome: "Loja 2", organizacao_id: ORG_A, ativo: true } }),
      buscarUnidade: async () => { throw new Error("não deveria chamar — já veio junto do vínculo direto"); },
    };
    const r = await acessoEfetivoDaUnidade({ usuarioId: USUARIO_ID, unidadeId: U2, organizacaoId: ORG_A, papelDaEmpresa: null }, deps);
    assert.equal(r.autorizado, true);
    assert.equal(r.papel, "unit_manager");
  });

  test("vínculo direto aponta pra unidade de OUTRA organização (request adulterada) -> nunca autoriza por essa via", async () => {
    const deps = {
      buscarVinculoDireto: async () => ({ papel: "unit_manager", unidades: { id: U2, nome: "Loja 2", organizacao_id: ORG_B, ativo: true } }),
      buscarUnidade: async () => null,
    };
    const r = await acessoEfetivoDaUnidade({ usuarioId: USUARIO_ID, unidadeId: U2, organizacaoId: ORG_A, papelDaEmpresa: null }, deps);
    assert.equal(r.autorizado, false);
  });

  test("nenhum vínculo (nem empresa, nem direto) -> nega SEM buscar a unidade avulsa (fail-fast)", async () => {
    let chamouBuscarUnidade = false;
    const deps = {
      buscarVinculoDireto: async () => null,
      buscarUnidade: async () => { chamouBuscarUnidade = true; return null; },
    };
    const r = await acessoEfetivoDaUnidade({ usuarioId: USUARIO_ID, unidadeId: U1, organizacaoId: ORG_A, papelDaEmpresa: null }, deps);
    assert.equal(r.autorizado, false);
    assert.equal(chamouBuscarUnidade, false);
  });

  test("vínculo de empresa autoriza, mas a unidade buscada está INATIVA -> nega", async () => {
    const deps = {
      buscarVinculoDireto: async () => null,
      buscarUnidade: async () => ({ id: U1, nome: "Loja Fechada", organizacao_id: ORG_A, ativo: false }),
    };
    const r = await acessoEfetivoDaUnidade({ usuarioId: USUARIO_ID, unidadeId: U1, organizacaoId: ORG_A, papelDaEmpresa: "organization_admin" }, deps);
    assert.equal(r.autorizado, false);
  });

  test("vínculo de empresa autoriza a organizacaoId=A, mas a unidade pedida é de outra empresa (B) -> nega (segurança)", async () => {
    const deps = {
      buscarVinculoDireto: async () => null, // sem vínculo direto pra essa unidade
      buscarUnidade: async () => ({ id: U3, nome: "Loja de B", organizacao_id: ORG_B, ativo: true }),
    };
    const r = await acessoEfetivoDaUnidade({ usuarioId: USUARIO_ID, unidadeId: U3, organizacaoId: ORG_A, papelDaEmpresa: "organization_admin" }, deps);
    assert.equal(r.autorizado, false, "empresa A não autoriza unidade de empresa B, mesmo o usuário tendo acesso a A");
  });

  test("os dois vínculos, papel direto DEFINIDO -> papel direto vence", async () => {
    const deps = {
      buscarVinculoDireto: async () => ({ papel: "organization_admin", unidades: { id: U2, nome: "Loja 2", organizacao_id: ORG_A, ativo: true } }),
      buscarUnidade: async () => { throw new Error("não deveria chamar"); },
    };
    const r = await acessoEfetivoDaUnidade({ usuarioId: USUARIO_ID, unidadeId: U2, organizacaoId: ORG_A, papelDaEmpresa: "viewer" }, deps);
    assert.equal(r.papel, "organization_admin");
  });

  test("os dois vínculos, papel direto NULO ('herda da empresa') -> usa o papel da empresa", async () => {
    const deps = {
      buscarVinculoDireto: async () => ({ papel: null, unidades: { id: U2, nome: "Loja 2", organizacao_id: ORG_A, ativo: true } }),
      buscarUnidade: async () => { throw new Error("não deveria chamar"); },
    };
    const r = await acessoEfetivoDaUnidade({ usuarioId: USUARIO_ID, unidadeId: U2, organizacaoId: ORG_A, papelDaEmpresa: "viewer" }, deps);
    assert.equal(r.papel, "viewer");
  });
});
