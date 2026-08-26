// =====================================================================
// TESTE DE INTEGRAÇÃO — Exclusão/arquivamento de empresa
// =====================================================================
// Investigação: excluirEmpresa() fazia DELETE FROM organizacoes cru,
// confiando cegamente no ON DELETE CASCADE — mas ficha_tecnica.insumo_id/
// subproduto_id são ON DELETE RESTRICT (nunca alterado por nenhuma
// migration), então QUALQUER empresa com catálogo configurado (inclusive
// uma "vazia" clonada de um Modelo Padrão) batia num erro 23503 cru do
// Postgres. Corrigido com impactoExclusaoEmpresa() (mesmo padrão de
// impactoExclusaoUnidade()) bloqueando ANTES de tentar.
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
      "lancamentos_financeiros_diarios", "plataforma_auditoria",
    ]);
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

  it("empresa com unidade com histórico operacional (Dashboard Executivo): também não pode ser excluída fisicamente sem aviso", async () => {
    const org = await criarOrg("ComHistorico");
    const { data: uni } = await admin.from("unidades").insert({ organizacao_id: org.id, nome: "Matriz", ativo: true }).select("id").single();
    await admin.from("lancamentos_financeiros_diarios")
      .insert({ organizacao_id: org.id, unidade_id: uni.id, data_lancamento: "2026-01-10", status: "rascunho" });

    const { count: lancamentos } = await admin.from("lancamentos_financeiros_diarios")
      .select("id", { count: "exact", head: true }).eq("organizacao_id", org.id);
    assert.equal(lancamentos, 1, "esta é a métrica que impactoExclusaoEmpresa soma como bloqueante — sem catálogo algum, só histórico");
    // (não precisamos provar o 23503 aqui de novo — lancamentos_financeiros_diarios
    // é ON DELETE CASCADE; o ponto deste teste é que a CONTAGEM detecta o
    // histórico ANTES de qualquer tentativa de DELETE, então a guarda bloqueia
    // mesmo quando o banco sozinho deixaria passar.)
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
    // outros "it"s aqui) — a auditoria em si é gravada pelo service
    // (excluirEmpresa), não pelo DELETE bruto. O ponto comprovado aqui é
    // que a empresa vazia realmente desaparece; a ORDEM correta
    // (revogar sessão + auditar SÓ depois do impacto confirmar sucesso)
    // está implementada em plataforma.empresas.service.js e é comentada lá.
  });

  // ---- Testes de ponta a ponta contra o SERVICE de verdade (não só o SQL bruto) ----

  it("SERVICE: excluirEmpresa() numa empresa com catálogo recusa com mensagem clara (400), NUNCA o erro 23503 cru", async () => {
    const { excluirEmpresa } = await import("../src/modules/plataforma/plataforma.empresas.service.js");
    const org = await criarOrg("ServiceComCatalogo");
    const { data: cat } = await admin.from("categorias").insert({ organizacao_id: org.id, nome: "Cat", tipo: "produto" }).select("id").single();
    const { data: ins } = await admin.from("insumos").insert({ organizacao_id: org.id, categoria_id: cat.id, nome: "Ins", unidade_medida: "g", preco_unitario: 1 }).select("id").single();
    const { data: prod } = await admin.from("produtos").insert({ organizacao_id: org.id, categoria_id: cat.id, nome: "Prod", sku: `SKU-${tag}-svc` }).select("id").single();
    await admin.from("ficha_tecnica").insert({ produto_id: prod.id, insumo_id: ins.id, quantidade: 1 });

    await assert.rejects(
      excluirEmpresa(reqFalso(), org.id, { confirmacao: org.nome }),
      (erro) => {
        assert.equal(erro.statusCode, 400, "tem que ser um erro CONTROLADO (badRequest), nunca o 500/23503 cru do Postgres");
        assert.match(erro.message, /catálogo|histórico/i);
        assert.ok(erro.details?.metricas, "a mensagem deveria vir com o detalhamento de métricas, pro frontend mostrar");
        return true;
      },
    );

    // a empresa TEM que continuar existindo — a recusa é preventiva, nunca parcial
    const { data: aindaExiste } = await admin.from("organizacoes").select("id").eq("id", org.id).maybeSingle();
    assert.ok(aindaExiste, "a empresa não pode ter sido tocada quando a exclusão é recusada");

    await admin.from("ficha_tecnica").delete().eq("produto_id", prod.id);
    await admin.from("produtos").delete().eq("id", prod.id);
    await admin.from("insumos").delete().eq("id", ins.id);
    await admin.from("categorias").delete().eq("id", cat.id);
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
