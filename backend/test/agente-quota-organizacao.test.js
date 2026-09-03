// Quota do Agente Crescer — reserva ATÔMICA org + conta + perfil (Fase P0.2).
//
// O que protege:
//  - race condition: N chamadas concorrentes com 1 vaga => 1 passa, N-1 caem
//    (nunca N passam). A atomicidade real é do Postgres (migration 067); aqui
//    exercitamos a LÓGICA DO SERVICE contra um backend atômico simulado.
//  - isolamento: Org A pode estourar sem consumir Org B; idem perfil A vs B.
//  - conta compartilhada: 2 perfis da mesma conta não furam o teto da CONTA.
//  - FAIL CLOSED: banco indisponível => NÃO chama a Anthropic.
//  - degradado: migration 067 pendente => fallback best-effort, sem regressão.
//
// Rodar: node --env-file-if-exists=.env --test test/agente-quota-organizacao.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  montarReservasQuota, avaliarQuotaOrganizacao, processarMensagem,
} from "../src/modules/agente/agente.service.js";
import { RATE_LIMIT_AGENTE } from "../src/config/limites.js";

// --------------------------------------------------------------------------
// montarReservasQuota (puro)
// --------------------------------------------------------------------------
describe("montarReservasQuota", () => {
  const ORG = "00000000-0000-0000-0000-0000000000a0";
  const CONTA = "00000000-0000-0000-0000-0000000000b0";
  const PERFIL = "00000000-0000-0000-0000-0000000000c0";

  test("gera org + conta + perfil, 2 janelas cada", () => {
    const r = montarReservasQuota({ organizacaoId: ORG, contaId: CONTA, perfilId: PERFIL });
    assert.equal(r.length, 6);
    assert.deepEqual(new Set(r.map((x) => x.escopo)), new Set(["org", "conta", "perfil"]));
    assert.deepEqual(new Set(r.map((x) => x.janelaSegundos)), new Set([3600, 86400]));
    assert.ok(r.every((x) => x.limite > 0));
  });

  test("impersonação (perfilId null) -> pula o escopo de perfil", () => {
    const r = montarReservasQuota({ organizacaoId: ORG, contaId: CONTA, perfilId: null });
    assert.equal(r.length, 4);
    assert.ok(!r.some((x) => x.escopo === "perfil"));
  });

  test("as chaves são exatamente os ids passados (nada inventado)", () => {
    const r = montarReservasQuota({ organizacaoId: ORG, contaId: CONTA, perfilId: PERFIL });
    assert.equal(r.find((x) => x.escopo === "org").chave, ORG);
    assert.equal(r.find((x) => x.escopo === "conta").chave, CONTA);
    assert.equal(r.find((x) => x.escopo === "perfil").chave, PERFIL);
  });
});

// --------------------------------------------------------------------------
// Backend atômico SIMULADO — imita agente_reservar_quota (INSERT ... ON CONFLICT
// + ROLLBACK se algum estoura). Serve para testar a lógica do service sob
// concorrência sem um Postgres.
// --------------------------------------------------------------------------
function fakeQuotaAtomica({ modo = "ok" } = {}) {
  const contadores = new Map(); // `${escopo}|${chave}|${janela}` -> n
  return {
    async registrarUso() {},
    async reservarQuotaAgente(reservas) {
      if (modo === "falha_infra") return { resultado: "falha_infra", erro: "connection refused" };
      if (modo === "degradado") return { resultado: "degradado" };
      // aplica todos; se algum passa do limite, reverte todos (semântica da RPC).
      const aplicados = [];
      for (const r of reservas) {
        const k = `${r.escopo}|${r.chave}|${r.janelaSegundos}`;
        const n = (contadores.get(k) ?? 0) + 1;
        contadores.set(k, n);
        aplicados.push([k, n, r]);
        if (n > r.limite) {
          for (const [kk] of aplicados) contadores.set(kk, contadores.get(kk) - 1); // rollback
          return { resultado: "excedido", escopo: r.escopo };
        }
      }
      return { resultado: "ok", detalhes: {} };
    },
    async contarInteracoesDaOrganizacao() { return 0; },
  };
}

