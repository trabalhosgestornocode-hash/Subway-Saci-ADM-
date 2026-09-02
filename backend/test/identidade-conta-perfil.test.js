// Fase I — consolidação de identidade: CONTA (req.user) × PESSOA (req.perfil).
//
// Unit/estático, SEM banco. Cobre:
//   * identidadeOperacional(req): nome = PESSOA, email/id = CONTA, impersonação;
//   * auditoria: perfil_nome vai para detalhes; contextoDaRequisicao expõe perfilNome;
//   * contextoAtual separa `conta` de `perfil`;
//   * /me continua sendo a CONTA;
//   * forcarLogout: escopo "perfil" (revoga { perfilId }, não toca Auth) ×
//     escopo "conta" (revoga { usuarioId } + Auth global);
//   * scans: os write-sites de snapshot ("por Fulano") usam identidadeOperacional,
//     não `usuario: req.user`;
//   * guardas "eu mesmo": tenant compara PERFIL; painel superadmin compara CONTA.
//
// Rodar: node --env-file-if-exists=.env --test test/identidade-conta-perfil.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { identidadeOperacional } from "../src/shared/identidade.js";
import { contextoDaRequisicao } from "../src/shared/auditoria.js";

const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const AUDITORIA = src("../src/shared/auditoria.js");
const SESSAO = src("../src/modules/sessao/sessao.service.js");
const PLAT_USUARIOS = src("../src/modules/plataforma/plataforma.usuarios.service.js");
const PLAT_CONTROLLER = src("../src/modules/plataforma/plataforma.controller.js");
const TENANT_USUARIOS = src("../src/modules/usuarios/usuarios.service.js");
const APP = src("../src/app.js");
const AGENTE = src("../src/modules/agente/agente.service.js");

const CONTA = { id: "c0000000-0000-4000-8000-000000000001", nome: "Operacional X", email: "operacional@email.com" };
const PERFIL = { id: "d0000000-0000-4000-8000-000000000002", nome: "Fulana 1" };

// ---------------------------------------------------------------------------
describe("identidadeOperacional — nome = PESSOA, email/id = CONTA (pontos 3/4/30/31)", () => {
  test("sessão normal: nome do perfil, e-mail e id da conta", () => {
    const i = identidadeOperacional({ user: CONTA, perfil: PERFIL, acesso: { perfilId: PERFIL.id } });
    assert.equal(i.nome, "Fulana 1");           // a PESSOA
    assert.equal(i.email, "operacional@email.com"); // a CONTA (credencial compartilhada)
    assert.equal(i.id, CONTA.id);               // a CONTA (FK -> perfis(id))
    assert.equal(i.contaId, CONTA.id);
    assert.equal(i.perfilId, PERFIL.id);
    assert.equal(i.impersonando, false);
  });

  test("sem perfil (impersonação): cai para o nome da conta e marca impersonando", () => {
    const i = identidadeOperacional({ user: CONTA, perfil: null, acesso: { impersonando: true } });
    assert.equal(i.nome, "Operacional X");
    assert.equal(i.perfilId, null);
    assert.equal(i.impersonando, true);
  });

  test("perfis irmãos: cada um produz seu próprio nome, mesma conta", () => {
    const f1 = identidadeOperacional({ user: CONTA, perfil: { id: "p1", nome: "Fulana 1" } });
    const f2 = identidadeOperacional({ user: CONTA, perfil: { id: "p2", nome: "Fulana 2" } });
    assert.equal(f1.nome, "Fulana 1");
    assert.equal(f2.nome, "Fulana 2");
    assert.equal(f1.id, f2.id); // mesma conta — esperado
    assert.notEqual(f1.perfilId, f2.perfilId);
  });

  test("req vazio não explode", () => {
    const i = identidadeOperacional({});
    assert.deepEqual(i, { contaId: null, perfilId: null, id: null, nome: null, email: null, impersonando: false });
  });
});

