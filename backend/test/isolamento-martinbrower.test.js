// =====================================================================
// TESTE DE INTEGRAÇÃO — Isolamento das tabelas Martin Brower (migration 017)
// =====================================================================
// Prova, contra um Supabase REAL, que catálogo, histórico de preços,
// sincronizações e vínculos da Martin Brower nunca cruzam a fronteira de
// organização NEM de unidade.
//
// CENÁRIO (o pedido explicitamente inclui duas unidades da MESMA organização,
// que é o caso mais fácil de vazar):
//
//   Organização A ─┬─ Unidade A1  → usuário UA1 (vínculo só com A1)
//                  └─ Unidade A2  → usuário UA2 (vínculo só com A2)
//   Organização B ─── Unidade C   → usuário UC  (vínculo só com C)
//
// DUAS CAMADAS, PROVADAS SEPARADAMENTE — a distinção importa:
//
//   PARTE 1 · RLS — asserções feitas SEMPRE com clientes autenticados pelo JWT
//     de cada usuário (papel `authenticated`). service_role é usado só no
//     SETUP (criar tenants/dados); jamais para simular o acesso do usuário,
//     porque ele ignora RLS e tornaria o teste inútil.
//
//   PARTE 2 · CAMADA DE APLICAÇÃO — em produção o backend usa service_role e
//     IGNORA o RLS. Logo, quem realmente isola é o repositório filtrando
//     organizacao_id + unidade_id em toda query. Esta parte exercita o
//     repositório e o sync REAIS contra o banco de teste.
//
// SEGURANÇA — NUNCA use produção
//   * Só roda com TEST_SUPABASE_URL / _SERVICE_ROLE_KEY / _ANON_KEY definidas.
//     Sem elas é PULADO (npm test continua verde).
//   * Recusa rodar se TEST_SUPABASE_URL == SUPABASE_URL (parece produção).
//   * Exige ISOLATION_TEST_DISPOSABLE=1 — este teste CRIA e APAGA dados.
//
// PRÉ-REQUISITO: Supabase de teste com schema + migrations 001..017.
//
// COMO RODAR
//   npm run test:isolation:mb
//   (o script já usa --env-file=.env.test)
// =====================================================================
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import {
  motivoParaPular, verificarCredencial, verificarTabelas,
  verificarRlsAtivo, verificarVinculos, vazamento,
} from "./helpers/preflight-supabase.js";
import ws from "ws";

import { processarCatalogo } from "../src/modules/martinbrower/martinbrower.sync.service.js";

if (!globalThis.WebSocket) globalThis.WebSocket = ws;

const URL_TESTE = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const TEM_ENV = Boolean(URL_TESTE && SERVICE && ANON);

const APONTA_PROD = TEM_ENV && process.env.SUPABASE_URL && URL_TESTE === process.env.SUPABASE_URL;
const CONFIRMA_DESCARTAVEL = process.env.ISOLATION_TEST_DISPOSABLE === "1";

// Guardas de segurança inalteradas — só o diagnóstico ficou preciso.
const motivoSkip = motivoParaPular({
  url: URL_TESTE, service: SERVICE, anon: ANON,
  urlProducao: process.env.SUPABASE_URL,
  confirmaDescartavel: CONFIRMA_DESCARTAVEL,
});

// O repositório real lê SUPABASE_* de config/env.js no momento em que é
// importado. Redirecionamos para o projeto de TESTE antes disso — a Parte 2
// precisa exercitar o repositório de verdade, não uma cópia.
// As guardas acima já garantem que este alvo não é produção.
if (!motivoSkip) {
  process.env.SUPABASE_URL = URL_TESTE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
  process.env.SUPABASE_ANON_KEY = ANON;
}

const opts = { auth: { persistSession: false, autoRefreshToken: false } };

// Catálogo mínimo no formato real do loadItens. Um alimento, uma embalagem e
// um uniforme (que o filtro deve marcar como ignorado).
const catalogo = (precoBacon) => ({
  data: {
    groups: [
      {
        group: "ALIMENTOS - CONGELADOS",
        itens: [
          {
            orderHeaderId: 900001,
            appClientProduct: {
              id: 1, multiple: 1, type: "W",
              product: {
                id: 6095, code: "1001088", description: "BACON TIRAS CX 4 PCT X 1 KG",
                price: precoBacon, weight: 4.62, volume: 0.026,
                family: "CON", familyDescription: "Congelados",
                group: { id: 246, description: "ALIMENTOS - CONGELADOS" },
                unit: "CX", unitDescription: "CAIXA", ncode: 2664329,
              },
            },
            sysStatusItem: { id: 1 }, quantity: 0, averageQuantity: 1,
          },
          {
            orderHeaderId: 900001,
            appClientProduct: {
              id: 2, multiple: 1, type: "N",
              product: {
                id: 7211, code: "0002045", description: "GUARDANAPO SUBWAY CX 4000 UN",
                price: 158.9, family: "EMB", familyDescription: "Embalagens",
                group: { id: 301, description: "EMBALAGENS" }, unit: "CX", ncode: 2701122,
              },
            },
            sysStatusItem: { id: 1 }, quantity: 0, averageQuantity: 3,
          },
          {
            orderHeaderId: 900001,
            appClientProduct: {
              id: 3, multiple: 1, type: "N",
              product: {
                id: 9001, code: "5000101", description: "CAMISETA POLO SUBWAY TAM M",
                price: 62.4, family: "UNI", familyDescription: "Uniformes",
                group: { id: 410, description: "UNIFORMES" }, unit: "UN", ncode: 2810001,
              },
            },
            sysStatusItem: { id: 1 }, quantity: 0, averageQuantity: 0,
          },
        ],
      },
    ],
  },
  errors: [],
});