const conversasFake = () => ({
  HISTORICO_MAX_MENSAGENS: 12,
  async buscarConversa() { return null; },
  async criarConversa() { return "conv-1"; },
  async buscarMensagens() { return []; },
  async salvarMensagem() {},
});
const providerOk = { enviarMensagem: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: {} }) };

function baseArgs(over = {}) {
  const ORG = over.organizacaoId ?? "00000000-0000-0000-0000-0000000000a1";
  return {
    organizacaoId: ORG, unidadeId: null,
    acesso: { organizacaoId: ORG, permissoes: [], modulos: [], impersonando: false },
    usuario: { id: over.contaId ?? "11111111-1111-1111-1111-111111111111", email: "a@b.c", nome: "A" },
    perfil: over.perfil === null ? null : { id: over.perfilId ?? "22222222-2222-2222-2222-222222222222", nome: "P" },
    mensagem: "Como estou?",
    provider: over.provider ?? providerOk,
    conversas: conversasFake(),
    uso: over.uso,
  };
}

// --------------------------------------------------------------------------
// Concorrência
// --------------------------------------------------------------------------
describe("reserva sob concorrência", () => {
  test("10 chamadas paralelas, 1 vaga -> 1 aceita, 9 recusadas (nunca 10)", async () => {
    // força limite efetivo 1: env só nesta suíte seria global; em vez disso uso
    // um fake cujo limite vem das reservas — então monkeypatch o teto p/ 1.
    const uso = fakeQuotaAtomica();
    // reservas reais teriam limites altos; o fake respeita r.limite, então
    // interceptamos para simular "resta 1" no escopo org.
    const real = uso.reservarQuotaAgente;
    uso.reservarQuotaAgente = (reservas) => real(reservas.map((r) => r.escopo === "org" && r.janelaSegundos === 3600 ? { ...r, limite: 1 } : { ...r, limite: 9999 }));

    const args = baseArgs({ uso });
    const resultados = await Promise.allSettled(
      Array.from({ length: 10 }, () => processarMensagem({ ...args, conversas: conversasFake() })),
    );
    const ok = resultados.filter((r) => r.status === "fulfilled").length;
    const recusadas = resultados.filter((r) => r.status === "rejected" && r.reason?.statusCode === 429).length;
    assert.equal(ok, 1, "exatamente 1 deveria passar");
    assert.equal(recusadas, 9, "as outras 9 deveriam ser 429");
  });

  test("Org A pode estourar sem consumir Org B", async () => {
    const uso = fakeQuotaAtomica();
    const real = uso.reservarQuotaAgente;
    uso.reservarQuotaAgente = (reservas) => real(reservas.map((r) => r.escopo === "org" && r.janelaSegundos === 3600 ? { ...r, limite: 2 } : { ...r, limite: 9999 }));
    const A = "00000000-0000-0000-0000-00000000000a";
    const B = "00000000-0000-0000-0000-00000000000b";

    const a1 = await processarMensagem(baseArgs({ uso, organizacaoId: A }));
    const a2 = await processarMensagem(baseArgs({ uso, organizacaoId: A }));
    assert.equal(a1.resposta, "ok"); assert.equal(a2.resposta, "ok");
    await assert.rejects(() => processarMensagem(baseArgs({ uso, organizacaoId: A })), (e) => e.statusCode === 429);
    // B intacta
    const b1 = await processarMensagem(baseArgs({ uso, organizacaoId: B }));
    assert.equal(b1.resposta, "ok");
  });

  test("2 perfis da MESMA conta não furam o teto da conta", async () => {
    const uso = fakeQuotaAtomica();
    const real = uso.reservarQuotaAgente;
    uso.reservarQuotaAgente = (reservas) => real(reservas.map((r) => r.escopo === "conta" && r.janelaSegundos === 3600 ? { ...r, limite: 3 } : { ...r, limite: 9999 }));
    const CONTA = "33333333-3333-3333-3333-333333333333";

    for (let i = 0; i < 3; i++) {
      const r = await processarMensagem(baseArgs({ uso, contaId: CONTA, perfilId: `4444444${i}-4444-4444-4444-444444444444` }));
      assert.equal(r.resposta, "ok");
    }
    // 4ª chamada, outro perfil, MESMA conta -> teto da conta barra
    await assert.rejects(
      () => processarMensagem(baseArgs({ uso, contaId: CONTA, perfilId: "55555555-5555-5555-5555-555555555555" })),
      (e) => e.statusCode === 429 && e.details?.escopo === "conta",
    );
  });

  test("perfil A e perfil B têm tetos independentes", async () => {
    const uso = fakeQuotaAtomica();
    const real = uso.reservarQuotaAgente;
    uso.reservarQuotaAgente = (reservas) => real(reservas.map((r) => r.escopo === "perfil" && r.janelaSegundos === 3600 ? { ...r, limite: 1 } : { ...r, limite: 9999 }));
    const PA = "66666666-6666-6666-6666-666666666666";
    const PB = "77777777-7777-7777-7777-777777777777";

    assert.equal((await processarMensagem(baseArgs({ uso, perfilId: PA }))).resposta, "ok");
    await assert.rejects(() => processarMensagem(baseArgs({ uso, perfilId: PA })), (e) => e.statusCode === 429 && e.details?.escopo === "perfil");
    assert.equal((await processarMensagem(baseArgs({ uso, perfilId: PB }))).resposta, "ok"); // B intacto
  });
});

