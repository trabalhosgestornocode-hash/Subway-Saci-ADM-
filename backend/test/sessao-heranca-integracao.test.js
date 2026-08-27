// =====================================================================
// TESTE DE INTEGRAÇÃO — Herança Empresa -> Unidade em selecionarContexto()
// =====================================================================
// Prova, contra um Supabase/Postgres REAL, a REGRA DE ACESSO EFETIVO
// documentada no topo de sessao.service.js:
//
//   podeAcessarUnidade = vínculo ativo direto com ela
//                        OU vínculo ativo com a organização dona dela
//
// Caso real que expôs o bug: usuária com vínculo só de EMPRESA (nenhuma
// linha em usuarios_unidades) via "Selecionar unidade" no seletor global e
// recebia "Nenhuma outra unidade disponível" — porque `selecionarContexto`
// exigia vínculo de empresa ATIVO como pré-requisito e, mesmo tendo esse
// vínculo, só aceitava uma unidadeId se existisse uma linha correspondente
// em usuarios_unidades (nunca herdava as unidades da própria empresa).
//
// SEGURANÇA — mesmo padrão de estrutura-organizacional.test.js/
// exclusao-empresa.test.js: só roda com TEST_SUPABASE_* +
// ISOLATION_TEST_DISPOSABLE=1; sem isso, PULA (não falha). Cria e apaga
// organizações/unidades/usuários de teste, nunca reais.
//
// COMO RODAR
//   node --env-file=.env.test --test test/sessao-heranca-integracao.test.js
// =====================================================================
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { motivoParaPular, verificarCredencial, verificarTabelas } from "./helpers/preflight-supabase.js";

if (!globalThis.WebSocket) globalThis.WebSocket = ws;

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

