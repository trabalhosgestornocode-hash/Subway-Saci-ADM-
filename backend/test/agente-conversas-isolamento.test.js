// Teste de integração — prova, contra o Supabase REAL, que o isolamento de
// conversa do Agente Crescer (agente.conversas.service.js) funciona de
// verdade em SQL, não só no fake em memória de agente-service.test.js.
//
// PULA automaticamente se a migration 048 ainda não foi aplicada (tabelas
// agente_conversas/agente_mensagens ausentes) — mesmo espírito de
// test/isolamento-tenant.test.js, sem exigir Supabase de teste separado
// (usa o MESMO .env de bonificacao-mensal-service.test.js): cria e apaga
// suas próprias organizações DESCARTÁVEIS, não toca em dado real.
//
// Rodar: node --env-file=.env --test test/agente-conversas-isolamento.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import * as conversas from "../src/modules/agente/agente.conversas.service.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";

// Fase P0.4: cria/apaga organizações no Supabase configurado — NÃO em produção.
const PULAR_INTEGRACAO = motivoPularIntegracao();

// Fase D: o isolamento é por `agente_conversas.perfil_id`, que referencia
// perfis_operacionais.id — NÃO perfis.id. A suposição antiga (perfis.id ==
// perfis_operacionais.id, válida só nos backfills da migration 060) não
// vale para perfis_operacionais criados depois por outras suítes (id
// próprio, gerado). Fase P0.7: cria 2 contas + perfis_operacionais PRÓPRIOS,
// descartáveis, em vez de pegar 2 linhas quaisquer de `perfis`.
let PERFIL_A = null;
let PERFIL_B = null;

let tabelasExistem = true;   // agente_conversas (048) + agente_conversas.perfil_id (060)
let orgA = null;
let orgB = null;
const tag = `agconv${Date.now()}`;
const contaIds = [];

async function criarContaComPerfil(sufixo) {
  const { data: user, error: eU } = await supabase.auth.admin.createUser({
    email: `${tag}_${sufixo}@example.com`, password: `Ag-${tag}-Xx1!`, email_confirm: true,
  });
  if (eU) throw new Error(`Falha ao criar usuário de teste: ${eU.message}`);
  const { error: ePerf } = await supabase.from("perfis")
    .insert({ id: user.user.id, nome: `Agente Conversas ${sufixo}`, papel: "leitura", ativo: true });
  if (ePerf) throw new Error(`Falha ao criar perfis: ${ePerf.message}`);
  const { data: op, error: eOp } = await supabase.from("perfis_operacionais")
    .insert({ conta_id: user.user.id, nome: `Perfil ${sufixo}` }).select("id").single();
  if (eOp) throw new Error(`Falha ao criar perfis_operacionais: ${eOp.message}`);
  contaIds.push(user.user.id);
  return op.id;
}

before(async () => {
  if (PULAR_INTEGRACAO) { tabelasExistem = false; return; } // não roda contra produção
  const probe = await supabase.from("agente_conversas").select("id, perfil_id").limit(0);
  if (probe.error) { tabelasExistem = false; return; } // 048 ou 060 ainda não aplicada

  PERFIL_A = await criarContaComPerfil("A");
  PERFIL_B = await criarContaComPerfil("B");

  const { data: a, error: eA } = await supabase.from("organizacoes")
    .insert({ nome: "TESTE agente-conversas — descartável A" }).select("id").single();
  const { data: b, error: eB } = await supabase.from("organizacoes")
    .insert({ nome: "TESTE agente-conversas — descartável B" }).select("id").single();
  if (eA || eB) throw new Error(`Falha ao criar organizações de teste: ${eA?.message || eB?.message}`);
  orgA = a.id; orgB = b.id;
});

after(async () => {
  // on delete cascade cuida de agente_conversas/agente_mensagens sozinho.
  if (orgA) await supabase.from("organizacoes").delete().eq("id", orgA);
  if (orgB) await supabase.from("organizacoes").delete().eq("id", orgB);
  // apagar o usuário Auth cascateia perfis -> perfis_operacionais.
  for (const uid of contaIds) { try { await supabase.auth.admin.deleteUser(uid); } catch { /* ignora */ } }
});

describe("agente.conversas.service.js — isolamento real (Supabase)", { skip: PULAR_INTEGRACAO }, () => {
  test("uma conversa criada na organização A não é encontrada pela organização B (mesmo perfil)", async (t) => {
    if (!tabelasExistem) return t.skip("migration 048 (agente_conversas/agente_mensagens) ainda não aplicada — pulando.");

    const conversaId = await conversas.criarConversa({ perfilId: PERFIL_A, organizacaoId: orgA, unidadeId: null });

    const comOrgCerta = await conversas.buscarConversa({ conversaId, perfilId: PERFIL_A, organizacaoId: orgA, unidadeId: null });
    assert.equal(comOrgCerta?.id, conversaId);

    const comOrgErrada = await conversas.buscarConversa({ conversaId, perfilId: PERFIL_A, organizacaoId: orgB, unidadeId: null });
    assert.equal(comOrgErrada, null);
  });

  test("uma conversa não é encontrada por outro perfil, mesma organização", async (t) => {
    if (!tabelasExistem) return t.skip("migration 048 ainda não aplicada — pulando.");

    const conversaId = await conversas.criarConversa({ perfilId: PERFIL_A, organizacaoId: orgA, unidadeId: null });
    const comOutroPerfil = await conversas.buscarConversa({ conversaId, perfilId: PERFIL_B, organizacaoId: orgA, unidadeId: null });
    assert.equal(comOutroPerfil, null);
  });

  test("mensagens gravadas e lidas em ordem cronológica", async (t) => {
    if (!tabelasExistem) return t.skip("migration 048 ainda não aplicada — pulando.");

    const conversaId = await conversas.criarConversa({ perfilId: PERFIL_A, organizacaoId: orgA, unidadeId: null });
    await conversas.salvarMensagem({ conversaId, papel: "user", conteudo: "pergunta 1" });
    await conversas.salvarMensagem({ conversaId, papel: "assistant", conteudo: "resposta 1", toolsUtilizadas: ["consultar_dashboard_executivo"] });

    const mensagens = await conversas.buscarMensagens(conversaId);
    assert.equal(mensagens.length, 2);
    assert.equal(mensagens[0].papel, "user");
    assert.equal(mensagens[1].toolsUtilizadas[0], "consultar_dashboard_executivo");
  });
});
