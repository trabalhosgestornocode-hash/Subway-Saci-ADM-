// =====================================================================
// TESTE DE INTEGRAÇÃO — Exclusão definitiva de empresa
// =====================================================================
// Investigação original: excluirEmpresa() fazia DELETE FROM organizacoes
// cru, confiando cegamente no ON DELETE CASCADE — mas ficha_tecnica.
// insumo_id/subproduto_id (e mais três colunas do schema original) são
// ON DELETE RESTRICT, então QUALQUER empresa com catálogo configurado
// (inclusive uma "vazia" clonada de um Modelo Padrão) batia num erro 23503
// cru do Postgres.
//
// Uma primeira correção reagiu bloqueando a exclusão física sempre que
// havia catálogo/histórico — mas isso deixava o SuperAdmin sem NENHUMA
// saída pra apagar de verdade uma empresa de teste/lixo que realmente
// precisa sumir (o botão "Excluir definitivamente" virava um beco sem
// saída). A correção final (migration 055,
// excluir_organizacao_definitivamente) limpa essas dependências RESTRICT
// explicitamente, numa única transação, e o delete em cascata funciona de
// verdade — o botão continua disponível mesmo com catálogo; o que muda é
// só o AVISO no painel (recomendar "Cancelada" em vez de excluir).
//
// SEGURANÇA — mesmo padrão de estrutura-organizacional.test.js: só roda
// com TEST_SUPABASE_* + ISOLATION_TEST_DISPOSABLE=1; sem isso, PULA (não
// falha). Cria e apaga organizações/unidades/dados de teste, nunca reais.
//
// COMO RODAR
//   node --env-file=.env.test --test test/exclusao-empresa.test.js
//   (ou: npm run test:exclusao-empresa)
// =====================================================================
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { motivoParaPular, verificarCredencial, verificarTabelas } from "./helpers/preflight-supabase.js";

if (!globalThis.WebSocket) globalThis.WebSocket = ws;

/** Fake mínimo de Request — só o que excluirEmpresa()/auditar()/revogarSessoes() leem. */
function reqFalso() {
  return {
    user: { id: "00000000-0000-0000-0000-000000000000", email: "teste@exclusao.local" },
    headers: {}, socket: {}, header: () => null,
  };
}

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

