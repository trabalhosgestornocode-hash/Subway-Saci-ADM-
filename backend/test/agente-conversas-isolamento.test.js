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

// Fase D: o isolamento passou a ser por `agente_conversas.perfil_id`
// (perfis_operacionais). No backfill da migration 060, `perfis_operacionais.id
// == perfis.id`, então usar 2 `perfis` JÁ EXISTENTES como perfil_id continua
// válido (leitura, nunca cria/altera nada).
let PERFIL_A = null;
let PERFIL_B = null;

let tabelasExistem = true;   // agente_conversas (048) + agente_conversas.perfil_id (060)
let orgA = null;
let orgB = null;

before(async () => {
  if (PULAR_INTEGRACAO) { tabelasExistem = false; return; } // não roda contra produção
  const probe = await supabase.from("agente_conversas").select("id, perfil_id").limit(0);
  if (probe.error) { tabelasExistem = false; return; } // 048 ou 060 ainda não aplicada

  const { data: perfis, error: eP } = await supabase.from("perfis").select("id").limit(2);
  if (eP) throw new Error(`Falha ao buscar perfis existentes: ${eP.message}`);
  if (!perfis || perfis.length < 2) { tabelasExistem = false; return; } // sem 2 perfis no banco: pula (ambiente vazio)
  PERFIL_A = perfis[0].id; PERFIL_B = perfis[1].id;

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
