// =====================================================================
// TESTE DE INTEGRAÇÃO — Estrutura Organizacional (Fase D: promover/
// converter/transferir) — database/migrations/053_estrutura_organizacional.sql
// =====================================================================
// Prova, contra um Supabase/Postgres REAL, que as três operações estruturais
// preservam integralmente o que prometem preservar — não só "a tela
// funciona": conta registros ANTES e DEPOIS em cada tabela que a Fase D
// toca (catálogo, Dashboard Executivo, Bonificação, Parser Food Delivery,
// Martin Brower, vínculos de usuário, auditoria) e confirma que nenhum ID
// que devia sobreviver mudou, e que nenhuma linha some silenciosamente.
//
// SEGURANÇA — NUNCA use produção
//   * Só roda com TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_ROLE_KEY /
//     TEST_SUPABASE_ANON_KEY definidas. Sem elas, é PULADO (npm test fica verde).
//   * Recusa rodar se TEST_SUPABASE_URL == SUPABASE_URL (parece produção).
//   * Exige ISOLATION_TEST_DISPOSABLE=1 (mesma guarda de isolamento-tenant.test.js
//     — este teste também cria e apaga organizações/unidades/dados reais).
//   * Antes de qualquer coisa, confirma que a migration 053 foi aplicada no
//     alvo (chama uma das funções com um id inexistente — se a função não
//     existir, PULA com uma mensagem clara em vez de falhar confuso).
//
// PRÉ-REQUISITO: o Supabase/Postgres de teste precisa do schema completo +
//   todas as migrations até 053 (em especial 012, 013, 017, 023, 028, 030,
//   034, 037, 048, 049, 052 — são as tabelas que este teste povoa).
//
// COMO RODAR
//   node --env-file=.env.test --test test/estrutura-organizacional.test.js
//   (ou: npm run test:estrutura)
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
const TEM_ENV = Boolean(URL && SERVICE && ANON);
const APONTA_PROD = TEM_ENV && process.env.SUPABASE_URL && URL === process.env.SUPABASE_URL;
const CONFIRMA_DESCARTAVEL = process.env.ISOLATION_TEST_DISPOSABLE === "1";

const motivoSkipBase = motivoParaPular({
  url: URL, service: SERVICE, anon: ANON,
  urlProducao: process.env.SUPABASE_URL,
  confirmaDescartavel: CONFIRMA_DESCARTAVEL,
});

const opts = { auth: { persistSession: false, autoRefreshToken: false } };

