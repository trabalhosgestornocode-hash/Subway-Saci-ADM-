// PAINEL ADMINISTRATIVO — UI do desbloqueio de um dia (migration 068).
//
// Construtores PUROS e o cliente HTTP. Prova o que a tela NÃO pode fazer:
//   * nunca oferecer "Desbloquear" por conta própria — só onde o backend
//     mandou `podeDesbloquear` (item 4: zero regra duplicada no cliente);
//   * nunca mostrar um dia liberado-e-vazio como resolvido (item 12);
//   * pedir motivo, e observação quando o motivo é "outro" (item 2).
//
// Rodar: node --test frontend/test/painelAdmDesbloqueio.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.sessionStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window ??= {};
globalThis.window.supabase = {
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "jwt-fake" } } }) },
  }),
};

const { estadoDiaCalendario, rotuloFinanceiroDia } = await import("../src/painelAdmUi.js");
const { htmlDiasPendentes, htmlModalDesbloqueio } = await import("../src/painelAdmViews.js");
const { painelAdmApi } = await import("../src/painelAdmApi.js");

// --- fixtures de dia (formato do calendarioUnidade) ------------------------
const dia = (over = {}) => ({
  data: "2026-09-02", painel: "NAO_LANCADO", statusDia: "PENDENTE",
  completo: false, esperado: true, bloqueada: false, emPreenchimento: false,
  motivoNaoAplicavel: null, desbloqueadoAdmin: false, situacaoDesbloqueio: null,
  podeDesbloquear: false, liberacaoAtiva: null, liberacoesHistorico: [], ...over,
});

const LIBERACAO = {
  id: "11111111-1111-4111-8111-111111111111",
  data: "2026-09-02", motivo: "dia_nao_lancado", motivoRotulo: "Dia não lançado pela unidade",
  status: "ativo", ativo: true, criadoPorNome: "João Pedro", criadoEm: "2026-09-04T13:32:00Z",
};

// ===========================================================================
describe("estado visual do dia", () => {
  test("bloqueado pela sequência tem rótulo próprio", () => {
    const est = estadoDiaCalendario(dia({ bloqueada: true, statusDia: "BLOQUEADO" }));
    assert.equal(est.classe, "bloqueado");
    assert.match(est.rotulo, /sequência/i);
  });

  test("liberado e ainda vazio NÃO vira verde/concluído", () => {
    const est = estadoDiaCalendario(dia({ desbloqueadoAdmin: true, situacaoDesbloqueio: "aguardando_lancamento" }));
    assert.equal(est.classe, "liberado");
    assert.notEqual(est.classe, "concluido");
    assert.equal(rotuloFinanceiroDia(dia({ situacaoDesbloqueio: "aguardando_lancamento" })), "Aguardando lançamento");
  });

  test("preenchido depois da liberação vira 'Regularizado'", () => {
    const d = dia({ painel: "COMPLETO", completo: true, desbloqueadoAdmin: true, situacaoDesbloqueio: "regularizado" });
    assert.equal(estadoDiaCalendario(d).classe, "regularizado");
    assert.equal(rotuloFinanceiroDia(d), "Regularizado");
  });

  test("concluído pelo fluxo normal continua 'Lançado'", () => {
    const d = dia({ painel: "COMPLETO", completo: true });
    assert.equal(estadoDiaCalendario(d).classe, "concluido");
    assert.equal(rotuloFinanceiroDia(d), "Lançado");
  });
});