describe("Herança Empresa -> Unidade — selecionarContexto() contra o banco real", { skip: motivoSkip }, () => {
  const admin = createClient(URL, SERVICE, opts);
  const tag = `heranca_${Date.now()}`;
  const criados = { organizacoes: new Set(), auth: new Set() };

  before(async () => {
    await verificarCredencial(admin, SERVICE);
    await verificarTabelas(admin, ["organizacoes", "unidades", "usuarios_organizacoes", "usuarios_unidades", "plataforma_auditoria"]);
  });

  after(async () => {
    for (const id of criados.auth) { try { await admin.auth.admin.deleteUser(id); } catch { /* ignora */ } }
    for (const id of criados.organizacoes) { try { await admin.from("organizacoes").delete().eq("id", id); } catch { /* ignora */ } }
  });

  async function criarOrg(nome, extra = {}) {
    const { data, error } = await admin.from("organizacoes")
      .insert({ nome: `${nome} ${tag}`, status: "ativa", ativo: true, ...extra }).select("id, nome").single();
    assert.ifError(error);
    criados.organizacoes.add(data.id);
    return data;
  }

  async function criarUnidade(orgId, nome, extra = {}) {
    const { data, error } = await admin.from("unidades")
      .insert({ organizacao_id: orgId, nome: `${nome} ${tag}`, ativo: true, ...extra }).select("id, nome").single();
    assert.ifError(error);
    return data;
  }

  async function criarUsuarioAutenticado(sufixo) {
    const email = `${tag}_${sufixo}@example.com`.toLowerCase();
    const { data, error } = await admin.auth.admin.createUser({ email, password: `Heranca-${tag}-Xx1!`, email_confirm: true });
    assert.ifError(error);
    criados.auth.add(data.user.id);
    return { id: data.user.id, email };
  }

  async function vincularEmpresa(usuarioId, orgId, papel = "organization_admin") {
    const { error } = await admin.from("usuarios_organizacoes").insert({ usuario_id: usuarioId, organizacao_id: orgId, papel, ativo: true });
    assert.ifError(error);
  }

  async function vincularUnidade(usuarioId, unidadeId, papel = null) {
    const { error } = await admin.from("usuarios_unidades").insert({ usuario_id: usuarioId, unidade_id: unidadeId, papel, ativo: true });
    assert.ifError(error);
  }

  it("Cenário 1/caso real (Maria Auxiliadora): vínculo só de empresa autoriza QUALQUER unidade ativa dela", async () => {
    const { selecionarContexto } = await import("../src/modules/sessao/sessao.service.js");
    const org = await criarOrg("SubwayCentro");
    const u1 = await criarUnidade(org.id, "Loja 1");
    const u2 = await criarUnidade(org.id, "Loja 2");
    const usuario = await criarUsuarioAutenticado("maria");
    await vincularEmpresa(usuario.id, org.id); // nenhum vínculo em usuarios_unidades

    // "Todas as unidades" continua funcionando.
    const consolidado = await selecionarContexto({ usuario, organizacaoId: org.id, unidadeId: null });
    assert.equal(consolidado.unidade, null);

    // A unidade específica, SEM nenhum vínculo direto, agora funciona (era
    // aqui que a usuária real batia em "Nenhuma outra unidade disponível").
    const comUnidade1 = await selecionarContexto({ usuario, organizacaoId: org.id, unidadeId: u1.id });
    assert.equal(comUnidade1.unidade.id, u1.id);
    assert.equal(comUnidade1.papel, "organization_admin");

    const comUnidade2 = await selecionarContexto({ usuario, organizacaoId: org.id, unidadeId: u2.id });
    assert.equal(comUnidade2.unidade.id, u2.id);
  });

  it("Cenário 3: acesso SOMENTE à unidade (sem vínculo de empresa) — só aquela unidade, nunca as outras nem 'todas'", async () => {
    const { selecionarContexto } = await import("../src/modules/sessao/sessao.service.js");
    const org = await criarOrg("SoUnidade");
    const u1 = await criarUnidade(org.id, "Loja 1");
    const u2 = await criarUnidade(org.id, "Loja 2");
    const usuario = await criarUsuarioAutenticado("unidade-only");
    await vincularUnidade(usuario.id, u2.id, "unit_manager"); // sem usuarios_organizacoes nenhum

    const r = await selecionarContexto({ usuario, organizacaoId: org.id, unidadeId: u2.id });
    assert.equal(r.unidade.id, u2.id);
    assert.equal(r.papel, "unit_manager");

    await assert.rejects(
      selecionarContexto({ usuario, organizacaoId: org.id, unidadeId: u1.id }),
      (e) => { assert.equal(e.statusCode, 403); return true; },
      "não amplia pra Loja 1 só porque tem acesso à Loja 2",
    );

    await assert.rejects(
      selecionarContexto({ usuario, organizacaoId: org.id, unidadeId: null }),
      (e) => { assert.equal(e.statusCode, 403); return true; },
      "'Todas as unidades' é conceito de EMPRESA — vínculo só de unidade não autoriza",
    );
  });

  it("Cenário 4: empresa + vínculo direto na mesma unidade — papel direto sobrepõe, sem duplicar", async () => {
    const { selecionarContexto } = await import("../src/modules/sessao/sessao.service.js");
    const org = await criarOrg("EmpresaMaisDireta");
    const u1 = await criarUnidade(org.id, "Loja 1");
    const usuario = await criarUsuarioAutenticado("combo");
    await vincularEmpresa(usuario.id, org.id, "viewer");
    await vincularUnidade(usuario.id, u1.id, "organization_admin");

    const r = await selecionarContexto({ usuario, organizacaoId: org.id, unidadeId: u1.id });
    assert.equal(r.papel, "organization_admin", "papel do vínculo direto sobrepõe o da empresa");
  });

  it("unidade de OUTRA empresa é bloqueada, mesmo o usuário tendo acesso à empresa 'certa'", async () => {
    const { selecionarContexto } = await import("../src/modules/sessao/sessao.service.js");
    const orgA = await criarOrg("OrgA");
    const orgB = await criarOrg("OrgB");
    const unidadeDeB = await criarUnidade(orgB.id, "Loja de B");
    const usuario = await criarUsuarioAutenticado("cross-org");
    await vincularEmpresa(usuario.id, orgA.id);

    await assert.rejects(
      selecionarContexto({ usuario, organizacaoId: orgA.id, unidadeId: unidadeDeB.id }),
      (e) => { assert.ok(e.statusCode === 400 || e.statusCode === 403); return true; },
    );
  });

  it("unidade INATIVA não é selecionável nem por herança nem por vínculo direto", async () => {
    const { selecionarContexto } = await import("../src/modules/sessao/sessao.service.js");
    const org = await criarOrg("ComUnidadeInativa");
    const uInativa = await criarUnidade(org.id, "Loja Fechada", { ativo: false });
    const usuarioHeranca = await criarUsuarioAutenticado("heranca-inativa");
    await vincularEmpresa(usuarioHeranca.id, org.id);
    await assert.rejects(
      selecionarContexto({ usuario: usuarioHeranca, organizacaoId: org.id, unidadeId: uInativa.id }),
      (e) => { assert.equal(e.statusCode, 403); return true; },
    );

    const usuarioDireto = await criarUsuarioAutenticado("direto-inativa");
    await vincularUnidade(usuarioDireto.id, uInativa.id, "unit_manager");
    await assert.rejects(
      selecionarContexto({ usuario: usuarioDireto, organizacaoId: org.id, unidadeId: uInativa.id }),
      (e) => { assert.equal(e.statusCode, 403); return true; },
    );
  });

  it("unidade transferida (migration 053): acesso herdado acompanha a organização ATUAL da unidade, nunca a antiga", async () => {
    const { selecionarContexto } = await import("../src/modules/sessao/sessao.service.js");
    const orgAntiga = await criarOrg("OrgAntiga");
    const orgNova = await criarOrg("OrgNova");
    const unidade = await criarUnidade(orgAntiga.id, "Unidade Viajante");

    const usuarioOrgAntiga = await criarUsuarioAutenticado("dono-antiga");
    await vincularEmpresa(usuarioOrgAntiga.id, orgAntiga.id);
    const usuarioOrgNova = await criarUsuarioAutenticado("dono-nova");
    await vincularEmpresa(usuarioOrgNova.id, orgNova.id);

    // Antes da transferência: só quem tem vínculo com a org ANTIGA acessa.
    await selecionarContexto({ usuario: usuarioOrgAntiga, organizacaoId: orgAntiga.id, unidadeId: unidade.id });
    await assert.rejects(selecionarContexto({ usuario: usuarioOrgNova, organizacaoId: orgNova.id, unidadeId: unidade.id }));

    // Simula a transferência (o que transferir_unidade_organizacao faz de
    // essencial: só muda unidades.organizacao_id — não mexe em vínculo nenhum).
    const { error } = await admin.from("unidades").update({ organizacao_id: orgNova.id }).eq("id", unidade.id);
    assert.ifError(error);

    // Depois: a organização NOVA passa a enxergar automaticamente (nenhum
    // vínculo foi criado/copiado — é herança dinâmica, calculada na hora).
    const r = await selecionarContexto({ usuario: usuarioOrgNova, organizacaoId: orgNova.id, unidadeId: unidade.id });
    assert.equal(r.unidade.id, unidade.id);

    // E quem só tinha vínculo com a organização ANTIGA perde o acesso
    // herdado — a unidade não é mais dela.
    await assert.rejects(
      selecionarContexto({ usuario: usuarioOrgAntiga, organizacaoId: orgAntiga.id, unidadeId: unidade.id }),
      (e) => { assert.equal(e.statusCode, 403); return true; },
    );
  });
});