describe("Estrutura Organizacional — promover/converter/transferir (migration 053)", { skip: motivoSkipBase }, () => {
  const admin = createClient(URL, SERVICE, opts);
  const tag = `estr_${Date.now()}`;
  const criados = { organizacoes: new Set(), auth: new Set() };

  // ---- helpers de fixture -------------------------------------------------

  async function criarOrg(nome, extra = {}) {
    const { data, error } = await admin.from("organizacoes")
      .insert({ nome: `${nome} ${tag}`, status: "ativa", ativo: true, ...extra })
      .select("id, nome").single();
    assert.ifError(error);
    criados.organizacoes.add(data.id);
    return data;
  }

  async function criarUnidade(orgId, nome) {
    const { data, error } = await admin.from("unidades")
      .insert({ organizacao_id: orgId, nome: `${nome} ${tag}` }).select("id, nome").single();
    assert.ifError(error);
    return data;
  }

  async function criarUsuarioAutenticado(sufixo) {
    const email = `${tag}_${sufixo}@example.com`.toLowerCase();
    const { data, error } = await admin.auth.admin.createUser({
      email, password: `Estr-${tag}-Xx1!`, email_confirm: true,
    });
    assert.ifError(error);
    criados.auth.add(data.user.id);
    return data.user.id;
  }

  async function contar(tabela, coluna, valor) {
    const { count, error } = await admin.from(tabela).select("id", { count: "exact", head: true }).eq(coluna, valor);
    assert.ifError(error);
    return count ?? 0;
  }

  async function linha(tabela, id) {
    const { data, error } = await admin.from(tabela).select("*").eq("id", id).maybeSingle();
    assert.ifError(error);
    return data;
  }

  /** Monta uma unidade "cheia": catálogo próprio da empresa + um registro em
   * cada módulo que a Fase D promete preservar (Dashboard Executivo,
   * Bonificação, Parser FD, Vendas/SW, Martin Brower, vínculos, sessão). */
  async function montarFixtureCompleta(rotuloOrg) {
    const org = await criarOrg(`Org ${rotuloOrg}`);
    const u1 = await criarUnidade(org.id, "Unidade Principal");
    const u2 = await criarUnidade(org.id, "Unidade Irmã"); // prova que o sibling NÃO é tocado

    // Catálogo
    const { data: cat, error: eCat } = await admin.from("categorias")
      .insert({ organizacao_id: org.id, nome: `Cat ${tag}`, tipo: "produto" }).select("id").single();
    assert.ifError(eCat);
    const { data: insumos, error: eIns } = await admin.from("insumos").insert([
      { organizacao_id: org.id, categoria_id: cat.id, nome: `Insumo1 ${tag}`, unidade_medida: "g", preco_unitario: 1 },
      { organizacao_id: org.id, nome: `Insumo2 ${tag}`, unidade_medida: "un", preco_unitario: 2 },
    ]).select("id");
    assert.ifError(eIns);
    const [ins1, ins2] = insumos;
    // vendavel precisa estar explícito nas DUAS linhas: um insert em lote com
    // objetos de chaves diferentes faz o PostgREST mandar `null` (não omitir
    // a coluna) pra linha que não especificou — e vendavel é not null sem
    // default aplicável nesse caminho, o que já pegou um bug real aqui.
    const { data: produtos, error: eProd } = await admin.from("produtos").insert([
      { organizacao_id: org.id, categoria_id: cat.id, nome: `Produto1 ${tag}`, sku: `SKU1-${tag}`, vendavel: true },
      { organizacao_id: org.id, nome: `Produto2 ${tag}`, sku: `SKU2-${tag}`, vendavel: false },
    ]).select("id");
    assert.ifError(eProd);
    const [prod1, prod2] = produtos;
    const { error: eFicha } = await admin.from("ficha_tecnica")
      .insert({ produto_id: prod1.id, insumo_id: ins1.id, quantidade: 10 });
    assert.ifError(eFicha);
    const { error: ePreco } = await admin.from("produto_precos")
      .insert({ produto_id: prod1.id, canal: "balcao", preco: 19.9 });
    assert.ifError(ePreco);

    // Módulos
    const { error: eOm } = await admin.from("organizacao_modulos")
      .insert([{ organizacao_id: org.id, modulo_id: "dashboard" }, { organizacao_id: org.id, modulo_id: "sales" }]);
    assert.ifError(eOm);
    const { error: eUm } = await admin.from("unidade_modulos")
      .insert([{ unidade_id: u1.id, modulo_id: "dashboard" }, { unidade_id: u1.id, modulo_id: "sales" }]);
    assert.ifError(eUm);

    // Dashboard Executivo
    const { data: lanc, error: eLanc } = await admin.from("lancamentos_financeiros_diarios")
      .insert({ organizacao_id: org.id, unidade_id: u1.id, data_lancamento: "2026-01-10", status: "rascunho" })
      .select("id").single();
    assert.ifError(eLanc);

    // Bonificação Mensal
    const { data: bonif, error: eBonif } = await admin.from("bonificacao_lancamentos_diarios")
      .insert({ organizacao_id: org.id, unidade_id: u1.id, data: "2026-01-10", faturamento_geral: 1000 })
      .select("id").single();
    assert.ifError(eBonif);

    // Parser Food Delivery
    const { data: parserImp, error: eParserImp } = await admin.from("parser_fd_importacoes")
      .insert({
        organizacao_id: org.id, unidade_id: u1.id, periodo_inicio: "2026-01-01", periodo_fim: "2026-01-10",
        hash_arquivo: `hash-${tag}`,
      }).select("id").single();
    assert.ifError(eParserImp);
    const { data: parserPed, error: eParserPed } = await admin.from("parser_fd_pedidos")
      .insert({
        importacao_id: parserImp.id, organizacao_id: org.id, unidade_id: u1.id, numero_pedido: "0001",
        status_conciliacao: "incluido", dados_brutos: { linha: 1 },
      }).select("id").single();
    assert.ifError(eParserPed);

    // Vendas / SWFast — mapeamento (org) + combo (org) + histórico já importado (unidade)
    const { error: eSwMap } = await admin.from("sw_mapeamento_produtos")
      .insert({ organizacao_id: org.id, codigo_sw: `COD1-${tag}`, tipo_item: "produto", produto_id: prod1.id });
    assert.ifError(eSwMap);
    const { error: eSwCombo } = await admin.from("sw_combo_componentes")
      .insert({ organizacao_id: org.id, codigo_sw: `COMBO1-${tag}`, produto_id: prod2.id, quantidade: 1 });
    assert.ifError(eSwCombo);
    const { data: swVend, error: eSwVend } = await admin.from("sw_produtos_vendidos")
      .insert({ unidade_id: u1.id, data_movimento: "2026-01-10", codigo_sw: `COD1-${tag}`, produto_id: prod1.id, quantidade: 3, valor_total: 30 })
      .select("id").single();
    assert.ifError(eSwVend);

    // Martin Brower — integração -> produto MB -> vínculo com insumo
    const { data: mbInteg, error: eMbInteg } = await admin.from("martin_brower_integracoes")
      .insert({ organizacao_id: org.id, unidade_id: u1.id, client_id: 555001 }).select("id").single();
    assert.ifError(eMbInteg);
    const { data: mbProd, error: eMbProd } = await admin.from("martin_brower_produtos")
      .insert({ organizacao_id: org.id, unidade_id: u1.id, client_id: 555001, codigo: `MB-${tag}`, descricao: "Item MB teste" })
      .select("id").single();
    assert.ifError(eMbProd);
    const { data: mbVinc, error: eMbVinc } = await admin.from("martin_brower_vinculos")
      .insert({ organizacao_id: org.id, unidade_id: u1.id, mb_produto_id: mbProd.id, insumo_id: ins1.id })
      .select("id").single();
    assert.ifError(eMbVinc);

    // Vínculos de usuário: um no nível da EMPRESA (deve ganhar acesso à nova
    // empresa na promoção), outro ESPECÍFICO da unidade (não deve mudar nada).
    const userEmpresa = await criarUsuarioAutenticado(`${rotuloOrg}emp`);
    const userUnidade = await criarUsuarioAutenticado(`${rotuloOrg}uni`);
    const { error: eUo } = await admin.from("usuarios_organizacoes")
      .insert({ usuario_id: userEmpresa, organizacao_id: org.id, papel: "organization_admin" });
    assert.ifError(eUo);
    const { error: eUu } = await admin.from("usuarios_unidades")
      .insert({ usuario_id: userUnidade, unidade_id: u1.id, papel: "operations" });
    assert.ifError(eUu);

    // Sessão viva presa à unidade — prova de revogação.
    const { data: sessao, error: eSessao } = await admin.from("sessoes_contexto")
      .insert({
        usuario_id: userUnidade, organizacao_id: org.id, unidade_id: u1.id, papel: "operations",
        permissoes: [], modulos: [], expira_em: new Date(Date.now() + 3600_000).toISOString(),
      }).select("id").single();
    assert.ifError(eSessao);

    return {
      org, u1, u2, cat, ins1, ins2, prod1, prod2,
      lancId: lanc.id, bonifId: bonif.id, parserImpId: parserImp.id, parserPedId: parserPed.id,
      swVendId: swVend.id, mbVincId: mbVinc.id, userEmpresa, userUnidade, sessaoId: sessao.id,
    };
  }

  before(async () => {
    await verificarCredencial(admin, SERVICE);
    await verificarTabelas(admin, [
      "organizacoes", "unidades", "categorias", "insumos", "produtos", "ficha_tecnica", "produto_precos",
      "organizacao_modulos", "unidade_modulos", "lancamentos_financeiros_diarios",
      "bonificacao_lancamentos_diarios", "parser_fd_importacoes", "parser_fd_pedidos",
      "sw_mapeamento_produtos", "sw_combo_componentes", "sw_produtos_vendidos",
      "martin_brower_integracoes", "martin_brower_produtos", "martin_brower_vinculos",
      "usuarios_organizacoes", "usuarios_unidades", "sessoes_contexto", "plataforma_auditoria",
    ]);

    // A migration 053 foi aplicada? Chama a função com um id inexistente —
    // função ausente e "unidade não encontrada" dão erros DIFERENTES e
    // reconhecíveis (PGRST202 vs P0002); só o segundo prova que a função existe.
    const idFalso = "00000000-0000-0000-0000-000000000000";
    const { error } = await admin.rpc("promover_unidade_para_empresa", {
      p_unidade_id: idFalso, p_nome_empresa: null, p_ator_id: idFalso,
    });
    if (!error || error.code !== "P0002") {
      throw new Error(
        "A migration 053_estrutura_organizacional.sql não parece estar aplicada no banco de teste " +
        `(esperava erro P0002 'Unidade não encontrada', recebi: ${error?.code ?? "nenhum erro"} ${error?.message ?? ""}). ` +
        "Aplique a migration no SQL Editor do projeto de teste antes de rodar.",
      );
    }
  });

  after(async () => {
    // Limpeza best-effort. Apagar a organização remove (cascade) unidades,
    // catálogo, lançamentos, bonificação, parser fd, vendas, MB, vínculos.
    for (const id of criados.auth) { try { await admin.auth.admin.deleteUser(id); } catch { /* ignora */ } }
    for (const id of criados.organizacoes) { try { await admin.from("organizacoes").delete().eq("id", id); } catch { /* ignora */ } }
  });

  // =========================================================================
  // PROMOVER — a mais arriscada: catálogo clonado + ~20 tabelas remapeadas.
  // =========================================================================
  it("promover: preserva ID/histórico da unidade, clona catálogo, remapeia SEM tocar no sibling nem na empresa antiga", async () => {
    const f = await montarFixtureCompleta("Prom");

    const antesQtdOrganizacoes = (await admin.from("organizacoes").select("id", { count: "exact", head: true })).count;
    const antesAuditoria = await contar("plataforma_auditoria", "entidade_id", f.u1.id);

    const { data: r, error } = await admin.rpc("promover_unidade_para_empresa", {
      p_unidade_id: f.u1.id, p_nome_empresa: `Promovida ${tag}`, p_ator_id: f.userEmpresa, p_ator_email: "super@teste.com",
    });
    assert.ifError(error);
    criados.organizacoes.add(r.novaOrganizacaoId); // pra limpeza no after

    // --- identidade preservada ---
    assert.notEqual(r.novaOrganizacaoId, f.org.id, "a empresa nova não pode ser a mesma que a antiga");
    const u1Depois = await linha("unidades", f.u1.id);
    assert.equal(u1Depois.id, f.u1.id, "o ID da unidade promovida deve ser o MESMO de antes");
    assert.equal(u1Depois.organizacao_id, r.novaOrganizacaoId, "a unidade deve apontar pra empresa nova");

    // --- sibling (u2) e empresa antiga NÃO tocados ---
    const u2Depois = await linha("unidades", f.u2.id);
    assert.equal(u2Depois.organizacao_id, f.org.id, "a unidade irmã não deveria ter sido movida");
    assert.equal((await admin.from("organizacoes").select("id", { count: "exact", head: true })).count, antesQtdOrganizacoes + 1,
      "só UMA organização nova deveria ter sido criada");

    // --- catálogo: empresa antiga preservada intacta, empresa nova com cópia ---
    assert.equal(await contar("categorias", "organizacao_id", f.org.id), 1, "categoria original não pode sumir");
    assert.equal(await contar("insumos", "organizacao_id", f.org.id), 2, "insumos originais não podem sumir");
    assert.equal(await contar("produtos", "organizacao_id", f.org.id), 2, "produtos originais não podem sumir");
    assert.equal(r.catalogo.categorias, 1);
    assert.equal(r.catalogo.insumos, 2);
    assert.equal(r.catalogo.produtos, 2);
    assert.equal(r.catalogo.fichaTecnica, 1);
    assert.equal(r.catalogo.precos, 1);
    assert.equal(await contar("categorias", "organizacao_id", r.novaOrganizacaoId), 1);
    assert.equal(await contar("insumos", "organizacao_id", r.novaOrganizacaoId), 2);
    assert.equal(await contar("produtos", "organizacao_id", r.novaOrganizacaoId), 2);

    // o produto clonado tem o MESMO nome mas um ID NOVO (nunca o do original)
    const { data: prodClonado } = await admin.from("produtos")
      .select("id").eq("organizacao_id", r.novaOrganizacaoId).ilike("nome", `Produto1 ${tag}%`).maybeSingle();
    assert.ok(prodClonado, "o produto deveria ter sido clonado pro catálogo novo");
    assert.notEqual(prodClonado.id, f.prod1.id, "o clone precisa ter um ID NOVO, nunca o mesmo do original");

    // --- histórico operacional: MESMO ID, organizacao_id remapeado ---
    const lancDepois = await linha("lancamentos_financeiros_diarios", f.lancId);
    assert.equal(lancDepois.id, f.lancId);
    assert.equal(lancDepois.unidade_id, f.u1.id);
    assert.equal(lancDepois.organizacao_id, r.novaOrganizacaoId, "Dashboard Executivo: organizacao_id tinha que remapear");

    const bonifDepois = await linha("bonificacao_lancamentos_diarios", f.bonifId);
    assert.equal(bonifDepois.id, f.bonifId);
    assert.equal(bonifDepois.organizacao_id, r.novaOrganizacaoId, "Bonificação: organizacao_id tinha que remapear");

    const parserImpDepois = await linha("parser_fd_importacoes", f.parserImpId);
    assert.equal(parserImpDepois.organizacao_id, r.novaOrganizacaoId, "Parser FD (importação): organizacao_id tinha que remapear");
    const parserPedDepois = await linha("parser_fd_pedidos", f.parserPedId);
    assert.equal(parserPedDepois.id, f.parserPedId);
    assert.equal(parserPedDepois.organizacao_id, r.novaOrganizacaoId, "Parser FD (pedido): organizacao_id tinha que remapear");

    // --- venda histórica remapeada pro produto CLONADO (rompe a dependência) ---
    const swVendDepois = await linha("sw_produtos_vendidos", f.swVendId);
    assert.equal(swVendDepois.id, f.swVendId, "a linha de venda histórica é a MESMA, só o produto_id remapeia");
    assert.equal(swVendDepois.unidade_id, f.u1.id);
    assert.notEqual(swVendDepois.produto_id, f.prod1.id, "produto_id não pode mais apontar pro catálogo antigo");

    // --- vínculo Martin Brower: organizacao_id E insumo_id remapeados juntos ---
    const mbVincDepois = await linha("martin_brower_vinculos", f.mbVincId);
    assert.equal(mbVincDepois.organizacao_id, r.novaOrganizacaoId);
    assert.notEqual(mbVincDepois.insumo_id, f.ins1.id, "insumo_id do vínculo MB não pode ficar preso ao catálogo antigo");

    // --- mapeamento SW/combo: empresa nova ganhou cópia, empresa antiga mantém a dela ---
    assert.equal(await contar("sw_mapeamento_produtos", "organizacao_id", f.org.id), 1, "mapeamento original preservado");
    assert.equal(await contar("sw_mapeamento_produtos", "organizacao_id", r.novaOrganizacaoId), 1, "mapeamento clonado pra empresa nova");
    assert.equal(await contar("sw_combo_componentes", "organizacao_id", r.novaOrganizacaoId), 1);

    // --- módulos: empresa nova herdou os da empresa-mãe ---
    const { data: modulosNovos } = await admin.from("organizacao_modulos").select("modulo_id").eq("organizacao_id", r.novaOrganizacaoId);
    assert.deepEqual(new Set(modulosNovos.map((m) => m.modulo_id)), new Set(["dashboard", "sales"]));

    // --- usuários: acesso de empresa preservado (equivalente na nova); acesso de unidade intocado ---
    const { data: vinculoNovo } = await admin.from("usuarios_organizacoes")
      .select("papel").eq("usuario_id", f.userEmpresa).eq("organizacao_id", r.novaOrganizacaoId).maybeSingle();
    assert.ok(vinculoNovo, "usuário com acesso de empresa deveria ganhar o mesmo acesso na empresa nova");
    assert.equal(vinculoNovo.papel, "organization_admin");
    const { data: vinculoUnidade } = await admin.from("usuarios_unidades")
      .select("id").eq("usuario_id", f.userUnidade).eq("unidade_id", f.u1.id).maybeSingle();
    assert.ok(vinculoUnidade, "vínculo específico de unidade não deveria ter sido tocado");

    // --- sessão revogada ---
    const sessaoDepois = await linha("sessoes_contexto", f.sessaoId);
    assert.ok(sessaoDepois.revogada_em, "sessão presa à unidade promovida deveria ter sido revogada");

    // --- auditoria: uma linha nova, com o "antes"/"depois" ---
    assert.equal(await contar("plataforma_auditoria", "entidade_id", f.u1.id), antesAuditoria + 1);
    const { data: auditRows } = await admin.from("plataforma_auditoria")
      .select("acao, detalhes").eq("entidade_id", f.u1.id).eq("acao", "unidade.promovida_para_empresa")
      .order("created_at", { ascending: false }).limit(1);
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].detalhes.de.organizacaoId, f.org.id);
    assert.equal(auditRows[0].detalhes.para.organizacaoId, r.novaOrganizacaoId);
  });

  // =========================================================================
  // ROLLBACK — nenhuma organização "órfã" pode sobrar se a operação falhar.
  // =========================================================================
  it("promover: unidade inexistente falha ANTES de criar qualquer coisa (nada fica órfão)", async () => {
    const antes = (await admin.from("organizacoes").select("id", { count: "exact", head: true })).count;
    const idFalso = "11111111-1111-1111-1111-111111111111";
    const { error } = await admin.rpc("promover_unidade_para_empresa", {
      p_unidade_id: idFalso, p_nome_empresa: "Não deveria existir", p_ator_id: idFalso,
    });
    assert.ok(error, "deveria falhar");
    assert.equal(error.code, "P0002");
    const depois = (await admin.from("organizacoes").select("id", { count: "exact", head: true })).count;
    assert.equal(depois, antes, "nenhuma organização deveria ter sido criada numa chamada que falhou");
    const { data: orfa } = await admin.from("organizacoes").select("id").eq("nome", "Não deveria existir");
    assert.equal(orfa.length, 0);
  });

  // =========================================================================
  // TRANSFERIR — mais simples: só organizacao_id muda, catálogo intocado.
  // =========================================================================
  it("transferir: preserva ID/histórico, remapeia tabelas operacionais, NÃO mexe no catálogo", async () => {
    const origem = await criarOrg("Origem Transf");
    const destino = await criarOrg("Destino Transf");
    const uni = await criarUnidade(origem.id, "Unidade Móvel");
    const { data: lanc } = await admin.from("lancamentos_financeiros_diarios")
      .insert({ organizacao_id: origem.id, unidade_id: uni.id, data_lancamento: "2026-02-01", status: "rascunho" })
      .select("id").single();

    const { data: r, error } = await admin.rpc("transferir_unidade_organizacao", {
      p_unidade_id: uni.id, p_nova_organizacao_id: destino.id, p_ator_id: "22222222-2222-2222-2222-222222222222",
    });
    assert.ifError(error);

    const uniDepois = await linha("unidades", uni.id);
    assert.equal(uniDepois.id, uni.id, "ID da unidade transferida não pode mudar");
    assert.equal(uniDepois.organizacao_id, destino.id);

    const lancDepois = await linha("lancamentos_financeiros_diarios", lanc.id);
    assert.equal(lancDepois.id, lanc.id);
    assert.equal(lancDepois.organizacao_id, destino.id, "Dashboard Executivo deveria remapear na transferência também");

    assert.equal(r.novaOrganizacaoId, destino.id);
    assert.equal(r.organizacaoAnteriorId, origem.id);
  });

  it("transferir: recusa mover para a mesma empresa", async () => {
    const org = await criarOrg("Mesma Empresa");
    const uni = await criarUnidade(org.id, "Unidade");
    const { error } = await admin.rpc("transferir_unidade_organizacao", {
      p_unidade_id: uni.id, p_nova_organizacao_id: org.id, p_ator_id: "33333333-3333-3333-3333-333333333333",
    });
    assert.ok(error);
    assert.equal(error.code, "22023");
  });

  // =========================================================================
  // CONVERTER — só permitido com zero unidades próprias.
  // =========================================================================
  it("converter: empresa sem unidades vira unidade da empresa-mãe, preserva vínculos de usuário, arquiva sem apagar", async () => {
    const mae = await criarOrg("Empresa Mae");
    const vazia = await criarOrg("Empresa Vazia");
    const usuarioEmpresa = await criarUsuarioAutenticado("convemp");
    await admin.from("usuarios_organizacoes").insert({ usuario_id: usuarioEmpresa, organizacao_id: vazia.id, papel: "viewer" });

    const { data: r, error } = await admin.rpc("converter_empresa_para_unidade", {
      p_organizacao_id: vazia.id, p_empresa_mae_id: mae.id, p_ator_id: "44444444-4444-4444-4444-444444444444",
    });
    assert.ifError(error);

    const novaUnidade = await linha("unidades", r.novaUnidadeId);
    assert.equal(novaUnidade.organizacao_id, mae.id);

    const vinculoUnidade = await admin.from("usuarios_unidades")
      .select("papel").eq("usuario_id", usuarioEmpresa).eq("unidade_id", r.novaUnidadeId).maybeSingle();
    assert.ok(vinculoUnidade.data, "usuário com acesso de empresa deveria ganhar acesso à unidade nova");
    assert.equal(vinculoUnidade.data.papel, "viewer");

    // Arquivada, não apagada.
    const orgDepois = await linha("organizacoes", vazia.id);
    assert.ok(orgDepois, "a empresa convertida precisa CONTINUAR existindo (dados preservados)");
    assert.equal(orgDepois.status, "cancelada");
    assert.equal(orgDepois.ativo, false);
  });

  it("converter: recusa quando a empresa tem unidade própria", async () => {
    const mae = await criarOrg("Mae Recusa");
    const comUnidade = await criarOrg("Com Unidade");
    await criarUnidade(comUnidade.id, "Unidade Existente");

    const { error } = await admin.rpc("converter_empresa_para_unidade", {
      p_organizacao_id: comUnidade.id, p_empresa_mae_id: mae.id, p_ator_id: "55555555-5555-5555-5555-555555555555",
    });
    assert.ok(error, "deveria recusar — a empresa ainda tem unidade própria");
    assert.equal(error.code, "22023");

    // Nada foi alterado: a empresa continua ativa, não virou unidade de ninguém.
    const orgDepois = await linha("organizacoes", comUnidade.id);
    assert.equal(orgDepois.status, "ativa");
  });

  it("converter: recusa empresa virar unidade de si mesma", async () => {
    const org = await criarOrg("Auto Conversao");
    const { error } = await admin.rpc("converter_empresa_para_unidade", {
      p_organizacao_id: org.id, p_empresa_mae_id: org.id, p_ator_id: "66666666-6666-6666-6666-666666666666",
    });
    assert.ok(error);
    assert.equal(error.code, "22023");
  });
});