// ---------------------------------------------------------------------------
describe("auditoria — ator_id = CONTA, perfil_id = PESSOA, perfil_nome em detalhes (pontos 12/13/29)", () => {
  test("contextoDaRequisicao separa conta, perfil e perfilNome", () => {
    const ctx = contextoDaRequisicao({
      user: { ...CONTA, superadmin: false },
      perfil: PERFIL,
      acesso: { perfilId: PERFIL.id },
      tenant: { organizacaoId: "org1" },
      headers: {},
    });
    assert.equal(ctx.atorId, CONTA.id);
    assert.equal(ctx.atorEmail, CONTA.email);
    assert.equal(ctx.perfilId, PERFIL.id);
    assert.equal(ctx.perfilNome, "Fulana 1");
  });

  test("auditar() move perfilNome para dentro de detalhes.perfil_nome (não é coluna)", () => {
    assert.match(AUDITORIA, /entrada\.perfilNome[\s\S]{0,140}perfil_nome: entrada\.perfilNome/);
    assert.match(AUDITORIA, /^\s*detalhes,\s*$/m); // insere a variável `detalhes`, não `entrada.detalhes` direto
  });

  test("impersonação: perfil_id null, impersonado_por setado", () => {
    const ctx = contextoDaRequisicao({
      user: { ...CONTA, superadmin: true },
      perfil: null,
      acesso: { impersonadoPor: "super-1", impersonando: true },
      tenant: { organizacaoId: "org1" },
      headers: {},
    });
    assert.equal(ctx.perfilId, null);
    assert.equal(ctx.impersonadoPor, "super-1");
    assert.equal(ctx.atorTipo, "superadmin");
  });

  test("agente grava perfilNome na auditoria da mensagem", () => {
    assert.match(AGENTE, /perfilNome: perfil\?\.nome \?\? null/);
  });
});

// ---------------------------------------------------------------------------
describe("contextoAtual — expõe CONTA e PERFIL separados (pontos 23/25)", () => {
  const body = SESSAO.slice(SESSAO.indexOf("export function contextoAtual"), SESSAO.indexOf("export function contextoAtual") + 900);
  test("tem `conta` (credencial) e `perfil` (pessoa) como campos distintos", () => {
    assert.match(body, /conta: req\.user/);
    assert.match(body, /perfil: req\.perfil \?\? null/);
    assert.match(body, /papel: req\.acesso\.papel/);
    assert.match(body, /permissoes: req\.acesso\.permissoes/);
    assert.match(body, /modulos: req\.acesso\.modulos/);
  });
});