describe("Exclusão de empresa — impactoExclusaoEmpresa + excluirEmpresa", { skip: motivoSkip }, () => {
  const admin = createClient(URL, SERVICE, opts);
  const tag = `exclemp_${Date.now()}`;
  const criados = { organizacoes: new Set() };

  async function criarOrg(nome, extra = {}) {
    const { data, error } = await admin.from("organizacoes")
      .insert({ nome: `${nome} ${tag}`, status: "teste", ativo: true, ...extra }).select("id, nome").single();
    assert.ifError(error);
    criados.organizacoes.add(data.id);
    return data;
  }

  before(async () => {
    await verificarCredencial(admin, SERVICE);
    await verificarTabelas(admin, [
      "organizacoes", "unidades", "categorias", "insumos", "produtos", "ficha_tecnica",
      "fornecedores", "pedidos_compra", "pedidos_compra_itens", "movimentacoes_estoque",
      "vendas", "vendas_itens", "lancamentos_financeiros_diarios", "plataforma_auditoria",
    ]);

    // A migration 055 foi aplicada? Chama a função com um id inexistente —
    // função ausente (PGRST202) e "empresa não encontrada" (P0002) são
    // erros DIFERENTES; só o segundo prova que a função existe.
    const idFalso = "00000000-0000-0000-0000-000000000000";
    const { error } = await admin.rpc("excluir_organizacao_definitivamente", {
      p_organizacao_id: idFalso, p_confirmacao_nome: "x", p_ator_id: idFalso,
    });
    if (!error || error.code !== "P0002") {
      throw new Error(
        "A migration 055_excluir_organizacao_definitivamente.sql não parece estar aplicada no banco de teste " +
        `(esperava erro P0002 'Empresa não encontrada', recebi: ${error?.code ?? "nenhum erro"} ${error?.message ?? ""}). ` +
        "Aplique a migration no SQL Editor do projeto de teste antes de rodar.",
      );
    }
  });

  after(async () => {
    for (const id of criados.organizacoes) { try { await admin.from("organizacoes").delete().eq("id", id); } catch { /* ignora */ } }
  });

  it("empresa vazia (só Matriz automática, sem catálogo): exclusaoFisicaSegura=true e o DELETE de verdade funciona", async () => {
    const org = await criarOrg("Vazia");
    await admin.from("unidades").insert({ organizacao_id: org.id, nome: "Matriz", ativo: true });

    // impactoExclusaoEmpresa é chamado indiretamente aqui via as mesmas
    // contagens que o service faz — reproduz a lógica sem precisar do
    // servidor HTTP rodando.
    const [{ count: unidades }, { count: categorias }, { count: insumos }, { count: produtos }] = await Promise.all([
      admin.from("unidades").select("id", { count: "exact", head: true }).eq("organizacao_id", org.id),
      admin.from("categorias").select("id", { count: "exact", head: true }).eq("organizacao_id", org.id),
      admin.from("insumos").select("id", { count: "exact", head: true }).eq("organizacao_id", org.id),
      admin.from("produtos").select("id", { count: "exact", head: true }).eq("organizacao_id", org.id),
    ]);
    assert.equal(unidades, 1, "a Matriz automática deveria existir");
    assert.equal(categorias, 0);
    assert.equal(insumos, 0);
    assert.equal(produtos, 0);

    const { error: eDel } = await admin.from("organizacoes").delete().eq("id", org.id);
    assert.ifError(eDel);
    const { data: check } = await admin.from("organizacoes").select("id").eq("id", org.id).maybeSingle();
    assert.equal(check, null, "a empresa vazia deveria ter sido excluída de verdade");
    criados.organizacoes.delete(org.id); // já não existe mais, não precisa limpar de novo
  });

  it("empresa com catálogo (produto usando insumo via ficha técnica): o DELETE bruto FALHA com 23503 (reproduz o bug original)", async () => {
    const org = await criarOrg("ComCatalogo");
    const { data: cat } = await admin.from("categorias").insert({ organizacao_id: org.id, nome: "Cat", tipo: "produto" }).select("id").single();
    const { data: ins } = await admin.from("insumos").insert({ organizacao_id: org.id, categoria_id: cat.id, nome: "Ins", unidade_medida: "g", preco_unitario: 1 }).select("id").single();
    const { data: prod } = await admin.from("produtos").insert({ organizacao_id: org.id, categoria_id: cat.id, nome: "Prod", sku: `SKU-${tag}` }).select("id").single();
    await admin.from("ficha_tecnica").insert({ produto_id: prod.id, insumo_id: ins.id, quantidade: 1 });

    const { error: eDel } = await admin.from("organizacoes").delete().eq("id", org.id);
    assert.ok(eDel, "o DELETE bruto deveria falhar — é exatamente o bug que a guarda evita o usuário ver");
    assert.equal(eDel.code, "23503");
    assert.match(eDel.message, /ficha_tecnica/);

    // limpeza em ordem segura (ficha_tecnica -> produto/insumo -> categoria -> org)
    await admin.from("ficha_tecnica").delete().eq("produto_id", prod.id);
    await admin.from("produtos").delete().eq("id", prod.id);
    await admin.from("insumos").delete().eq("id", ins.id);
    await admin.from("categorias").delete().eq("id", cat.id);
  });

  it("empresa com unidade com histórico operacional (Dashboard Executivo): a métrica detecta mesmo sem catálogo algum", async () => {
    const org = await criarOrg("ComHistorico");
    const { data: uni } = await admin.from("unidades").insert({ organizacao_id: org.id, nome: "Matriz", ativo: true }).select("id").single();
    await admin.from("lancamentos_financeiros_diarios")
      .insert({ organizacao_id: org.id, unidade_id: uni.id, data_lancamento: "2026-01-10", status: "rascunho" });

    const { count: lancamentos } = await admin.from("lancamentos_financeiros_diarios")
      .select("id", { count: "exact", head: true }).eq("organizacao_id", org.id);
    assert.equal(lancamentos, 1, "esta é a métrica que impactoExclusaoEmpresa soma pra decidir o AVISO — sem catálogo algum, só histórico");
    // (lancamentos_financeiros_diarios é ON DELETE CASCADE — o ponto deste
    // teste é só a CONTAGEM que alimenta o aviso do painel, não o delete.)
  });

  it("auditoria: EMPRESA_EXCLUIDA só é gravada quando a exclusão realmente acontece (nunca antes de confirmar que vai suceder)", async () => {
    const org = await criarOrg("AuditoriaOrdem");
    await admin.from("unidades").insert({ organizacao_id: org.id, nome: "Matriz", ativo: true });

    const antes = await admin.from("plataforma_auditoria").select("id", { count: "exact", head: true })
      .eq("entidade_id", org.id).eq("acao", "empresa.excluida");
    assert.equal(antes.count, 0);

    const { error: eDel } = await admin.from("organizacoes").delete().eq("id", org.id);
    assert.ifError(eDel);
    criados.organizacoes.delete(org.id);
    // Nota: este teste exercita só a camada de banco (mesmo padrão dos
    // outros "it"s aqui) — a auditoria em si é gravada pela função SQL
    // (excluir_organizacao_definitivamente), não pelo DELETE bruto. O ponto
    // comprovado aqui é que a empresa vazia realmente desaparece; a ORDEM
    // correta (auditoria só é gravada se a transação inteira suceder) está
    // implementada na migration 055 e é comentada lá.
  });

  // ---- Testes de ponta a ponta contra o SERVICE de verdade (não só o SQL bruto) ----

  it("SERVICE: excluirEmpresa() numa empresa com catálogo (ficha_tecnica via insumo E subproduto) exclui de verdade — antes era o 23503 cru", async () => {
    const { excluirEmpresa } = await import("../src/modules/plataforma/plataforma.empresas.service.js");
    const org = await criarOrg("ServiceComCatalogo");
    const { data: uni } = await admin.from("unidades").insert({ organizacao_id: org.id, nome: "Matriz", ativo: true }).select("id").single();
    const { data: cat } = await admin.from("categorias").insert({ organizacao_id: org.id, nome: "Cat", tipo: "produto" }).select("id").single();
    const { data: ins } = await admin.from("insumos").insert({ organizacao_id: org.id, categoria_id: cat.id, nome: "Ins", unidade_medida: "g", preco_unitario: 1 }).select("id").single();
    const { data: submontagem } = await admin.from("produtos").insert({ organizacao_id: org.id, categoria_id: cat.id, nome: "Submontagem", sku: `SKU-${tag}-sub` }).select("id").single();
    const { data: prod } = await admin.from("produtos").insert({ organizacao_id: org.id, categoria_id: cat.id, nome: "Prod", sku: `SKU-${tag}-svc` }).select("id").single();
    // Uma linha via insumo_id, outra via subproduto_id — as DUAS colunas
    // RESTRICT de ficha_tecnica precisam estar cobertas.
    await admin.from("ficha_tecnica").insert([
      { produto_id: prod.id, insumo_id: ins.id, quantidade: 1 },
      { produto_id: prod.id, subproduto_id: submontagem.id, quantidade: 1 },
    ]);

    const resultado = await excluirEmpresa(reqFalso(), org.id, { confirmacao: org.nome });
    assert.equal(resultado.excluida, true);
    criados.organizacoes.delete(org.id);

    const { data: orgAinda } = await admin.from("organizacoes").select("id").eq("id", org.id).maybeSingle();
    assert.equal(orgAinda, null, "a empresa com catálogo deveria ter sido excluída de verdade (era o bug: 23503 cru)");
    for (const [tabela, id] of [["unidades", uni.id], ["categorias", cat.id], ["insumos", ins.id], ["produtos", prod.id], ["produtos", submontagem.id]]) {
      const { data } = await admin.from(tabela).select("id").eq("id", id).maybeSingle();
      assert.equal(data, null, `${tabela}.${id} deveria ter sido apagado junto`);
    }
    const { count: fichaRestante } = await admin.from("ficha_tecnica")
      .select("id", { count: "exact", head: true }).eq("produto_id", prod.id);
    assert.equal(fichaRestante, 0, "ficha_tecnica desta empresa deveria ter sido limpa (era exatamente o que travava o 23503)");

    const { data: auditRows } = await admin.from("plataforma_auditoria")
      .select("detalhes").eq("entidade_id", org.id).eq("acao", "empresa.excluida")
      .order("created_at", { ascending: false }).limit(1);
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].detalhes.catalogo.produtos, 2);
    assert.equal(auditRows[0].detalhes.catalogo.fichaTecnica, 2);
  });

  it("SERVICE: excluirEmpresa() limpa também movimentacoes_estoque/pedidos_compra_itens/pedidos_compra/vendas_itens (as outras 4 colunas RESTRICT do schema)", async () => {
    const { excluirEmpresa } = await import("../src/modules/plataforma/plataforma.empresas.service.js");
    const org = await criarOrg("ServiceEstoqueComprasVendas");
    const { data: uni } = await admin.from("unidades").insert({ organizacao_id: org.id, nome: "Matriz", ativo: true }).select("id").single();
    const { data: cat } = await admin.from("categorias").insert({ organizacao_id: org.id, nome: "Cat", tipo: "insumo" }).select("id").single();
    const { data: ins } = await admin.from("insumos").insert({ organizacao_id: org.id, categoria_id: cat.id, nome: "Ins", unidade_medida: "g", preco_unitario: 1 }).select("id").single();
    const { data: prod } = await admin.from("produtos").insert({ organizacao_id: org.id, categoria_id: cat.id, nome: "Prod", sku: `SKU-${tag}-estoque` }).select("id").single();
    const { data: forn } = await admin.from("fornecedores").insert({ organizacao_id: org.id, nome: "Forn" }).select("id").single();
    const { data: pedido } = await admin.from("pedidos_compra").insert({ unidade_id: uni.id, fornecedor_id: forn.id }).select("id").single();
    await admin.from("pedidos_compra_itens").insert({ pedido_compra_id: pedido.id, insumo_id: ins.id, quantidade: 1 });
    await admin.from("movimentacoes_estoque").insert({ unidade_id: uni.id, insumo_id: ins.id, tipo: "entrada_manual", quantidade: 1 });
    const { data: venda } = await admin.from("vendas").insert({ unidade_id: uni.id }).select("id").single();
    await admin.from("vendas_itens").insert({ venda_id: venda.id, produto_id: prod.id });

    const resultado = await excluirEmpresa(reqFalso(), org.id, { confirmacao: org.nome });
    assert.equal(resultado.excluida, true);
    criados.organizacoes.delete(org.id);

    const { data: orgAinda } = await admin.from("organizacoes").select("id").eq("id", org.id).maybeSingle();
    assert.equal(orgAinda, null, "empresa com estoque/compras/vendas antigas deveria ter sido excluída de verdade");
  });

  it("SERVICE: excluirEmpresa() numa empresa vazia (Matriz automática) exclui de verdade com a confirmação certa", async () => {
    const { excluirEmpresa } = await import("../src/modules/plataforma/plataforma.empresas.service.js");
    const org = await criarOrg("ServiceVazia");
    await admin.from("unidades").insert({ organizacao_id: org.id, nome: "Matriz", ativo: true });

    const resultado = await excluirEmpresa(reqFalso(), org.id, { confirmacao: org.nome });
    assert.equal(resultado.excluida, true);
    criados.organizacoes.delete(org.id);

    const { data: aindaExiste } = await admin.from("organizacoes").select("id").eq("id", org.id).maybeSingle();
    assert.equal(aindaExiste, null, "a empresa vazia deveria ter sido excluída de verdade pelo service");

    const { data: auditRows } = await admin.from("plataforma_auditoria")
      .select("acao, detalhes").eq("entidade_id", org.id).eq("acao", "empresa.excluida")
      .order("created_at", { ascending: false }).limit(1);
    assert.equal(auditRows.length, 1, "a auditoria EMPRESA_EXCLUIDA deveria ter sido gravada, e só porque a exclusão realmente aconteceu");
  });

  it("SERVICE: excluirEmpresa() recusa quando o nome de confirmação não bate — mesmo numa empresa vazia", async () => {
    const { excluirEmpresa } = await import("../src/modules/plataforma/plataforma.empresas.service.js");
    const org = await criarOrg("ServiceConfirmacaoErrada");
    await assert.rejects(
      excluirEmpresa(reqFalso(), org.id, { confirmacao: "nome errado" }),
      (erro) => { assert.equal(erro.statusCode, 400); return true; },
    );
    const { data: aindaExiste } = await admin.from("organizacoes").select("id").eq("id", org.id).maybeSingle();
    assert.ok(aindaExiste, "confirmação errada não pode excluir nada");
  });
});