describe("Isolamento Martin Brower (migration 017)", { skip: motivoSkip }, () => {
  const admin = createClient(URL_TESTE, SERVICE, opts);
  const tag = `mbiso_${Date.now()}`;
  const SENHA = `Mb-${tag}-Xx1!`;

  // A1 e A2 na MESMA organização; C em outra.
  const ctx = { orgA: null, orgB: null, A1: null, A2: null, C: null };
  let repo; // repositório REAL, importado depois do redirecionamento de env

  async function criarUsuario(sufixo) {
    const email = `${tag}_${sufixo}@example.com`.toLowerCase();
    const { data, error } = await admin.auth.admin.createUser({ email, password: SENHA, email_confirm: true });
    assert.ifError(error);
    const cli = createClient(URL_TESTE, ANON, opts);
    const { error: eLogin } = await cli.auth.signInWithPassword({ email, password: SENHA });
    assert.ifError(eLogin);
    return { email, uid: data.user.id, cli };
  }

  async function criarOrganizacao(rotulo) {
    const { data, error } = await admin.from("organizacoes").insert({ nome: `MBISO ${rotulo} ${tag}` }).select("id").single();
    assert.ifError(error);
    return data.id;
  }

  // Cria unidade + usuário vinculado SÓ a ela + integração MB + insumo interno.
  async function criarUnidade({ orgId, rotulo, clientId }) {
    const { data: uni, error: eUni } = await admin
      .from("unidades").insert({ organizacao_id: orgId, nome: `Unidade ${rotulo} ${tag}` }).select("id").single();
    assert.ifError(eUni);

    const u = await criarUsuario(rotulo);

    const { error: ePerf } = await admin.from("perfis").insert({
      id: u.uid, organizacao_id: orgId, unidade_id: uni.id,
      nome: `User ${rotulo}`, email: u.email, papel: "admin", ativo: true,
    });
    assert.ifError(ePerf);
    // Vínculo com a ORGANIZAÇÃO e com APENAS ESTA unidade — é o que faz o
    // cenário A1 vs A2 ter sentido: mesma org, unidades diferentes.
    const { error: eVo } = await admin.from("usuarios_organizacoes")
      .insert({ usuario_id: u.uid, organizacao_id: orgId, papel: "organization_admin" });
    assert.ifError(eVo);
    const { error: eVu } = await admin.from("usuarios_unidades").insert({ usuario_id: u.uid, unidade_id: uni.id });
    assert.ifError(eVu);

    const { data: integ, error: eInt } = await admin.from("martin_brower_integracoes")
      .insert({ organizacao_id: orgId, unidade_id: uni.id, client_id: clientId, unidade_nome: `Loja ${rotulo}`, status: "pronto" })
      .select("id").single();
    assert.ifError(eInt);

    const { data: insumo, error: eIns } = await admin.from("insumos")
      .insert({ organizacao_id: orgId, nome: `Bacon ${rotulo} ${tag}` }).select("id").single();
    assert.ifError(eIns);

    return { ...u, orgId, uniId: uni.id, clientId, integracaoId: integ.id, insumoId: insumo.id };
  }

  before(async () => {
    // PREFLIGHT em camadas: cada checagem elimina uma causa possível ANTES de
    // criar dado, para que uma falha depois só possa significar isolamento
    // quebrado de verdade. Ver test/helpers/preflight-supabase.js.
    await verificarCredencial(admin, SERVICE);                        // credencial inválida vs. slot errado
    await verificarTabelas(admin, [                           // migration/tabela ausente
      "organizacoes", "unidades", "perfis", "insumos",
      "usuarios_organizacoes", "usuarios_unidades",
      "martin_brower_integracoes", "martin_brower_produtos",
      "martin_brower_precos_historico", "martin_brower_sincronizacoes",
      "martin_brower_filtros", "martin_brower_vinculos",
    ]);
    await verificarRlsAtivo(createClient(URL_TESTE, ANON, opts), "martin_brower_produtos"); // policy ausente

    ctx.orgA = await criarOrganizacao("A");
    ctx.orgB = await criarOrganizacao("B");
    ctx.A1 = await criarUnidade({ orgId: ctx.orgA, rotulo: "A1", clientId: "04532" });
    ctx.A2 = await criarUnidade({ orgId: ctx.orgA, rotulo: "A2", clientId: "7788" });
    ctx.C = await criarUnidade({ orgId: ctx.orgB, rotulo: "C", clientId: "9911" });

    // Vínculos do setup: sem eles o RLS bloquearia o próprio dono e todos os
    // casos falhariam com sintoma enganoso de "vazamento inverso".
    for (const [rotulo, u] of [["A1", ctx.A1], ["A2", ctx.A2], ["C", ctx.C]]) {
      await verificarVinculos(admin, {
        usuarioId: u.uid, organizacaoId: u.orgId, unidadeId: u.uniId, rotulo,
      });
    }

    repo = await import("../src/modules/martinbrower/martinbrower.repository.js");

    // Semeia catálogo em cada unidade — MESMO código em todas, de propósito:
    // se houver vazamento, o upsert de uma atropela a outra.
    for (const [u, preco] of [[ctx.A1, 100], [ctx.A2, 200], [ctx.C, 300]]) {
      const { data: prod, error } = await admin.from("martin_brower_produtos").insert({
        organizacao_id: u.orgId, unidade_id: u.uniId, client_id: u.clientId,
        codigo: "1001088", descricao: `BACON ${u.clientId}`, preco,
      }).select("id").single();
      assert.ifError(error);
      u.produtoId = prod.id;

      const { data: sinc, error: eS } = await admin.from("martin_brower_sincronizacoes").insert({
        organizacao_id: u.orgId, unidade_id: u.uniId, client_id: u.clientId, status: "concluido",
      }).select("id").single();
      assert.ifError(eS);
      u.sincId = sinc.id;

      const { data: hist, error: eH } = await admin.from("martin_brower_precos_historico").insert({
        organizacao_id: u.orgId, unidade_id: u.uniId, produto_id: prod.id,
        client_id: u.clientId, codigo: "1001088", preco_anterior: preco - 10, preco_novo: preco,
      }).select("id").single();
      assert.ifError(eH);
      u.histId = hist.id;

      const { data: vinc, error: eV } = await admin.from("martin_brower_vinculos").insert({
        organizacao_id: u.orgId, unidade_id: u.uniId, mb_produto_id: prod.id, insumo_id: u.insumoId,
      }).select("id").single();
      assert.ifError(eV);
      u.vinculoId = vinc.id;
    }
  });

  after(async () => {
    for (const u of [ctx.A1, ctx.A2, ctx.C]) {
      if (u?.uid) { try { await admin.auth.admin.deleteUser(u.uid); } catch { /* ignora */ } }
    }
    // Apagar a organização derruba unidades, produtos MB, histórico e vínculos
    // por cascade.
    for (const orgId of [ctx.orgA, ctx.orgB]) {
      if (orgId) { try { await admin.from("organizacoes").delete().eq("id", orgId); } catch { /* ignora */ } }
    }
  });

  // ===================================================================
  // PARTE 1 — RLS (clientes AUTENTICADOS; service_role só no setup)
  // ===================================================================

  it("RLS: UA1 vê o próprio catálogo e NENHUM produto de A2 — mesma organização, unidade diferente", async () => {
    const { data, error } = await ctx.A1.cli.from("martin_brower_produtos").select("id, unidade_id, organizacao_id");
    assert.ifError(error);
    assert.ok(data.some((r) => r.id === ctx.A1.produtoId), "UA1 não enxergou o próprio produto");
    assert.ok(data.every((r) => r.unidade_id === ctx.A1.uniId), vazamento("UA1 viu produto de outra unidade"));
    assert.ok(!data.some((r) => r.id === ctx.A2.produtoId),
      vazamento("UA1 enxergou o catálogo de A2 (mesma organização)"));
  });

  it("RLS: UA1 não vê nada da organização B", async () => {
    const { data, error } = await ctx.A1.cli.from("martin_brower_produtos").select("id, organizacao_id");
    assert.ifError(error);
    assert.ok(data.every((r) => r.organizacao_id === ctx.A1.orgId), vazamento("UA1 viu produto de outra organização"));
    assert.ok(!data.some((r) => r.id === ctx.C.produtoId), vazamento("UA1 enxergou o catálogo de C"));
  });

  it("RLS: acesso direto POR ID a produto de outra unidade devolve vazio", async () => {
    for (const [quem, alvo, rotulo] of [
      [ctx.A1, ctx.A2, "A1 -> A2 (mesma org)"],
      [ctx.A1, ctx.C, "A1 -> C (outra org)"],
      [ctx.A2, ctx.A1, "A2 -> A1 (mesma org)"],
      [ctx.C, ctx.A1, "C -> A1 (outra org)"],
    ]) {
      const { data, error } = await quem.cli.from("martin_brower_produtos").select("id").eq("id", alvo.produtoId);
      assert.ifError(error);
      assert.equal(data.length, 0, `VAZAMENTO por ID: ${rotulo}`);
    }
  });

  it("RLS: histórico de preços é isolado por unidade e por organização", async () => {
    const { data, error } = await ctx.A1.cli.from("martin_brower_precos_historico").select("id, unidade_id");
    assert.ifError(error);
    assert.ok(data.every((r) => r.unidade_id === ctx.A1.uniId), vazamento("histórico de outra unidade"));
    assert.ok(!data.some((r) => r.id === ctx.A2.histId), vazamento("UA1 viu histórico de A2"));
    assert.ok(!data.some((r) => r.id === ctx.C.histId), vazamento("UA1 viu histórico de C"));
  });

  it("RLS: sincronizações são isoladas por unidade e por organização", async () => {
    const { data, error } = await ctx.A1.cli.from("martin_brower_sincronizacoes").select("id, unidade_id");
    assert.ifError(error);
    assert.ok(data.every((r) => r.unidade_id === ctx.A1.uniId), vazamento("sincronização de outra unidade"));
    assert.ok(!data.some((r) => r.id === ctx.A2.sincId), vazamento("UA1 viu sincronização de A2"));
    assert.ok(!data.some((r) => r.id === ctx.C.sincId), vazamento("UA1 viu sincronização de C"));
  });

  it("RLS: vínculos e integrações são isolados por unidade e por organização", async () => {
    const { data: vinc, error: eV } = await ctx.A1.cli.from("martin_brower_vinculos").select("id, unidade_id");
    assert.ifError(eV);
    assert.ok(vinc.every((r) => r.unidade_id === ctx.A1.uniId), vazamento("vínculo de outra unidade"));
    assert.ok(!vinc.some((r) => r.id === ctx.A2.vinculoId), vazamento("UA1 viu vínculo de A2"));

    const { data: integ, error: eI } = await ctx.A1.cli.from("martin_brower_integracoes").select("id, unidade_id, client_id");
    assert.ifError(eI);
    assert.ok(integ.every((r) => r.unidade_id === ctx.A1.uniId), vazamento("integração de outra unidade"));
    assert.ok(!integ.some((r) => r.client_id === ctx.A2.clientId), vazamento("UA1 viu o clientId de A2"));
  });

  it("RLS: UA1 NÃO consegue INSERIR produto na unidade A2 nem em C", async () => {
    for (const alvo of [ctx.A2, ctx.C]) {
      const { error } = await ctx.A1.cli.from("martin_brower_produtos").insert({
        organizacao_id: alvo.orgId, unidade_id: alvo.uniId, client_id: alvo.clientId,
        codigo: `intruso_${tag}`, descricao: "INTRUSO",
      });
      assert.ok(error, `VAZAMENTO: INSERT cross-tenant para a unidade ${alvo.uniId} deveria ser bloqueado`);
    }
  });

  it("RLS: UPDATE e DELETE cross-unidade não surtem efeito", async () => {
    await ctx.A1.cli.from("martin_brower_produtos").update({ preco: 999.99 }).eq("id", ctx.A2.produtoId);
    await ctx.A1.cli.from("martin_brower_produtos").delete().eq("id", ctx.A2.produtoId);

    // Confere pelo admin: o registro de A2 tem que estar intacto.
    const { data, error } = await admin.from("martin_brower_produtos").select("preco").eq("id", ctx.A2.produtoId).single();
    assert.ifError(error);
    assert.equal(Number(data.preco), 200, vazamento("UA1 alterou ou removeu o produto de A2"));
  });

  it("RLS: usuário sem login (anon) não enxerga nada", async () => {
    const anonCli = createClient(URL_TESTE, ANON, opts);
    const { data, error } = await anonCli.from("martin_brower_produtos").select("id");
    // Deny-all para anon: ou erro, ou lista vazia — nunca dados.
    assert.ok(error || (data ?? []).length === 0, vazamento("anon enxergou catálogo Martin Brower"));
  });

  // ===================================================================
  // PARTE 2 — CAMADA DE APLICAÇÃO (repositório e sync REAIS)
  // É esta camada que protege em produção, já que o backend usa service_role.
  // ===================================================================

  it("APP: repositório recusa consulta sem organizacao_id ou unidade_id", async () => {
    // Falha SEGURA: erro explícito em vez de rodar sem filtro e devolver tudo.
    await assert.rejects(() => repo.listarProdutos({ organizacaoId: ctx.A1.orgId, unidadeId: null }),
      /Escopo de tenant ausente/, "sem unidadeId deveria falhar");
    await assert.rejects(() => repo.listarProdutos({ organizacaoId: null, unidadeId: ctx.A1.uniId }),
      /Escopo de tenant ausente/, "sem organizacaoId deveria falhar");
    await assert.rejects(() => repo.mapearProdutosExistentes({ organizacaoId: ctx.A1.orgId, unidadeId: null, clientId: "04532" }),
      /Escopo de tenant ausente/, "mapear sem unidadeId deveria falhar");
    await assert.rejects(() => repo.inserirHistoricoPrecos({ organizacaoId: null, unidadeId: null, registros: [{}] }),
      /Escopo de tenant ausente/, "histórico sem tenant deveria falhar");
  });

  it("APP: importação em A1 cria produtos, ignora uniforme e não gera histórico de item novo", async () => {
    const r = await processarCatalogo({
      organizacaoId: ctx.A1.orgId, unidadeId: ctx.A1.uniId, clientId: ctx.A1.clientId,
      orderId: 900001, payload: catalogo(486.01), sincronizacaoId: ctx.A1.sincId,
    });

    assert.equal(r.produtosEncontrados, 3);
    assert.equal(r.produtosValidos, 2, "bacon + guardanapo");
    assert.equal(r.produtosIgnorados, 1, "a camiseta deve ser ignorada pelo filtro");
    assert.equal(r.produtosAtualizados, 1, "o bacon já existia (semeado no setup)");
    assert.equal(r.produtosCriados, 2, "guardanapo e camiseta são novos");
    assert.equal(r.precosAlterados, 1, "só o bacon tinha preço anterior (100 -> 486,01)");

    // A camiseta foi GRAVADA, não descartada — com motivo auditável.
    const { data: camiseta } = await admin.from("martin_brower_produtos")
      .select("ignorado, motivo_ignorado, regra_ignorado")
      .eq("unidade_id", ctx.A1.uniId).eq("codigo", "5000101").single();
    assert.equal(camiseta.ignorado, true);
    assert.ok(camiseta.motivo_ignorado, "item ignorado precisa de motivo");
    assert.equal(camiseta.regra_ignorado, "padrao:familia");
  });

  it("APP: a importação de A1 NÃO tocou em A2 nem em C", async () => {
    // Mesmo código '1001088' nas três unidades, com preços distintos.
    const { data, error } = await admin.from("martin_brower_produtos")
      .select("unidade_id, preco").eq("codigo", "1001088")
      .in("unidade_id", [ctx.A1.uniId, ctx.A2.uniId, ctx.C.uniId]);
    assert.ifError(error);

    const porUnidade = Object.fromEntries(data.map((r) => [r.unidade_id, Number(r.preco)]));
    assert.equal(porUnidade[ctx.A1.uniId], 486.01, "A1 deveria ter sido atualizada");
    assert.equal(porUnidade[ctx.A2.uniId], 200, vazamento("a importação de A1 alterou o preço de A2"));
    assert.equal(porUnidade[ctx.C.uniId], 300, vazamento("a importação de A1 alterou o preço de C"));

    // E nenhum produto novo escapou para as outras unidades.
    const { data: guardanapos } = await admin.from("martin_brower_produtos")
      .select("unidade_id").eq("codigo", "0002045");
    assert.ok(guardanapos.every((g) => g.unidade_id === ctx.A1.uniId),
      vazamento("produto criado em A1 apareceu em outra unidade"));
  });

  it("APP: histórico da alteração ficou só em A1, com valor e percentual corretos", async () => {
    const { data, error } = await admin.from("martin_brower_precos_historico")
      .select("unidade_id, preco_anterior, preco_novo, alteracao_valor, alteracao_percentual")
      .eq("sincronizacao_id", ctx.A1.sincId).eq("codigo", "1001088");
    assert.ifError(error);
    assert.equal(data.length, 1, "deveria haver exatamente 1 registro de alteração");

    const h = data[0];
    assert.equal(h.unidade_id, ctx.A1.uniId, vazamento("histórico gravado na unidade errada"));
    assert.equal(Number(h.preco_anterior), 100);
    assert.equal(Number(h.preco_novo), 486.01);
    assert.equal(Number(h.alteracao_valor), 386.01);
    assert.equal(Number(h.alteracao_percentual), 386.01);
  });

  it("APP: reimportar com o MESMO preço não duplica produto nem gera histórico", async () => {
    const { count: antes } = await admin.from("martin_brower_precos_historico")
      .select("id", { count: "exact", head: true }).eq("unidade_id", ctx.A1.uniId);

    const r = await processarCatalogo({
      organizacaoId: ctx.A1.orgId, unidadeId: ctx.A1.uniId, clientId: ctx.A1.clientId,
      orderId: 900002, payload: catalogo(486.01), sincronizacaoId: ctx.A1.sincId,
    });
    assert.equal(r.precosAlterados, 0, "preço igual não pode gerar histórico");
    assert.equal(r.produtosCriados, 0, "nada novo na segunda passada");
    assert.equal(r.produtosAtualizados, 3);

    const { count: depois } = await admin.from("martin_brower_precos_historico")
      .select("id", { count: "exact", head: true }).eq("unidade_id", ctx.A1.uniId);
    assert.equal(depois, antes, "histórico não pode crescer sem mudança de preço");

    // Sem duplicata: a chave única (org+unidade+client+codigo) segurou.
    const { count: bacons } = await admin.from("martin_brower_produtos")
      .select("id", { count: "exact", head: true }).eq("unidade_id", ctx.A1.uniId).eq("codigo", "1001088");
    assert.equal(bacons, 1, "produto duplicou");
  });

  it("APP: queda de preço em A2 é registrada em A2 e não afeta A1", async () => {
    const r = await processarCatalogo({
      organizacaoId: ctx.A2.orgId, unidadeId: ctx.A2.uniId, clientId: ctx.A2.clientId,
      orderId: 900003, payload: catalogo(150), sincronizacaoId: ctx.A2.sincId,
    });
    assert.equal(r.precosAlterados, 1);

    const { data: hist } = await admin.from("martin_brower_precos_historico")
      .select("unidade_id, alteracao_valor").eq("sincronizacao_id", ctx.A2.sincId).eq("codigo", "1001088");
    assert.equal(hist.length, 1);
    assert.equal(hist[0].unidade_id, ctx.A2.uniId);
    assert.equal(Number(hist[0].alteracao_valor), -50, "200 -> 150");

    // A1 continua com o preço da própria importação.
    const { data: a1 } = await admin.from("martin_brower_produtos")
      .select("preco").eq("unidade_id", ctx.A1.uniId).eq("codigo", "1001088").single();
    assert.equal(Number(a1.preco), 486.01, vazamento("a importação de A2 alterou A1"));
  });

  it("APP: produto que sumiu do catálogo é SINALIZADO, nunca excluído", async () => {
    // Catálogo só com o guardanapo: o bacon "sumiu".
    const semBacon = catalogo(486.01);
    semBacon.data.groups[0].itens = semBacon.data.groups[0].itens.filter(
      (i) => i.appClientProduct.product.code === "0002045");

    await processarCatalogo({
      organizacaoId: ctx.A1.orgId, unidadeId: ctx.A1.uniId, clientId: ctx.A1.clientId,
      orderId: 900004, payload: semBacon, sincronizacaoId: ctx.A1.sincId,
    });

    const { data, error } = await admin.from("martin_brower_produtos")
      .select("visto_na_ultima_sincronizacao").eq("unidade_id", ctx.A1.uniId).eq("codigo", "1001088").single();
    assert.ifError(error, "o produto ausente NÃO pode ter sido excluído");
    assert.equal(data.visto_na_ultima_sincronizacao, false, "deveria estar sinalizado como não visto");
  });

  it("APP: listarProdutos só devolve a unidade consultada", async () => {
    for (const u of [ctx.A1, ctx.A2, ctx.C]) {
      const linhas = await repo.listarProdutos({ organizacaoId: u.orgId, unidadeId: u.uniId, filtros: {} });
      assert.ok(linhas.length >= 1, `${u.email} deveria ter catálogo`);
      assert.ok(linhas.every((l) => l.unidade_id === u.uniId), vazamento("listarProdutos trouxe outra unidade"));
      assert.ok(linhas.every((l) => l.organizacao_id === u.orgId), vazamento("listarProdutos trouxe outra organização"));
    }
  });

  // ===================================================================
  // MIGRATION 018 — unicidade das regras de filtro com unidade_id NULL
  // ===================================================================

  // Nota: não dá para consultar pg_indexes via PostgREST, então provamos o
  // COMPORTAMENTO (que é o que importa) em vez da existência do índice.

  it("018: duas regras de ORGANIZAÇÃO semanticamente iguais (unidade_id NULL) não coexistem", async () => {
    const regra = {
      organizacao_id: ctx.orgA, unidade_id: null,
      tipo: "palavra_chave", valor: `uniforme_${tag}`, acao: "ignorar",
    };

    const { error: e1 } = await admin.from("martin_brower_filtros").insert(regra);
    assert.ifError(e1, "a primeira regra deveria ser aceita");

    // Sem a 018, o Postgres aceitaria esta segunda linha (NULL != NULL).
    const { error: e2 } = await admin.from("martin_brower_filtros").insert(regra);
    assert.ok(e2, "DUPLICATA ACEITA: a migration 018 não foi aplicada neste banco");
    assert.match(e2.message, /duplicate|unique/i);
  });

  it("018: regras DIFERENTES continuam permitidas", async () => {
    const base = { organizacao_id: ctx.orgA, unidade_id: null, acao: "ignorar" };
    const variacoes = [
      { ...base, tipo: "palavra_chave", valor: `avental_${tag}` },   // outro valor
      { ...base, tipo: "grupo", valor: `uniforme_${tag}` },          // outro tipo
      { ...base, tipo: "familia", valor: `UNI_${tag}` },
    ];
    for (const v of variacoes) {
      const { error } = await admin.from("martin_brower_filtros").insert(v);
      assert.ifError(error, `regra distinta deveria ser aceita: ${v.tipo}/${v.valor}`);
    }
  });

  it("018: a mesma regra em ORGANIZAÇÕES diferentes continua permitida", async () => {
    const regra = (orgId) => ({
      organizacao_id: orgId, unidade_id: null,
      tipo: "palavra_chave", valor: `compartilhada_${tag}`, acao: "ignorar",
    });
    const { error: eA } = await admin.from("martin_brower_filtros").insert(regra(ctx.orgA));
    assert.ifError(eA);
    // organizacao_id é a PRIMEIRA coluna do índice: tenants nunca colidem.
    const { error: eB } = await admin.from("martin_brower_filtros").insert(regra(ctx.orgB));
    assert.ifError(eB, "ISOLAMENTO QUEBRADO: a regra de B colidiu com a de A");
  });

  it("018: a mesma regra em UNIDADES diferentes da mesma organização continua permitida", async () => {
    const regra = (uniId) => ({
      organizacao_id: ctx.orgA, unidade_id: uniId,
      tipo: "codigo", valor: `9999_${tag}`, acao: "ignorar",
    });
    const { error: e1 } = await admin.from("martin_brower_filtros").insert(regra(ctx.A1.uniId));
    assert.ifError(e1);
    const { error: e2 } = await admin.from("martin_brower_filtros").insert(regra(ctx.A2.uniId));
    assert.ifError(e2, "ISOLAMENTO QUEBRADO: a regra de A2 colidiu com a de A1");

    // E a MESMA regra repetida na MESMA unidade deve ser recusada.
    const { error: e3 } = await admin.from("martin_brower_filtros").insert(regra(ctx.A1.uniId));
    assert.ok(e3, "duplicata dentro da mesma unidade deveria ser recusada");
  });

  it("018: regra de ORGANIZAÇÃO e regra de UNIDADE com mesmo tipo/valor coexistem", async () => {
    // São escopos diferentes: a da unidade é um refinamento da regra da org.
    // Índices parciais separados permitem isso; um coalesce com sentinela
    // também permitiria, mas ao custo de um UUID mágico.
    const comum = { organizacao_id: ctx.orgA, tipo: "descricao", valor: `escopos_${tag}`, acao: "ignorar" };
    const { error: eOrg } = await admin.from("martin_brower_filtros").insert({ ...comum, unidade_id: null });
    assert.ifError(eOrg);
    const { error: eUni } = await admin.from("martin_brower_filtros").insert({ ...comum, unidade_id: ctx.A1.uniId });
    assert.ifError(eUni, "regra de unidade deveria poder refinar a regra da organização");
  });

  it("018: RLS continua valendo — UA1 não vê regras de outra organização", async () => {
    const { data, error } = await ctx.A1.cli.from("martin_brower_filtros").select("id, organizacao_id, unidade_id");
    assert.ifError(error);
    assert.ok(data.every((r) => r.organizacao_id === ctx.orgA), vazamento("UA1 viu regra da organização B"));
    // Regras da organização (unidade_id null) SÃO visíveis — é o projetado.
    assert.ok(data.every((r) => r.unidade_id === null || r.unidade_id === ctx.A1.uniId),
      vazamento("UA1 viu regra específica de outra unidade"));
  });

  // ===================================================================
  // MIGRATION 019 — client_id como TEXT + idempotência por request_id
  // ===================================================================

  it("019: clientId com ZERO À ESQUERDA é preservado exatamente", async () => {
    // A unidade A1 foi criada com "04532". Se a coluna ainda fosse bigint,
    // teria virado 4532 e este teste falharia — é o motivo da migration.
    const { data, error } = await admin.from("martin_brower_integracoes")
      .select("client_id").eq("unidade_id", ctx.A1.uniId).single();
    assert.ifError(error);
    assert.equal(data.client_id, "04532", "o zero à esquerda foi perdido — client_id ainda é numérico?");
    assert.equal(typeof data.client_id, "string");
  });

  it("019: valor longo não perde precisão", async () => {
    // Acima de Number.MAX_SAFE_INTEGER, bigint→JS já arredondaria.
    const longo = "90071992547409911234";
    const { data, error } = await admin.from("martin_brower_produtos").insert({
      organizacao_id: ctx.A1.orgId, unidade_id: ctx.A1.uniId, client_id: longo,
      codigo: `longo_${tag}`, descricao: "TESTE VALOR LONGO", preco: 1,
    }).select("client_id").single();
    assert.ifError(error);
    assert.equal(data.client_id, longo, "precisão perdida na ida ou na volta");
  });

  it("019: valores puramente numéricos antigos continuam legíveis", async () => {
    // A2 e C usam "7788" e "9911" — o formato de antes da migration.
    for (const u of [ctx.A2, ctx.C]) {
      const { data, error } = await admin.from("martin_brower_integracoes")
        .select("client_id").eq("unidade_id", u.uniId).single();
      assert.ifError(error);
      assert.equal(String(data.client_id), String(u.clientId));
    }
  });

  it("019: o MESMO clientId pode existir em organizações diferentes", async () => {
    // Duas empresas podem, legitimamente, ter o mesmo código na distribuidora?
    // A regra atual é por (organizacao, unidade, client_id) — então sim.
    const compartilhado = `77${tag.slice(-6)}`;
    for (const [orgId, uniId] of [[ctx.orgA, ctx.A1.uniId], [ctx.orgB, ctx.C.uniId]]) {
      const { error } = await admin.from("martin_brower_produtos").insert({
        organizacao_id: orgId, unidade_id: uniId, client_id: compartilhado,
        codigo: `compart_${tag}`, descricao: "MESMO CLIENTID EM ORGS DIFERENTES", preco: 10,
      });
      assert.ifError(error, vazamento(`org ${orgId} nao aceitou clientId compartilhado`));
    }
  });

  it("019: unidades diferentes da MESMA organização não interferem", async () => {
    const mesmo = `88${tag.slice(-6)}`;
    for (const uniId of [ctx.A1.uniId, ctx.A2.uniId]) {
      const { error } = await admin.from("martin_brower_produtos").insert({
        organizacao_id: ctx.orgA, unidade_id: uniId, client_id: mesmo,
        codigo: `entreunidades_${tag}`, descricao: "MESMO CLIENTID EM UNIDADES DIFERENTES", preco: 10,
      });
      assert.ifError(error, vazamento("unidades da mesma org colidiram"));
    }
  });

  it("019: a unicidade original continua valendo (org+unidade+client+codigo)", async () => {
    const linha = {
      organizacao_id: ctx.A1.orgId, unidade_id: ctx.A1.uniId, client_id: ctx.A1.clientId,
      codigo: `unico_${tag}`, descricao: "TESTE UNICIDADE", preco: 5,
    };
    const { error: e1 } = await admin.from("martin_brower_produtos").insert(linha);
    assert.ifError(e1);
    const { error: e2 } = await admin.from("martin_brower_produtos").insert(linha);
    assert.ok(e2, "a constraint de unicidade sumiu na conversão de tipo");
    assert.match(e2.message, /duplicate|unique/i);
  });

  it("019: '04532' e '4532' passam a ser clientIds DIFERENTES", async () => {
    // Consequência direta e desejada de tratar como identificador.
    const { error } = await admin.from("martin_brower_produtos").insert({
      organizacao_id: ctx.A1.orgId, unidade_id: ctx.A1.uniId,
      client_id: "4532",                     // sem o zero — outra loja
      codigo: "1001088",                     // MESMO código de produto
      descricao: "BACON — OUTRO CLIENTID", preco: 99,
    });
    assert.ifError(error, "sem o zero à esquerda deveria ser outra chave, não colisão");
  });

  // --- idempotência ---------------------------------------------------

  it("019: request_id DUPLICADO na mesma organização e unidade é rejeitado", async () => {
    const req = `req_${tag}_dup`;
    const linha = {
      organizacao_id: ctx.A1.orgId, unidade_id: ctx.A1.uniId,
      client_id: ctx.A1.clientId, status: "concluido", request_id: req,
    };
    const { error: e1 } = await admin.from("martin_brower_sincronizacoes").insert(linha);
    assert.ifError(e1, "a primeira deveria passar");

    const { error: e2 } = await admin.from("martin_brower_sincronizacoes").insert(linha);
    assert.ok(e2, "DUPLICATA ACEITA: o índice de idempotência não foi criado (migration 019)");
    assert.match(e2.message, /duplicate|unique/i);
  });

  it("019: o mesmo request_id é permitido em ORGANIZAÇÃO diferente", async () => {
    const req = `req_${tag}_orgs`;
    for (const u of [ctx.A1, ctx.C]) {
      const { error } = await admin.from("martin_brower_sincronizacoes").insert({
        organizacao_id: u.orgId, unidade_id: u.uniId,
        client_id: u.clientId, status: "concluido", request_id: req,
      });
      assert.ifError(error, vazamento("idempotência atravessou a fronteira de organização"));
    }
  });

  it("019: o mesmo request_id é permitido em UNIDADE diferente", async () => {
    const req = `req_${tag}_unidades`;
    for (const u of [ctx.A1, ctx.A2]) {
      const { error } = await admin.from("martin_brower_sincronizacoes").insert({
        organizacao_id: u.orgId, unidade_id: u.uniId,
        client_id: u.clientId, status: "concluido", request_id: req,
      });
      assert.ifError(error, vazamento("idempotência atravessou a fronteira de unidade"));
    }
  });

  it("019: registros antigos com request_id NULO continuam válidos e múltiplos", async () => {
    // O índice é PARCIAL (where request_id is not null). Sincronizações do
    // worker e da importação manual não têm requestId e coexistem à vontade.
    for (let i = 0; i < 3; i += 1) {
      const { error } = await admin.from("martin_brower_sincronizacoes").insert({
        organizacao_id: ctx.A1.orgId, unidade_id: ctx.A1.uniId,
        client_id: ctx.A1.clientId, status: "concluido", origem: "importacao_manual",
      });
      assert.ifError(error, "NULL não pode colidir com NULL no índice parcial");
    }
  });

  it("019: a conversão não alterou preços, códigos nem histórico", async () => {
    // O bacon de A1 passou por duas importações no bloco APP: 100 → 486,01.
    const { data: prod, error: eP } = await admin.from("martin_brower_produtos")
      .select("codigo, preco, descricao")
      .eq("unidade_id", ctx.A1.uniId).eq("client_id", ctx.A1.clientId).eq("codigo", "1001088").single();
    assert.ifError(eP);
    assert.equal(prod.codigo, "1001088", "código de PRODUTO é outro campo — não pode ter sido tocado");
    assert.equal(Number(prod.preco), 486.01, "preço alterado pela migration");

    const { data: hist, error: eH } = await admin.from("martin_brower_precos_historico")
      .select("codigo, preco_anterior, preco_novo, client_id")
      .eq("unidade_id", ctx.A1.uniId).eq("codigo", "1001088").order("coletado_em").limit(1).single();
    assert.ifError(eH);
    assert.equal(Number(hist.preco_anterior), 100);
    assert.equal(Number(hist.preco_novo), 486.01);
    assert.equal(typeof hist.client_id, "string", "client_id do histórico também virou text");
  });

  it("019: zeros à esquerda do CÓDIGO DO PRODUTO seguem preservados", async () => {
    // Regressão: clientId e código do produto são identificadores DIFERENTES.
    // A migration não podia confundir um com o outro.
    const { data, error } = await admin.from("martin_brower_produtos")
      .select("codigo").eq("unidade_id", ctx.A1.uniId).eq("codigo", "0002045").maybeSingle();
    assert.ifError(error);
    assert.ok(data, "o guardanapo '0002045' sumiu");
    assert.equal(data.codigo, "0002045");
  });

  it("APP: vínculo recusa produto ou insumo de outro tenant", async () => {
    // Produto de A2 com o tenant de A1: o repositório confere os DOIS lados.
    await assert.rejects(() => repo.criarVinculo({
      organizacaoId: ctx.A1.orgId, unidadeId: ctx.A1.uniId,
      mbProdutoId: ctx.A2.produtoId, insumoId: ctx.A1.insumoId, confirmadoPor: ctx.A1.uid,
    }), /não encontrado/, "vincular produto de outra unidade deveria falhar");

    // Insumo da organização B com o tenant de A1.
    await assert.rejects(() => repo.criarVinculo({
      organizacaoId: ctx.A1.orgId, unidadeId: ctx.A1.uniId,
      mbProdutoId: ctx.A1.produtoId, insumoId: ctx.C.insumoId, confirmadoPor: ctx.A1.uid,
    }), /não encontrado/, "vincular insumo de outra organização deveria falhar");
  });
});