// ===========================================================================
describe("lista de dias pendentes", () => {
  test("só oferece 'Desbloquear' onde o backend disse podeDesbloquear", () => {
    const html = htmlDiasPendentes([
      dia({ data: "2026-09-02", podeDesbloquear: true }),
      dia({ data: "2026-09-03", podeDesbloquear: false, bloqueada: true }),
    ]);
    assert.ok(html.includes('data-padm-desbloquear="2026-09-02"'));
    assert.ok(!html.includes('data-padm-desbloquear="2026-09-03"'), "não inventa ação onde o backend não autorizou");
  });

  test("dia liberado e vazio oferece revogar, com procedência visível", () => {
    const html = htmlDiasPendentes([
      dia({ desbloqueadoAdmin: true, situacaoDesbloqueio: "aguardando_lancamento", liberacaoAtiva: LIBERACAO }),
    ]);
    assert.ok(html.includes(`data-padm-revogar="${LIBERACAO.id}"`));
    assert.ok(html.includes("João Pedro"));
    assert.ok(html.includes("Dia não lançado pela unidade"));
  });

  test("dia já regularizado não oferece revogar", () => {
    const html = htmlDiasPendentes([
      dia({ painel: "COMPLETO", completo: true, situacaoDesbloqueio: "regularizado", liberacaoAtiva: LIBERACAO }),
    ]);
    assert.ok(!html.includes("data-padm-revogar"));
    assert.ok(html.includes("Regularizado"));
  });

  test("dias fora de escopo (hoje/futuro/concluído normal) não entram na lista", () => {
    const html = htmlDiasPendentes([
      dia({ data: "2026-09-15", painel: "NAO_APLICAVEL", motivoNaoAplicavel: "hoje" }),
      dia({ data: "2026-09-20", painel: "NAO_APLICAVEL", motivoNaoAplicavel: "futuro" }),
      dia({ data: "2026-09-01", painel: "COMPLETO", completo: true }),
    ]);
    assert.match(html, /Nenhum dia pendente/);
  });

  test("escapa conteúdo vindo do servidor (nome de quem liberou)", () => {
    const html = htmlDiasPendentes([
      dia({
        desbloqueadoAdmin: true, situacaoDesbloqueio: "aguardando_lancamento",
        liberacaoAtiva: { ...LIBERACAO, criadoPorNome: '<img src=x onerror="alert(1)">' },
      }),
    ]);
    assert.ok(!html.includes("<img src=x"), "não injeta HTML cru");
    assert.ok(html.includes("&lt;img"));
  });
});

// ===========================================================================
describe("modal de confirmação", () => {
  test("mostra a data, avisa que é fora da sequência e que não preenche nada", () => {
    const html = htmlModalDesbloqueio({ data: "2026-09-02", unidadeNome: "Matriz Centro" });
    assert.match(html, /fora da sequência normal do Dashboard iFood/i);
    assert.match(html, /não<\/b> preenche valores nem conclui o dia/i);
    assert.ok(html.includes("Matriz Centro"));
  });

  test("lista os motivos vindos do backend, não uma cópia local", () => {
    const html = htmlModalDesbloqueio({
      data: "2026-09-02",
      motivos: { motivo_do_servidor: "Motivo definido pelo servidor" },
    });
    assert.ok(html.includes('value="motivo_do_servidor"'));
    assert.ok(html.includes("Motivo definido pelo servidor"));
    assert.ok(!html.includes("Falha operacional"), "não mistura o fallback quando o servidor mandou a lista");
  });

  test("campo de observação existe e nasce oculto (só 'Outro' revela)", () => {
    const html = htmlModalDesbloqueio({ data: "2026-09-02" });
    assert.ok(html.includes("data-padm-desb-obs-campo"));
    assert.match(html, /data-padm-desb-obs-campo[^>]*hidden/);
  });

  test("erro do servidor é exibido no modal", () => {
    const html = htmlModalDesbloqueio({ data: "2026-09-02", erro: "Este dia já está liberado para esta unidade." });
    assert.ok(html.includes("Este dia já está liberado"));
  });
});

// ===========================================================================
describe("cliente HTTP", () => {
  let capturado;
  const fetchOriginal = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = async (url, opcoes) => {
      capturado = { url, opcoes };
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ data: { ok: true } }) };
    };
  });
  afterEach(() => { globalThis.fetch = fetchOriginal; });

  test("POST envia JSON com Bearer e SEM x-context-token", async () => {
    await painelAdmApi.desbloquearDia("uni-1", { data: "2026-09-02", motivo: "dia_nao_lancado" });
    assert.equal(capturado.opcoes.method, "POST");
    assert.match(capturado.url, /\/unidades\/uni-1\/desbloqueios$/);
    assert.equal(capturado.opcoes.headers["Content-Type"], "application/json");
    assert.match(capturado.opcoes.headers.Authorization, /^Bearer /);
    assert.equal(capturado.opcoes.headers["x-context-token"], undefined);
    assert.deepEqual(JSON.parse(capturado.opcoes.body), { data: "2026-09-02", motivo: "dia_nao_lancado" });
  });

  test("DELETE aponta para a liberação, com o id na URL", async () => {
    await painelAdmApi.revogarDesbloqueio("uni-1", "lib-9");
    assert.equal(capturado.opcoes.method, "DELETE");
    assert.match(capturado.url, /\/unidades\/uni-1\/desbloqueios\/lib-9$/);
  });

  test("GET do histórico aceita o mês do período ativo", async () => {
    await painelAdmApi.desbloqueios("uni-1", "2026-09");
    assert.match(capturado.url, /\/unidades\/uni-1\/desbloqueios\?mes=2026-09$/);
    assert.equal(capturado.opcoes.method, undefined, "GET não força método");
  });
});
