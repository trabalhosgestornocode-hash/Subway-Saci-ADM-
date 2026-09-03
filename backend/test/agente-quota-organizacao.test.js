// Teto por ORGANIZAÇÃO do Agente Crescer (proteção financeira, P0.5).
//
// O que protege: uma organização não pode gerar chamadas a Claude sem limite —
// nem por spam, nem por automação, nem por restart do processo (o teto é lido
// de agente_uso, não da memória). Fail-open se a contagem falhar (a 1ª camada,
// por conta, já barra rajada).
//
// Rodar: node --env-file-if-exists=.env --test test/agente-quota-organizacao.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { avaliarQuotaOrganizacao, processarMensagem } from "../src/modules/agente/agente.service.js";
import { RATE_LIMIT_AGENTE } from "../src/config/limites.js";

describe("avaliarQuotaOrganizacao (decisão pura)", () => {
  const H = RATE_LIMIT_AGENTE.porOrganizacaoHora.max;
  const D = RATE_LIMIT_AGENTE.porOrganizacaoDia.max;

  test("abaixo dos dois tetos -> ok", () => {
    assert.deepEqual(avaliarQuotaOrganizacao({ interacoesHora: 0, interacoesDia: 0 }), { ok: true });
    assert.deepEqual(avaliarQuotaOrganizacao({ interacoesHora: H - 1, interacoesDia: D - 1 }), { ok: true });
  });

  test("no teto da hora -> bloqueia com janela 'hora'", () => {
    const r = avaliarQuotaOrganizacao({ interacoesHora: H, interacoesDia: 10 });
    assert.equal(r.ok, false);
    assert.equal(r.janela, "hora");
    assert.equal(r.limite, H);
  });

  test("no teto do dia -> bloqueia com janela 'dia'", () => {
    const r = avaliarQuotaOrganizacao({ interacoesHora: 1, interacoesDia: D });
    assert.equal(r.ok, false);
    assert.equal(r.janela, "dia");
  });

  test("contagem nula (leitura falhou) NÃO bloqueia naquela janela — fail-open", () => {
    assert.deepEqual(avaliarQuotaOrganizacao({ interacoesHora: null, interacoesDia: null }), { ok: true });
    // só a hora falhou, o dia está no teto -> ainda bloqueia pelo dia
    assert.equal(avaliarQuotaOrganizacao({ interacoesHora: null, interacoesDia: D }).ok, false);
  });
});

describe("processarMensagem — integração do teto por organização", () => {
  const ORG = "00000000-0000-0000-0000-0000000000aa";
  const base = {
    organizacaoId: ORG, unidadeId: null,
    acesso: { organizacaoId: ORG, permissoes: [], modulos: [], impersonando: false },
    usuario: { id: "11111111-1111-1111-1111-111111111111", email: "a@b.c", nome: "A" },
    mensagem: "Como estou este mês?",
  };
  const conversasFake = () => ({
    HISTORICO_MAX_MENSAGENS: 12,
    async buscarConversa() { return null; },
    async criarConversa() { return "conv-1"; },
    async buscarMensagens() { return []; },
    async salvarMensagem() {},
  });
  const providerFake = { enviarMensagem: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: {} }) };

  test("acima do teto da organização -> 429 AGENTE_QUOTA_ORGANIZACAO, sem chamar o provider", async () => {
    let chamouProvider = false;
    const provider = { enviarMensagem: async () => { chamouProvider = true; return providerFake.enviarMensagem(); } };
    const uso = {
      async registrarUso() {},
      async contarInteracoesDaOrganizacao() { return RATE_LIMIT_AGENTE.porOrganizacaoHora.max; },
    };
    await assert.rejects(
      () => processarMensagem({ ...base, provider, conversas: conversasFake(), uso }),
      (e) => e.statusCode === 429 && e.details?.codigo === "AGENTE_QUOTA_ORGANIZACAO",
    );
    assert.equal(chamouProvider, false, "não deve chamar Claude quando a quota estourou");
  });

  test("dentro do teto -> segue normal", async () => {
    const uso = {
      async registrarUso() {},
      async contarInteracoesDaOrganizacao() { return 0; },
    };
    const r = await processarMensagem({ ...base, provider: providerFake, conversas: conversasFake(), uso });
    assert.equal(r.resposta, "ok");
  });

  test("uso sem contarInteracoesDaOrganizacao (compat) -> não quebra", async () => {
    const uso = { async registrarUso() {} };
    const r = await processarMensagem({ ...base, provider: providerFake, conversas: conversasFake(), uso });
    assert.equal(r.resposta, "ok");
  });
});