// ---------------------------------------------------------------------------
describe("/me continua sendo a CONTA (ponto 24)", () => {
  test("GET /api/v1/me devolve req.user, sem virar perfil", () => {
    assert.match(APP, /get\("\/api\/v1\/me",.*res\.json\(\{ data: req\.user \}\)/);
    assert.doesNotMatch(APP, /\/api\/v1\/me[\s\S]{0,80}req\.perfil/);
  });
});

// ---------------------------------------------------------------------------
describe("forcarLogout — PERFIL × CONTA (ponto 17)", () => {
  const fn = PLAT_USUARIOS.slice(PLAT_USUARIOS.indexOf("export async function forcarLogout"), PLAT_USUARIOS.indexOf("export async function excluirUsuario"));

  test("escopo PERFIL: revoga { perfilId }, NÃO toca o Auth", () => {
    assert.match(fn, /revogarSessoes\(\{ perfilId, motivo: "logout_forcado_perfil" \}\)/);
    assert.match(fn, /escopo: "perfil"[\s\S]{0,60}authEncerrado: false/);
    // o ramo do perfil retorna ANTES de encerrarSessoesAuth
    const ramoPerfil = fn.slice(0, fn.indexOf("encerrarSessoesAuth"));
    assert.match(ramoPerfil, /return \{ id, escopo: "perfil"/);
  });

  test("escopo CONTA: revoga { usuarioId } + Auth global", () => {
    assert.match(fn, /revogarSessoes\(\{ usuarioId: id, motivo: "logout_forcado" \}\)/);
    assert.match(fn, /const authEncerrado = await encerrarSessoesAuth\(id\)/);
    assert.match(fn, /escopo: "conta"/);
  });

  test("controller passa perfilId do corpo (opcional)", () => {
    assert.match(PLAT_CONTROLLER, /usuarios\.forcarLogout\(req, req\.params\.id, \(req\.body \?\? \{\}\)\.perfilId \?\? null\)/);
  });
});

// ---------------------------------------------------------------------------
describe("usuários online distinguível por PESSOA (ponto 16)", () => {
  test("obterUsuario devolve perfisOperacionais + sessoesResumo.porPerfil", () => {
    assert.match(PLAT_USUARIOS, /perfisOperacionais: perfisOp\.map/);
    assert.match(PLAT_USUARIOS, /sessoesResumo:/);
    assert.match(PLAT_USUARIOS, /contaOnline: vivas\.length > 0/);
    assert.match(PLAT_USUARIOS, /impersonacoesVivas: vivas\.filter\(\(s\) => !s\.perfil_id\)\.length/);
    assert.match(PLAT_USUARIOS, /sessoesVivas: vivas\.filter\(\(s\) => s\.perfil_id === p\.id\)\.length/);
  });
  test("cada sessão carrega perfilNome resolvido", () => {
    assert.match(PLAT_USUARIOS, /perfilNome: s\.perfil_id \? \(nomePerfil\.get\(s\.perfil_id\)/);
  });
});

// ---------------------------------------------------------------------------
describe("scan — write-sites de snapshot usam identidadeOperacional, não req.user (pontos 5-10, 22, 39)", () => {
  const CONTROLLERS = {
    "dashboard-executivo/dashboardExecutivo.controller.js": src("../src/modules/dashboard-executivo/dashboardExecutivo.controller.js"),
    "bonificacao-mensal/bonificacaoMensal.controller.js": src("../src/modules/bonificacao-mensal/bonificacaoMensal.controller.js"),
    "parser-food-delivery/parserFoodDelivery.controller.js": src("../src/modules/parser-food-delivery/parserFoodDelivery.controller.js"),
    "produtos/produtos.controller.js": src("../src/modules/produtos/produtos.controller.js"),
    "insumos/insumos.controller.js": src("../src/modules/insumos/insumos.controller.js"),
  };
  for (const [nome, txt] of Object.entries(CONTROLLERS)) {
    test(`${nome} não passa mais 'usuario: req.user' e importa o helper`, () => {
      assert.doesNotMatch(txt, /usuario:\s*req\.user\b/);
      assert.match(txt, /identidadeOperacional/);
    });
  }
  test("unidade.service.js grava histórico de tabela comercial com identidadeOperacional", () => {
    const U = src("../src/modules/unidade/unidade.service.js");
    assert.match(U, /const ator = identidadeOperacional\(req\)/);
    assert.match(U, /usuario_id: ator\.id, usuario_nome: ator\.nome, usuario_email: ator\.email/);
  });
  test("sessao.controller mantém 'usuario: req.user' (é a CONTA autenticando — correto)", () => {
    const SC = src("../src/modules/sessao/sessao.controller.js");
    assert.match(SC, /usuario: req\.user/); // seleção de contexto / senha = ação da CONTA
  });
});

// ---------------------------------------------------------------------------
describe("guardas 'eu mesmo' (pontos 33/34)", () => {
  test("tenant (Configurações→Usuários) compara PERFIL", () => {
    assert.match(TENANT_USUARIOS, /const solicitante = solicitantePerfilId \?\? solicitanteId/);
    assert.match(TENANT_USUARIOS, /usuarioId === solicitante/);
  });
  test("painel SuperAdmin compara CONTA (gerencia contas, não perfis — documentado)", () => {
    assert.match(PLAT_USUARIOS, /id === req\.user\.id/);
  });
});
