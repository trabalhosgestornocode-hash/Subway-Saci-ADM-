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

// agente_conversas.usuario_id tem FK real para perfis(id) — usa 2 perfis JÁ
// EXISTENTES (leitura, nunca cria/altera usuário) em vez de UUIDs inventados.
let USUARIO_A = null;
let USUARIO_B = null;

let tabelasExistem = true;
let orgA = null;
let orgB = null;

before(async () => {
  const probe = await supabase.from("agente_conversas").select("id").limit(0);
  if (probe.error) { tabelasExistem = false; return; }

  const { data: perfis, error: eP } = await supabase.from("perfis").select("id").limit(2);
  if (eP) throw new Error(`Falha ao buscar perfis existentes: ${eP.message}`);
  if (!perfis || perfis.length < 2) { tabelasExistem = false; return; } // sem 2 perfis no banco: pula (ambiente vazio)
  USUARIO_A = perfis[0].id; USUARIO_B = perfis[1].id;

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
});

describe("agente.conversas.service.js — isolamento real (Supabase)", () => {
  test("uma conversa criada na organização A não é encontrada pela organização B (mesmo usuário)", async (t) => {
    if (!tabelasExistem) return t.skip("migration 048 (agente_conversas/agente_mensagens) ainda não aplicada — pulando.");

    const conversaId = await conversas.criarConversa({ usuarioId: USUARIO_A, organizacaoId: orgA, unidadeId: null });

    const comOrgCerta = await conversas.buscarConversa({ conversaId, usuarioId: USUARIO_A, organizacaoId: orgA, unidadeId: null });
    assert.equal(comOrgCerta?.id, conversaId);

    const comOrgErrada = await conversas.buscarConversa({ conversaId, usuarioId: USUARIO_A, organizacaoId: orgB, unidadeId: null });
    assert.equal(comOrgErrada, null);
  });

  test("uma conversa não é encontrada por outro usuário, mesma organização", async (t) => {
    if (!tabelasExistem) return t.skip("migration 048 ainda não aplicada — pulando.");

    const conversaId = await conversas.criarConversa({ usuarioId: USUARIO_A, organizacaoId: orgA, unidadeId: null });
    const comOutroUsuario = await conversas.buscarConversa({ conversaId, usuarioId: USUARIO_B, organizacaoId: orgA, unidadeId: null });
    assert.equal(comOutroUsuario, null);
  });

  test("mensagens gravadas e lidas em ordem cronológica", async (t) => {
    if (!tabelasExistem) return t.skip("migration 048 ainda não aplicada — pulando.");

    const conversaId = await conversas.criarConversa({ usuarioId: USUARIO_A, organizacaoId: orgA, unidadeId: null });
    await conversas.salvarMensagem({ conversaId, papel: "user", conteudo: "pergunta 1" });
    await conversas.salvarMensagem({ conversaId, papel: "assistant", conteudo: "resposta 1", toolsUtilizadas: ["consultar_dashboard_executivo"] });

    const mensagens = await conversas.buscarMensagens(conversaId);
    assert.equal(mensagens.length, 2);
    assert.equal(mensagens[0].papel, "user");
    assert.equal(mensagens[1].toolsUtilizadas[0], "consultar_dashboard_executivo");
  });
});
