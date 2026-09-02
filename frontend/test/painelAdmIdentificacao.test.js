// PAINEL ADMINISTRATIVO — identificação rápida de EMPRESAS e UNIDADES com
// pendência no Dashboard iFood.
//
// A pergunta que esta suíte protege é a do gestor, não a do código:
//   "quais empresas têm problema, quais unidades delas, de que tipo, há
//    quantos dias, e o que trato primeiro?"
//
// Construtores puros (sem DOM) para o conteúdo; fake DOM mínimo para os
// controles (filtro / agrupamento / busca).
//
// Rodar: node --test frontend/test/painelAdmIdentificacao.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---- fake DOM que entende a innerHTML das views ----------------------------
function attr(tag, nome) {
  const m = new RegExp(`${nome}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}
function fakeNode(tag) {
  return {
    _tag: tag, hidden: false, disabled: /\sdisabled/.test(tag), value: attr(tag, "value") ?? "",
    dataset: {
      padmNav: attr(tag, "data-padm-nav") ?? undefined,
      padmFiltro: attr(tag, "data-padm-filtro") ?? undefined,
      padmAgrupar: attr(tag, "data-padm-agrupar") ?? undefined,
      id: attr(tag, "data-id") ?? undefined,
      nome: attr(tag, "data-nome") ?? undefined,
      busca: attr(tag, "data-busca") ?? undefined,
    },
    id: attr(tag, "id") ?? "",
    _l: {},
    addEventListener(ev, fn) { (this._l[ev] ||= []).push(fn); },
    dispatch(ev, arg) { (this._l[ev] ?? []).forEach((f) => f(arg ?? { preventDefault() {} })); },
    focus() {}, setSelectionRange() {},
    closest() { return null; },
  };
}
let padmView;
function makeView() {
  const store = { nav: [], filtros: [], agrupar: [], inputs: {} };
  return {
    _html: "",
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      store.nav = []; store.filtros = []; store.agrupar = []; store.inputs = {};
      for (const t of this._html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
        const n = fakeNode(t);
        if (n.dataset.padmNav) store.nav.push(n);
        if (n.dataset.padmFiltro) store.filtros.push(n);
        if (n.dataset.padmAgrupar) store.agrupar.push(n);
        if (n.id) store.inputs[n.id] = n;
      }
    },
    _store: store,
  };
}
globalThis.document = {
  querySelector: (sel) => (sel === "#padm-view" ? padmView : (padmView._store.inputs[sel.slice(1)] ?? null)),
  querySelectorAll: (sel) => {
    if (sel === "[data-padm-nav]") return padmView._store.nav;
    if (sel === "[data-padm-filtro]") return padmView._store.filtros;
    if (sel === "[data-padm-agrupar]") return padmView._store.agrupar;
    return [];
  },
};
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const V = await import("../src/painelAdmViews.js");
const UI = await import("../src/painelAdmUi.js");

beforeEach(() => { padmView = makeView(); V.resetFiltrosIdentificacao(); });

// ---- fixtures --------------------------------------------------------------
const uni = (id, nome, over = {}) => ({
  unidadeId: id, unidadeNome: nome, criticidade: "em_dia", d1Status: "concluido",
  sequenciaBloqueada: false, diasPendentes: 0, pendenciaMaisAntiga: null,
  pendenciaHerdada: false, pendenciaHerdadaDesde: null, conformidadeMes: 1, ...over,
});

/** Rede Mogi: 2 críticas + 1 atenção de 4 unidades — a pior da frota. */
const REDE_MOGI = {
  organizacaoId: "o1", empresaNome: "Subway Mogi Mirim", unidadesMonitoradas: 4,
  criticas: 2, atencao: 1, emDia: 1, unidadesPendentes: 3,
  d1Elegiveis: 4, d1Concluidas: 1, d1Ok: false,
  conformidadeD1: 0.25, conformidadeMes: 0.6,
  pendenciaMaisAntiga: "2026-09-01",
  pendentes: [
    uni("u1", "Mogi Centro", { criticidade: "critico", d1Status: "sequencia_bloqueada", sequenciaBloqueada: true, diasPendentes: 4, pendenciaMaisAntiga: "2026-09-01" }),
    uni("u2", "Mogi Shopping", { criticidade: "critico", d1Status: "nao_realizado", diasPendentes: 2, pendenciaMaisAntiga: "2026-09-03", pendenciaHerdada: true, pendenciaHerdadaDesde: "2026-08-27" }),
    uni("u3", "Mogi Rodoviária", { criticidade: "atencao", d1Status: "em_preenchimento", diasPendentes: 1, pendenciaMaisAntiga: "2026-09-04" }),
  ],
};
REDE_MOGI.piorUnidade = REDE_MOGI.pendentes[0];

/** Piracicaba: 1 atenção de 2. */
const PIRACICABA = {
  organizacaoId: "o2", empresaNome: "Subway Piracicaba", unidadesMonitoradas: 2,
  criticas: 0, atencao: 1, emDia: 1, unidadesPendentes: 1,
  d1Elegiveis: 2, d1Concluidas: 1, d1Ok: false,
  conformidadeD1: 0.5, conformidadeMes: 0.9,
  pendenciaMaisAntiga: "2026-09-04",
  pendentes: [uni("u4", "Piracicaba Centro", { criticidade: "atencao", d1Status: "nao_realizado", diasPendentes: 1, pendenciaMaisAntiga: "2026-09-04" })],
};
PIRACICABA.piorUnidade = PIRACICABA.pendentes[0];

/** Limeira: saudável. */
const LIMEIRA = {
  organizacaoId: "o3", empresaNome: "Subway Limeira", unidadesMonitoradas: 2,
  criticas: 0, atencao: 0, emDia: 2, unidadesPendentes: 0,
  d1Elegiveis: 2, d1Concluidas: 2, d1Ok: true,
  conformidadeD1: 1, conformidadeMes: 1, pendenciaMaisAntiga: null,
  pendentes: [], piorUnidade: null,
};

const EMPRESAS = [REDE_MOGI, PIRACICABA, LIMEIRA];

const VISAO = {
  periodo: "2026-09", mesCorrente: true, dataReferencia: "2026-09-06", d1: "2026-09-05",
  resumo: {
    unidadesMonitoradas: 8, empresasMonitoradas: 3,
    concluidasD1: 4, emPreenchimentoD1: 1, naoRealizadasD1: 2, sequenciaBloqueadaD1: 1,
    criticas: 2, atencao: 2, emDia: 4,
    conformidadeD1: 0.5, conformidadeMes: 0.75, mesCompleto: 30, mesEsperado: 40,
    empresasComPendencia: 2, empresasCriticas: 1, unidadesComPendencia: 4, empresasSaudaveis: 1,
  },
  acaoNecessariaHoje: [
    { unidadeId: "u1", unidadeNome: "Mogi Centro", organizacaoId: "o1", empresaNome: "Subway Mogi Mirim", categoria: "sequencia_bloqueada", pendencia: { total: 4, desde: "2026-09-01" }, herdada: null },
    { unidadeId: "u2", unidadeNome: "Mogi Shopping", organizacaoId: "o1", empresaNome: "Subway Mogi Mirim", categoria: "nao_realizado", pendencia: { total: 2, desde: "2026-09-03" }, herdada: { desde: "2026-08-27", total: 5 } },
    { unidadeId: "u4", unidadeNome: "Piracicaba Centro", organizacaoId: "o2", empresaNome: "Subway Piracicaba", categoria: "nao_realizado", pendencia: { total: 1, desde: "2026-09-04" }, herdada: null },
    { unidadeId: "u3", unidadeNome: "Mogi Rodoviária", organizacaoId: "o1", empresaNome: "Subway Mogi Mirim", categoria: "em_preenchimento", pendencia: { total: 1, desde: "2026-09-04" }, herdada: null },
  ],
  empresas: EMPRESAS,
};

const antesDe = (h, a, b) => h.indexOf(a) > -1 && h.indexOf(b) > -1 && h.indexOf(a) < h.indexOf(b);

// ===========================================================================
// 1/2) empresas com pendência priorizadas; saudáveis recolhidas
// ===========================================================================
describe("1/2) empresas com pendência vêm primeiro; saudáveis ficam fora do caminho", () => {
  test("a Visão Geral abre com os contadores de PENDÊNCIA, não com totais genéricos", () => {
    const h = V.htmlVisaoGeral(VISAO);
    assert.match(h, /Empresas com pendência/);
    assert.match(h, /Unidades com pendência/);
    assert.ok(antesDe(h, "Empresas com pendência", "Conformidade D-1"), "pendência lidera o topo");
  });

  test("só as empresas com pendência entram na seção principal", () => {
    const h = V.htmlVisaoGeral(VISAO);
    const secao = h.slice(h.indexOf("Empresas com pendência"), h.indexOf("padm-saudaveis"));
    assert.match(secao, /Subway Mogi Mirim/);
    assert.match(secao, /Subway Piracicaba/);
    assert.ok(!secao.includes("Subway Limeira"), "empresa saudável não polui a seção de problema");
  });

  test("a empresa mais grave aparece antes da menos grave", () => {
    const h = V.htmlVisaoGeral(VISAO);
    assert.ok(antesDe(h, "Subway Mogi Mirim", "Subway Piracicaba"), "2 críticas antes de 0 críticas");
  });

  test("as saudáveis vão para um bloco recolhido, nomeadas mas discretas", () => {
    const h = V.htmlVisaoGeral(VISAO);
    assert.match(h, /padm-saudaveis/);
    assert.match(h, /1 empresa\(s\) sem pendência/);
    assert.ok(antesDe(h, "Subway Piracicaba", "padm-saudaveis"), "recolhidas ficam no fim");
  });

  test("nenhuma empresa com pendência -> estado positivo explícito", () => {
    const h = V.htmlVisaoGeral({ ...VISAO, empresas: [LIMEIRA], resumo: { ...VISAO.resumo, empresasComPendencia: 0, unidadesComPendencia: 0 } });
    assert.match(h, /Nenhuma empresa com pendência/i);
  });
});

// ===========================================================================
// 3/7) quais UNIDADES da empresa estão pendentes — sem trocar de tela
// ===========================================================================
describe("3/7) as unidades pendentes aparecem dentro da empresa", () => {
  test("o bloco da empresa lista as unidades pendentes com tipo e dias", () => {
    const h = UI.blocoEmpresa(REDE_MOGI);
    assert.match(h, /Mogi Centro/);
    assert.match(h, /Mogi Shopping/);
    assert.match(h, /Mogi Rodoviária/);
    assert.match(h, /Sequência travada/);
    assert.match(h, /Não iniciado/);
    assert.match(h, /Em aberto/);
    assert.match(h, /4 dias/);
    assert.match(h, /Unidades com pendência \(3\)/);
  });

  test("empresa com pendência nasce EXPANDIDA; saudável nasce recolhida", () => {
    assert.match(UI.blocoEmpresa(REDE_MOGI), /<details[^>]*\sopen/);
    assert.ok(!/<details[^>]*\sopen/.test(UI.blocoEmpresa(LIMEIRA)), "saudável não ocupa espaço aberta");
  });

  test("cada unidade pendente é um alvo de navegação para o calendário", () => {
    padmView.innerHTML = UI.blocoEmpresa(REDE_MOGI);
    const alvos = padmView._store.nav.filter((n) => n.dataset.padmNav === "unidade");
    assert.deepEqual(alvos.map((n) => n.dataset.id), ["u1", "u2", "u3"]);
    assert.equal(alvos[0].dataset.nome, "Mogi Centro");
  });

  test("empresa saudável mostra a confirmação, não uma lista vazia", () => {
    const h = UI.blocoEmpresa(LIMEIRA);
    assert.match(h, /Todas as unidades em dia neste período/i);
    assert.match(h, /Sem pendência/);
  });

  test("a unidade herdada carrega a nota, sem somar na métrica do mês", () => {
    const h = UI.blocoEmpresa(REDE_MOGI);
    assert.match(h, /vem de 27\/08/);
    assert.ok(!/5 dias/.test(h), "o histórico não vira contagem do período");
  });
});

// ===========================================================================
// 8/9) resumo executivo e "pior unidade"
// ===========================================================================
describe("8/9) resumo executivo por empresa e unidade prioritária", () => {
  test("o resumo traz unidades, pendentes, críticas, atenção, D-1 e conformidades", () => {
    const h = UI.blocoEmpresa(REDE_MOGI);
    for (const rot of ["Unidades", "Pendentes", "Críticas", "Atenção", "D-1 fechado", "Conf. D-1", "Conf. mês"]) {
      assert.match(h, new RegExp(rot.replace(".", "\\.")), rot);
    }
    assert.match(h, /<small>Pendentes<\/small><b>3<\/b>/);
    assert.match(h, /<small>D-1 fechado<\/small><b>Não<\/b>/);
  });

  test("D-1 fechado = 'Sim' quando todas as elegíveis concluíram", () => {
    assert.match(UI.blocoEmpresa(LIMEIRA), /<small>D-1 fechado<\/small><b>Sim<\/b>/);
  });

  test("a pior unidade aparece como 'Prioridade' no cabeçalho da empresa", () => {
    const h = UI.blocoEmpresa(REDE_MOGI);
    assert.match(h, /Prioridade:/);
    assert.match(h, /Prioridade:[\s\S]{0,120}Mogi Centro/);
  });

  test("o selo conta as unidades pendentes e pega o tom da pior", () => {
    assert.match(UI.seloPendencia(REDE_MOGI), /3 unidades pendentes/);
    assert.match(UI.seloPendencia(REDE_MOGI), /padm-selo--critico/);
    assert.match(UI.seloPendencia(PIRACICABA), /1 unidade pendente/);
    assert.match(UI.seloPendencia(PIRACICABA), /padm-selo--atencao/);
    assert.match(UI.seloPendencia(LIMEIRA), /Sem pendência/);
  });

  test("qtdPendentes cai para críticas+atenção se o contrato não trouxer o campo", () => {
    assert.equal(UI.qtdPendentes({ unidadesPendentes: 3 }), 3);
    assert.equal(UI.qtdPendentes({ criticas: 2, atencao: 1 }), 3);
    assert.equal(UI.qtdPendentes({ criticas: 0, atencao: 0 }), 0);
  });
});

// ===========================================================================
// Saúde DO PERÍODO x histórico anterior (caso Pastel Di Féra)
// ===========================================================================
describe("empresa saudável no período, com histórico anterior", () => {
  const PASTEL = {
    organizacaoId: "o9", empresaNome: "Pastel Di Féra Sim - Feira de Santana - BA",
    unidadesMonitoradas: 1, criticas: 0, atencao: 0, emDia: 1, unidadesPendentes: 0,
    d1Elegiveis: 1, d1Concluidas: 1, d1Ok: true, conformidadeD1: 1, conformidadeMes: 1,
    pendentes: [], piorUnidade: null, severidade: 2,
    historicoAnterior: { existe: true, desde: "2026-08-29", unidades: 1 },
  };

  test("o card fica SAUDÁVEL, com selo 'Sem pendência' — nada de vermelho", () => {
    const h = UI.blocoEmpresa(PASTEL);
    assert.match(h, /padm-emp--ok/, "tom saudável");
    assert.match(h, /Sem pendência/);
    assert.match(h, /padm-chip--ok">Saudável/);
    assert.ok(!/padm-emp--critico|padm-selo--critico/.test(h), "nenhum tom crítico");
  });

  test("o histórico aparece como nota neutra, não como status", () => {
    const h = UI.blocoEmpresa(PASTEL);
    assert.match(h, /padm-hist-nota/);
    assert.match(h, /Há histórico anterior ao período/);
    assert.match(h, /desde 29\/08/);
    // a nota é cinza/tracejada — nunca usa as classes de criticidade
    assert.ok(!/padm-hist-nota[^>]*critico/.test(h));
  });

  test("o resumo mostra 0 pendentes / 0 críticas / 1 em dia", () => {
    const h = UI.blocoEmpresa(PASTEL);
    assert.match(h, /<small>Pendentes<\/small><b>0<\/b>/);
    assert.match(h, /<small>Críticas<\/small><b>0<\/b>/);
    assert.match(h, /<small>D-1 fechado<\/small><b>Sim<\/b>/);
    assert.match(h, /Todas as unidades em dia neste período/i);
  });

  test("nasce RECOLHIDA (não há pendência para revelar)", () => {
    assert.ok(!/<details[^>]*\sopen/.test(UI.blocoEmpresa(PASTEL)));
  });

  test("sem histórico, nenhuma nota é renderizada", () => {
    const h = UI.blocoEmpresa({ ...PASTEL, historicoAnterior: { existe: false, desde: null, unidades: 0 } });
    assert.ok(!/padm-hist-nota/.test(h));
  });

  test("na Visão Geral ela cai no bloco das saudáveis, não no de pendência", () => {
    const h = V.htmlVisaoGeral({
      ...VISAO,
      resumo: { ...VISAO.resumo, empresasComPendencia: 1, unidadesComPendencia: 3, empresasSaudaveis: 1 },
      empresas: [REDE_MOGI, PASTEL],
    });
    const principal = h.slice(h.indexOf("Empresas com pendência"), h.indexOf("padm-saudaveis"));
    assert.match(principal, /Subway Mogi Mirim/);
    assert.ok(!principal.includes("Pastel Di Féra"), "saudável não entra na seção de problema");
    assert.match(h, /1 empresa\(s\) sem pendência/);
  });

  test("o filtro 'Saudáveis' a encontra; 'Com pendência' não", () => {
    const lista = [REDE_MOGI, PASTEL];
    assert.deepEqual(UI.filtrarEmpresas(lista, "saudaveis").map((e) => e.organizacaoId), ["o9"]);
    assert.deepEqual(UI.filtrarEmpresas(lista, "pendencia").map((e) => e.organizacaoId), ["o1"]);
    assert.equal(UI.qtdPendentes(PASTEL), 0);
  });
});

// ===========================================================================
// 4) filtros por severidade
// ===========================================================================
describe("4) filtros da tela Empresas", () => {
  const dados = { periodo: "2026-09", mesCorrente: true, d1: "2026-09-05", empresas: EMPRESAS };

  test("filtrarEmpresas separa com pendência / críticas / atenção / saudáveis", () => {
    assert.equal(UI.filtrarEmpresas(EMPRESAS, "todas").length, 3);
    assert.deepEqual(UI.filtrarEmpresas(EMPRESAS, "pendencia").map((e) => e.empresaNome), ["Subway Mogi Mirim", "Subway Piracicaba"]);
    assert.deepEqual(UI.filtrarEmpresas(EMPRESAS, "criticas").map((e) => e.empresaNome), ["Subway Mogi Mirim"]);
    assert.deepEqual(UI.filtrarEmpresas(EMPRESAS, "atencao").map((e) => e.empresaNome), ["Subway Piracicaba"]);
    assert.deepEqual(UI.filtrarEmpresas(EMPRESAS, "saudaveis").map((e) => e.empresaNome), ["Subway Limeira"]);
  });

  test("os segmentos mostram a contagem de cada recorte", () => {
    const c = UI.contagensEmpresas(EMPRESAS);
    assert.deepEqual(c, { todas: 3, pendencia: 2, criticas: 1, atencao: 1, saudaveis: 1 });
    const h = UI.filtroSeveridade("criticas", c);
    assert.match(h, /class="padm-segm-btn ativo" data-padm-filtro="criticas"/);
  });

  test("aplicar 'críticas' deixa só a empresa crítica na tela", () => {
    const h = V.htmlEmpresas(dados, { filtro: "criticas", termo: "" });
    assert.match(h, /Subway Mogi Mirim/);
    assert.ok(!h.includes("Subway Limeira"));
    assert.ok(!h.includes("Subway Piracicaba"));
  });

  test("clicar num segmento repinta sem nova chamada de rede", async () => {
    let chamadas = 0;
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {} });
    const api = { empresas: async () => { chamadas++; return dados; } };
    await V.renderViewPadm({ tipo: "tela", id: "empresas" }, { api, mes: "2026-09" });
    assert.equal(chamadas, 1);

    padmView._store.filtros.find((b) => b.dataset.padmFiltro === "criticas").dispatch("click");
    assert.equal(chamadas, 1, "filtrar não refaz a chamada");
    assert.match(padmView.innerHTML, /Subway Mogi Mirim/);
    assert.ok(!padmView.innerHTML.includes("Subway Limeira"));
    assert.equal(V.viewEmpresas.filtro, "criticas");
  });

  test("filtro sem resultado -> estado vazio explicativo", () => {
    const h = V.htmlEmpresas({ ...dados, empresas: [LIMEIRA] }, { filtro: "criticas", termo: "" });
    assert.match(h, /Nenhuma empresa neste filtro/i);
  });
});

// ===========================================================================
// 5) busca encontra empresa E unidade, com destaque
// ===========================================================================
describe("5) busca por empresa e por unidade", () => {
  const dados = { periodo: "2026-09", mesCorrente: true, d1: "2026-09-05", empresas: EMPRESAS };

  test("'Mogi' acha a empresa e destaca o termo", () => {
    const h = V.htmlEmpresas(dados, { filtro: "todas", termo: "Mogi" });
    assert.match(h, /<mark class="padm-mark">Mogi<\/mark>/);
    assert.ok(!h.includes("Subway Limeira"));
  });

  test("'Piracicaba' acha pelo nome da empresa", () => {
    const h = V.htmlEmpresas(dados, { filtro: "todas", termo: "Piracicaba" });
    assert.match(h, /Subway <mark class="padm-mark">Piracicaba<\/mark>/);
    assert.ok(!h.includes("Subway Limeira"));
  });

  test("'Rodoviária' acha a EMPRESA pela unidade pendente dela", () => {
    const h = V.htmlEmpresas(dados, { filtro: "todas", termo: "Rodoviaria" });
    assert.match(h, /Subway Mogi Mirim/, "a empresa dona da unidade continua visível");
    assert.match(h, /padm-mark/);
    assert.ok(!h.includes("Subway Piracicaba"));
  });

  test("a busca ignora acento e caixa", () => {
    assert.match(V.htmlEmpresas(dados, { filtro: "todas", termo: "RODOVIÁRIA" }), /Subway Mogi Mirim/);
    assert.match(V.htmlEmpresas(dados, { filtro: "todas", termo: "mogi" }), /padm-mark/);
  });

  test("busca sem resultado explica o que ela cobre", () => {
    const h = V.htmlEmpresas(dados, { filtro: "todas", termo: "Xyzzy" });
    assert.match(h, /Nada encontrado para &quot;Xyzzy&quot;/);
    assert.match(h, /nome da empresa e das unidades/i);
  });

  test("realce não quebra o escape de HTML", () => {
    assert.match(UI.realce('<script>x</script>', ""), /&lt;script&gt;/);
    assert.ok(!UI.realce('<script>alert(1)</script>', "script").includes("<script>"));
  });
});

// ===========================================================================
// 6) agrupamento da tela Pendências
// ===========================================================================
describe("6) agrupamento da fila de Pendências", () => {
  const FILA = {
    periodo: "2026-09", mesCorrente: true, d1: "2026-09-05",
    unidades: [
      { organizacaoId: "o1", empresaNome: "Subway Mogi Mirim", unidadeId: "u1", unidadeNome: "Mogi Centro", criticidade: "critico", d1Status: "sequencia_bloqueada", sequenciaBloqueada: true, diasPendentes: 4, pendenciaMaisAntiga: "2026-09-01", pendenciaHerdada: false, pendenciaHerdadaDesde: null },
      { organizacaoId: "o1", empresaNome: "Subway Mogi Mirim", unidadeId: "u2", unidadeNome: "Mogi Shopping", criticidade: "critico", d1Status: "nao_realizado", sequenciaBloqueada: true, diasPendentes: 2, pendenciaMaisAntiga: "2026-09-03", pendenciaHerdada: true, pendenciaHerdadaDesde: "2026-08-27" },
      { organizacaoId: "o2", empresaNome: "Subway Piracicaba", unidadeId: "u4", unidadeNome: "Piracicaba Centro", criticidade: "atencao", d1Status: "nao_realizado", sequenciaBloqueada: false, diasPendentes: 1, pendenciaMaisAntiga: "2026-09-04", pendenciaHerdada: false, pendenciaHerdadaDesde: null },
      { organizacaoId: "o1", empresaNome: "Subway Mogi Mirim", unidadeId: "u3", unidadeNome: "Mogi Rodoviária", criticidade: "atencao", d1Status: "em_preenchimento", sequenciaBloqueada: false, diasPendentes: 1, pendenciaMaisAntiga: "2026-09-04", pendenciaHerdada: false, pendenciaHerdadaDesde: null },
    ],
  };

  test("por empresa (padrão): um grupo por empresa, com a contagem", () => {
    const h = V.htmlPendencias(FILA, { agrupar: "empresa", filtro: "todas", termo: "" });
    assert.match(h, /Subway Mogi Mirim[\s\S]{0,200}padm-grupo-cont">3</);
    assert.match(h, /Subway Piracicaba[\s\S]{0,200}padm-grupo-cont">1</);
    assert.ok(antesDe(h, "Subway Mogi Mirim", "Subway Piracicaba"), "a fila do backend define a ordem dos grupos");
  });

  test("por empresa: cada grupo tem atalho para o detalhe da empresa", () => {
    padmView.innerHTML = V.htmlPendencias(FILA, { agrupar: "empresa", filtro: "todas", termo: "" });
    const atalhos = padmView._store.nav.filter((n) => n.dataset.padmNav === "empresa");
    assert.deepEqual(atalhos.map((n) => n.dataset.id), ["o1", "o2"]);
  });

  test("por tipo: agrupa por status, na ordem de gravidade", () => {
    const h = V.htmlPendencias(FILA, { agrupar: "status", filtro: "todas", termo: "" });
    assert.ok(antesDe(h, "Sequência travada", "Não iniciado"));
    assert.ok(antesDe(h, "Não iniciado", "Em aberto"));
    assert.match(h, /O fechamento de ontem não foi iniciado/);
  });

  test("trocar o agrupamento repinta sem nova chamada de rede", async () => {
    let chamadas = 0;
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {} });
    const api = { pendencias: async () => { chamadas++; return FILA; } };
    await V.renderViewPadm({ tipo: "tela", id: "pendencias" }, { api, mes: "2026-09" });
    assert.equal(chamadas, 1);
    assert.match(padmView.innerHTML, /Subway Mogi Mirim/);

    padmView._store.agrupar.find((b) => b.dataset.padmAgrupar === "status").dispatch("click");
    assert.equal(chamadas, 1, "reagrupar não refaz a chamada");
    assert.equal(V.viewPendencias.agrupar, "status");
    assert.match(padmView.innerHTML, /Sequência travada/);
  });

  test("filtro 'sequência travada' isola só as unidades travadas", () => {
    const h = V.htmlPendencias(FILA, { agrupar: "empresa", filtro: "travadas", termo: "" });
    assert.match(h, /Mogi Centro/);
    assert.match(h, /Mogi Shopping/);
    assert.ok(!h.includes("Piracicaba Centro"));
    assert.ok(!h.includes("Mogi Rodoviária"));
  });

  test("busca na fila encontra por empresa e por unidade", () => {
    const porUnidade = V.htmlPendencias(FILA, { agrupar: "empresa", filtro: "todas", termo: "Shopping" });
    assert.match(porUnidade, /<mark class="padm-mark">Shopping<\/mark>/);
    assert.ok(!porUnidade.includes("Piracicaba Centro"));

    const porEmpresa = V.htmlPendencias(FILA, { agrupar: "empresa", filtro: "todas", termo: "Piracicaba" });
    assert.match(porEmpresa, /Piracicaba Centro/);
    assert.ok(!porEmpresa.includes("Mogi Centro"));
  });

  test("a linha da fila mostra empresa, unidade, tipo, dias no período e herança", () => {
    const h = V.htmlPendencias(FILA, { agrupar: "empresa", filtro: "todas", termo: "" });
    assert.match(h, /Subway Mogi Mirim/);
    assert.match(h, /Mogi Shopping/);
    assert.match(h, /2 dias/);
    assert.match(h, /desde 03\/09/);
    assert.match(h, /vem de 27\/08/);
    assert.match(h, /travada/);
  });
});

// ===========================================================================
// 10) detalhe da empresa — pendentes separadas das em dia
// ===========================================================================
describe("detalhe da empresa: pendentes separadas das em dia", () => {
  const DET = {
    periodo: "2026-09", mesCorrente: true, d1: "2026-09-05",
    organizacao: { organizacaoId: "o1", nome: "Subway Mogi Mirim", status: "ativa" },
    consolidado: { criticas: 2, atencao: 1, emDia: 1, conformidadeD1: 0.25, conformidadeMes: 0.6 },
    resumo: REDE_MOGI,
    unidades: [
      { unidadeId: "u1", unidadeNome: "Mogi Centro", criticidade: "critico", d1Status: "sequencia_bloqueada", diasPendentes: 4, conformidadeMes: 0.4, pendenciaHerdada: false },
      { unidadeId: "u3", unidadeNome: "Mogi Rodoviária", criticidade: "atencao", d1Status: "em_preenchimento", diasPendentes: 1, conformidadeMes: 0.8, pendenciaHerdada: false },
      { unidadeId: "u5", unidadeNome: "Mogi Norte", criticidade: "em_dia", d1Status: "concluido", diasPendentes: 0, conformidadeMes: 1, pendenciaHerdada: false },
    ],
    pendencias: [],
  };

  test("as pendentes ficam na seção principal; as em dia num bloco recolhido", () => {
    const h = V.htmlDetalheEmpresa(DET);
    assert.match(h, /Unidades com pendência/);
    const principal = h.slice(h.indexOf("Unidades com pendência"), h.indexOf("padm-saudaveis"));
    assert.match(principal, /Mogi Centro/);
    assert.match(principal, /Mogi Rodoviária/);
    assert.ok(!principal.includes("Mogi Norte"), "unidade em dia não ocupa a seção de problema");
    assert.match(h, /1 unidade\(s\) em dia/);
  });

  test("o cartão 'Com pendência' conta certo e ganha destaque", () => {
    const h = V.htmlDetalheEmpresa(DET);
    assert.match(h, /Com pendência/);
    assert.match(h, /padm-card--destaque/);
  });

  test("a unidade prioritária aparece em faixa própria", () => {
    const h = V.htmlDetalheEmpresa(DET);
    assert.match(h, /padm-prioridade/);
    assert.match(h, /Prioridade:[\s\S]{0,120}Mogi Centro/);
    assert.match(h, /Sequência travada/);
  });

  test("cada linha explica o status em linguagem operacional", () => {
    const h = V.htmlDetalheEmpresa(DET);
    assert.match(h, /Há dia\(s\) sem lançamento travando os seguintes/);
    assert.match(h, /O financeiro de ontem ainda está em aberto/);
  });

  test("empresa sem pendência -> seção positiva, sem bloco recolhido vazio", () => {
    const h = V.htmlDetalheEmpresa({
      ...DET, consolidado: { criticas: 0, atencao: 0, emDia: 1, conformidadeD1: 1, conformidadeMes: 1 },
      resumo: LIMEIRA,
      unidades: [{ unidadeId: "u5", unidadeNome: "Mogi Norte", criticidade: "em_dia", d1Status: "concluido", diasPendentes: 0, conformidadeMes: 1 }],
    });
    assert.match(h, /Nenhuma unidade pendente/i);
  });
});

// ===========================================================================
// 11/12) período preservado, sem x-context-token, estados
// ===========================================================================
describe("11/12) período, contrato e estados", () => {
  test("o período ativo vai nas chamadas de Empresas e Pendências", async () => {
    const vistos = [];
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {} });
    const api = {
      empresas: async (a) => { vistos.push(["empresas", a]); return { empresas: EMPRESAS, periodo: "2026-08" }; },
      pendencias: async (a) => { vistos.push(["pendencias", a]); return { unidades: [] }; },
    };
    await V.renderViewPadm({ tipo: "tela", id: "empresas" }, { api, mes: "2026-08" });
    await V.renderViewPadm({ tipo: "tela", id: "pendencias" }, { api, mes: "2026-08" });
    assert.deepEqual(vistos, [["empresas", { mes: "2026-08" }], ["pendencias", { mes: "2026-08" }]]);
  });

  test("filtrar/reagrupar preserva o período já carregado", async () => {
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {} });
    const dados = { empresas: EMPRESAS, periodo: "2026-08", mesCorrente: false, d1: "2026-08-31" };
    await V.renderViewPadm({ tipo: "tela", id: "empresas" }, { api: { empresas: async () => dados }, mes: "2026-08" });
    padmView._store.filtros.find((b) => b.dataset.padmFiltro === "criticas").dispatch("click");
    assert.match(padmView.innerHTML, /Agosto 2026/, "a faixa do período continua correta");
    assert.match(padmView.innerHTML, /mês fechado/);
  });

  test("loading aparece antes de resolver", async () => {
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {} });
    let liberar;
    const api = { empresas: () => new Promise((r) => { liberar = () => r({ empresas: EMPRESAS }); }) };
    const p = V.renderViewPadm({ tipo: "tela", id: "empresas" }, { api });
    assert.match(padmView.innerHTML, /padm-sk|Carregando/i);
    liberar();
    await p;
    assert.match(padmView.innerHTML, /Subway Mogi Mirim/);
  });

  test("erro de rede na tela Empresas mostra falha de conexão, não acesso revogado", async () => {
    let revogado = 0;
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {}, aoAcessoRevogado: () => revogado++ });
    await V.renderViewPadm({ tipo: "tela", id: "empresas" }, { api: { empresas: async () => { throw new Error("Failed to fetch"); } } });
    assert.equal(revogado, 0);
    assert.match(padmView.innerHTML, /conex/i);
  });

  test("403 na tela Pendências volta para a seleção de ambiente", async () => {
    let msg = null;
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {}, aoAcessoRevogado: (m) => { msg = m; } });
    const err = Object.assign(new Error("Acesso restrito ao Painel Administrativo."), { status: 403 });
    await V.renderViewPadm({ tipo: "tela", id: "pendencias" }, { api: { pendencias: async () => { throw err; } } });
    assert.match(msg, /Painel Administrativo/);
  });

  test("nenhuma view monta cabeçalho de contexto tenant", async () => {
    const fs = await import("node:fs");
    const semComentarios = (arq) => fs.readFileSync(new URL(arq, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const arq of ["../src/painelAdmViews.js", "../src/painelAdmUi.js", "../src/painelAdmApi.js"]) {
      assert.ok(!/x-context-token|contextToken|req\.tenant/i.test(semComentarios(arq)), arq);
    }
  });
});
