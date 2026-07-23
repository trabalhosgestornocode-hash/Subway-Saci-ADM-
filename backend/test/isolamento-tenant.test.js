// =====================================================================
// TESTE DE INTEGRAÇÃO — Isolamento multi-tenant (RLS por vínculos)
// =====================================================================
// Prova, contra um Supabase REAL, que o Row Level Security impede acesso
// cruzado entre organizações/unidades — no modelo de VÍNCULOS (migrations
// 015 + 016): usuário acessa apenas as orgs/unidades às quais está vinculado;
// `platform_superadmin` tem acesso global.
//
// COMO FUNCIONA
//   * Setup usa a chave service_role (admin) — cria tenants, usuários, VÍNCULOS
//     (usuarios_organizacoes / usuarios_unidades) e dados. service_role IGNORA
//     o RLS (esperado no setup).
//   * As ASSERÇÕES usam clientes autenticados com o JWT de cada usuário
//     (papel `authenticated`) — é aí que o RLS entra em ação.
//
// SEGURANÇA — NUNCA use produção
//   * Só roda com TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_ROLE_KEY /
//     TEST_SUPABASE_ANON_KEY definidas. Sem elas, é PULADO (npm test fica verde).
//   * Recusa rodar se TEST_SUPABASE_URL == SUPABASE_URL (parece produção).
//   * Exige ISOLATION_TEST_DISPOSABLE=1 (confirmação de alvo DESCARTÁVEL),
//     pois o teste CRIA e APAGA organizações/usuários/dados.
//
// PRÉ-REQUISITO: o Supabase de teste precisa do schema + migrations 001..016.
//
// COMO RODAR
//   node --env-file=.env.test --test test/isolamento-tenant.test.js
//   (ou exporte as variáveis e: npm run test:isolation)
// =====================================================================
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import {
  motivoParaPular, verificarCredencial, verificarTabelas,
  verificarRlsAtivo, verificarVinculos, vazamento,
} from "./helpers/preflight-supabase.js";

// Node < 22 não tem WebSocket global; supabase-js (realtime) exige.
if (!globalThis.WebSocket) globalThis.WebSocket = ws;

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const TEM_ENV = Boolean(URL && SERVICE && ANON);

// Guarda anti-produção: jamais rodar contra a mesma URL do backend de produção.
const APONTA_PROD = TEM_ENV && process.env.SUPABASE_URL && URL === process.env.SUPABASE_URL;

// ⚠️ Este teste CRIA e APAGA organizações/usuários/dados. Só roda contra um
// projeto DESCARTÁVEL, e ainda exige confirmação explícita para evitar que
// alguém aponte, por engano, para a base de produção.
const CONFIRMA_DESCARTAVEL = process.env.ISOLATION_TEST_DISPOSABLE === "1";

// Guardas de segurança inalteradas — só o diagnóstico ficou preciso.
// Ver test/helpers/preflight-supabase.js para as 7 causas distinguidas.
const motivoSkip = motivoParaPular({
  url: URL, service: SERVICE, anon: ANON,
  urlProducao: process.env.SUPABASE_URL,
  confirmaDescartavel: CONFIRMA_DESCARTAVEL,
});

const opts = { auth: { persistSession: false, autoRefreshToken: false } };