// --------------------------------------------------------------------------
// FAIL CLOSED / degradado / compat
// --------------------------------------------------------------------------
describe("modos de falha", () => {
  test("banco indisponível -> 503 AGENTE_QUOTA_INDISPONIVEL, SEM chamar a Anthropic", async () => {
    let chamou = false;
    const provider = { enviarMensagem: async () => { chamou = true; return providerOk.enviarMensagem(); } };
    await assert.rejects(
      () => processarMensagem(baseArgs({ uso: fakeQuotaAtomica({ modo: "falha_infra" }), provider })),
      (e) => e.statusCode === 503 && e.details?.codigo === "AGENTE_QUOTA_INDISPONIVEL",
    );
    assert.equal(chamou, false, "FAIL CLOSED: nunca chama Claude sem reservar quota");
  });

  test("migration 067 pendente (degradado) + contagem abaixo -> segue", async () => {
    const uso = fakeQuotaAtomica({ modo: "degradado" });
    uso.contarInteracoesDaOrganizacao = async () => 0;
    assert.equal((await processarMensagem(baseArgs({ uso }))).resposta, "ok");
  });

  test("degradado + contagem acima do teto de org -> 429", async () => {
    const uso = fakeQuotaAtomica({ modo: "degradado" });
    uso.contarInteracoesDaOrganizacao = async () => RATE_LIMIT_AGENTE.atomica.org[0].max; // no teto da hora
    await assert.rejects(() => processarMensagem(baseArgs({ uso })), (e) => e.statusCode === 429 && e.details?.degradado === true);
  });

  test("uso sem reservarQuotaAgente (fakes antigos / compat) -> não quebra", async () => {
    const r = await processarMensagem(baseArgs({ uso: { async registrarUso() {} } }));
    assert.equal(r.resposta, "ok");
  });
});

// --------------------------------------------------------------------------
// avaliarQuotaOrganizacao (puro — caminho degradado)
// --------------------------------------------------------------------------
describe("avaliarQuotaOrganizacao (degradado)", () => {
  const [H, D] = RATE_LIMIT_AGENTE.atomica.org;
  test("abaixo -> ok; no teto da hora/dia -> bloqueia", () => {
    assert.deepEqual(avaliarQuotaOrganizacao({ interacoesHora: 0, interacoesDia: 0 }), { ok: true });
    assert.equal(avaliarQuotaOrganizacao({ interacoesHora: H.max, interacoesDia: 0 }).ok, false);
    assert.equal(avaliarQuotaOrganizacao({ interacoesHora: 0, interacoesDia: D.max }).janela, "dia");
  });
  test("contagem nula não bloqueia por aquela janela", () => {
    assert.deepEqual(avaliarQuotaOrganizacao({ interacoesHora: null, interacoesDia: null }), { ok: true });
  });
});