describe("Isolamento multi-tenant (RLS por vínculos)", { skip: motivoSkip }, () => {
  const admin = createClient(URL, SERVICE, opts);
  const tag = `isotest_${Date.now()}`;
  const SENHA = `Iso-${tag}-Xx1!`;
  const ctx = { A: null, B: null, SUPER: null, MULTI: null };

  // Cria um usuário no Auth e devolve um cliente já autenticado como ele.
  async function criarUsuarioAutenticado(sufixo) {
    const email = `${tag}_${sufixo}@example.com`.toLowerCase();
    const { data: created, error } = await admin.auth.admin.createUser({
      email, password: SENHA, email_confirm: true,
    });
    assert.ifError(error);
    const cli = createClient(URL, ANON, opts);
    const { error: eLogin } = await cli.auth.signInWithPassword({ email, password: SENHA });
    assert.ifError(eLogin);
    return { email, uid: created.user.id, cli };
  }

  // Cria um tenant completo (org + unidade + usuário VINCULADO + dados) e devolve
  // um cliente autenticado como o usuário desse tenant.
  async function criarTenant(rotulo) {
    const { data: org, error: eOrg } = await admin
      .from("organizacoes").insert({ nome: `ISO ${rotulo} ${tag}` }).select("id").single();
    assert.ifError(eOrg);

    const { data: uni, error: eUni } = await admin
      .from("unidades").insert({ organizacao_id: org.id, nome: `Unidade ${rotulo} ${tag}` }).select("id").single();
    assert.ifError(eUni);

    const u = await criarUsuarioAutenticado(rotulo);

    // Perfil legado (compatibilidade) + VÍNCULOS N:N (é o que o RLS 016 usa).
    const { error: ePerf } = await admin.from("perfis").insert({
      id: u.uid, organizacao_id: org.id, unidade_id: uni.id,
      nome: `User ${rotulo}`, email: u.email, papel: "admin", ativo: true,
    });
    assert.ifError(ePerf);
    const { error: eVo } = await admin.from("usuarios_organizacoes")
      .insert({ usuario_id: u.uid, organizacao_id: org.id, papel: "organization_admin" });
    assert.ifError(eVo);
    const { error: eVu } = await admin.from("usuarios_unidades")
      .insert({ usuario_id: u.uid, unidade_id: uni.id });
    assert.ifError(eVu);

    // Dado com escopo de ORGANIZAÇÃO e dado com escopo de UNIDADE
    const { data: prod, error: eProd } = await admin
      .from("produtos").insert({ organizacao_id: org.id, nome: `Produto ${rotulo} ${tag}` }).select("id").single();
    assert.ifError(eProd);
    const { data: venda, error: eVenda } = await admin
      .from("vendas").insert({ unidade_id: uni.id, valor_total: 10 }).select("id").single();
    assert.ifError(eVenda);

    return { ...u, orgId: org.id, uniId: uni.id, prodId: prod.id, vendaId: venda.id };
  }

  before(async () => {
    // PREFLIGHT em camadas: cada checagem elimina uma causa possível ANTES de
    // criar dado, para que uma falha depois só possa significar isolamento
    // quebrado de verdade.
    await verificarCredencial(admin, SERVICE);                       // credencial inválida vs. slot errado
    await verificarTabelas(admin, [                          // migration/tabela ausente
      "organizacoes", "unidades", "perfis", "produtos", "vendas",
      "usuarios_organizacoes", "usuarios_unidades", "plataforma_admins",
    ]);
    await verificarRlsAtivo(createClient(URL, ANON, opts), "produtos"); // policy RLS ausente

    ctx.A = await criarTenant("A");
    ctx.B = await criarTenant("B");

    // Vínculos do setup: sem eles o RLS bloquearia o próprio dono e todos os
    // casos falhariam com sintoma enganoso de "vazamento inverso".
    for (const [rotulo, t] of [["A", ctx.A], ["B", ctx.B]]) {
      await verificarVinculos(admin, {
        usuarioId: t.uid, organizacaoId: t.orgId, unidadeId: t.uniId, rotulo,
      });
    }

    // Superadmin de plataforma (sem vínculo de org — acesso é global).
    ctx.SUPER = await criarUsuarioAutenticado("super");
    const { error: eSuper } = await admin.from("plataforma_admins")
      .insert({ usuario_id: ctx.SUPER.uid, observacao: `teste ${tag}` });
    assert.ifError(eSuper);

    // Usuário vinculado a DUAS organizações (A e B) — modelo multi-membership.
    ctx.MULTI = await criarUsuarioAutenticado("multi");
    const { error: eM1 } = await admin.from("usuarios_organizacoes").insert([
      { usuario_id: ctx.MULTI.uid, organizacao_id: ctx.A.orgId, papel: "viewer" },
      { usuario_id: ctx.MULTI.uid, organizacao_id: ctx.B.orgId, papel: "viewer" },
    ]);
    assert.ifError(eM1);
    const { error: eM2 } = await admin.from("usuarios_unidades").insert([
      { usuario_id: ctx.MULTI.uid, unidade_id: ctx.A.uniId },
      { usuario_id: ctx.MULTI.uid, unidade_id: ctx.B.uniId },
    ]);
    assert.ifError(eM2);
  });

  after(async () => {
    // Limpeza best-effort. Apagar usuário Auth remove perfil/vínculos/plataforma_admins
    // (cascade por usuario_id). Apagar a organização remove unidade/produto/venda.
    for (const u of [ctx.SUPER, ctx.MULTI]) {
      if (u?.uid) { try { await admin.auth.admin.deleteUser(u.uid); } catch { /* ignora */ } }
    }
    for (const t of [ctx.A, ctx.B]) {
      if (!t) continue;
      try { await admin.auth.admin.deleteUser(t.uid); } catch { /* ignora */ }
      try { await admin.from("organizacoes").delete().eq("id", t.orgId); } catch { /* ignora */ }
    }
  });

  // ------- 5 + 6: A lê o próprio, nunca o de B (escopo organização) -------
  it("A lê os próprios produtos e NENHUM produto de B", async () => {
    const { data, error } = await ctx.A.cli.from("produtos").select("id, organizacao_id");
    assert.ifError(error);
    assert.ok(data.length >= 1, "A deveria enxergar ao menos o próprio produto");
    assert.ok(data.every((r) => r.organizacao_id === ctx.A.orgId), vazamento("A viu produto de outra organização"));
    assert.ok(data.some((r) => r.id === ctx.A.prodId), "A não enxergou o próprio produto");
    assert.ok(!data.some((r) => r.id === ctx.B.prodId), vazamento("A enxergou o produto de B"));
  });

  // ------- 8: acesso direto por ID a registro de outra org -------
  it("A NÃO acessa por ID um produto de B", async () => {
    const { data, error } = await ctx.A.cli.from("produtos").select("id").eq("id", ctx.B.prodId);
    assert.ifError(error);
    assert.equal(data.length, 0, vazamento("A acessou por ID um produto de B"));
  });

  // ------- 9: criação cross-tenant deve ser bloqueada (WITH CHECK) -------
  it("A NÃO consegue INSERIR na organização de B", async () => {
    const { error } = await ctx.A.cli.from("produtos").insert({ organizacao_id: ctx.B.orgId, nome: `intruso ${tag}` });
    assert.ok(error, vazamento("INSERT cross-tenant (A->B) deveria ser bloqueado pelo RLS"));
  });

  // ------- 9: edição cross-tenant não pode surtir efeito -------
  it("A NÃO consegue EDITAR um produto de B", async () => {
    await ctx.A.cli.from("produtos").update({ nome: `hackeado ${tag}` }).eq("id", ctx.B.prodId);
    const { data, error } = await admin.from("produtos").select("nome").eq("id", ctx.B.prodId).single();
    assert.ifError(error);
    assert.notEqual(data.nome, `hackeado ${tag}`, vazamento("A editou um produto de B"));
  });

  // ------- 9: exclusão cross-tenant não pode surtir efeito -------
  it("A NÃO consegue EXCLUIR um produto de B", async () => {
    await ctx.A.cli.from("produtos").delete().eq("id", ctx.B.prodId);
    const { data, error } = await admin.from("produtos").select("id").eq("id", ctx.B.prodId);
    assert.ifError(error);
    assert.equal(data.length, 1, vazamento("A excluiu um produto de B"));
  });

  // ------- isolamento também no escopo de UNIDADE -------
  it("A NÃO enxerga vendas da unidade de B", async () => {
    const { data, error } = await ctx.A.cli.from("vendas").select("id, unidade_id");
    assert.ifError(error);
    assert.ok(data.every((r) => r.unidade_id === ctx.A.uniId), vazamento("A viu venda de outra unidade"));
    assert.ok(!data.some((r) => r.id === ctx.B.vendaId), vazamento("A enxergou a venda de B"));
  });

  // ------- 7: sentido inverso (B nunca vê/altera A) -------
  it("Inverso: B lê os próprios produtos e NENHUM de A", async () => {
    const { data, error } = await ctx.B.cli.from("produtos").select("id, organizacao_id");
    assert.ifError(error);
    assert.ok(data.every((r) => r.organizacao_id === ctx.B.orgId), vazamento("B viu produto de outra organização"));
    assert.ok(data.some((r) => r.id === ctx.B.prodId), "B não enxergou o próprio produto");
    assert.ok(!data.some((r) => r.id === ctx.A.prodId), vazamento("B enxergou o produto de A"));
  });

  it("Inverso: B NÃO acessa por ID, NÃO insere e NÃO edita dados de A", async () => {
    const { data: sel, error: eSel } = await ctx.B.cli.from("produtos").select("id").eq("id", ctx.A.prodId);
    assert.ifError(eSel);
    assert.equal(sel.length, 0, vazamento("B acessou por ID um produto de A"));

    const { error: eIns } = await ctx.B.cli.from("produtos").insert({ organizacao_id: ctx.A.orgId, nome: `intruso ${tag}` });
    assert.ok(eIns, vazamento("INSERT cross-tenant (B->A) deveria ser bloqueado pelo RLS"));

    await ctx.B.cli.from("produtos").update({ nome: `hackeado ${tag}` }).eq("id", ctx.A.prodId);
    const { data, error } = await admin.from("produtos").select("nome").eq("id", ctx.A.prodId).single();
    assert.ifError(error);
    assert.notEqual(data.nome, `hackeado ${tag}`, vazamento("B editou um produto de A"));
  });

  // ------- platform_superadmin: acesso global (exceção controlada) -------
  it("platform_superadmin enxerga dados de A E de B (acesso global)", async () => {
    const { data, error } = await ctx.SUPER.cli.from("produtos").select("id");
    assert.ifError(error);
    assert.ok(data.some((r) => r.id === ctx.A.prodId), "superadmin não enxergou o produto de A");
    assert.ok(data.some((r) => r.id === ctx.B.prodId), "superadmin não enxergou o produto de B");
  });

  // ------- multi-membership: usuário vinculado a A e B vê os dois -------
  it("Usuário vinculado a A e B enxerga ambos e nada fora dos vínculos", async () => {
    const { data, error } = await ctx.MULTI.cli.from("produtos").select("id, organizacao_id");
    assert.ifError(error);
    assert.ok(data.some((r) => r.id === ctx.A.prodId), "multi-org não enxergou o produto de A");
    assert.ok(data.some((r) => r.id === ctx.B.prodId), "multi-org não enxergou o produto de B");
    assert.ok(
      data.every((r) => r.organizacao_id === ctx.A.orgId || r.organizacao_id === ctx.B.orgId),
      vazamento("multi-org enxergou dados de organização sem vínculo"),
    );
  });
});
