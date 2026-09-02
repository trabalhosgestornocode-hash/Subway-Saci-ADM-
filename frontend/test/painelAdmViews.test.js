// Telas do Painel Administrativo (painelAdmViews.js + painelAdmUi.js).
// Fase G: construtores puros + orquestrador. Cobre os itens 17.A–M do pedido.
//
// A maioria dos casos testa CONSTRUTORES PUROS (htmlX(dados) -> string), sem
// DOM. Os casos de navegação/loading usam um fake DOM que extrai da innerHTML
// os elementos com data-padm-nav / data-padm-acao / selects de filtro.
//
// Rodar: node --test frontend/test/painelAdmViews.test.js
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---- fake DOM que "entende" a innerHTML das views ----
function attr(tag, nome) {
  const m = new RegExp(`${nome}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}
function fakeNode(tag) {
  return {
    _tag: tag, hidden: false, disabled: /disabled/.test(tag), value: attr(tag, "value") ?? "",
    dataset: {
      padmNav: attr(tag, "data-padm-nav") ?? undefined,
      padmAcao: attr(tag, "data-padm-acao") ?? undefined,
      id: attr(tag, "data-id") ?? undefined,
      nome: attr(tag, "data-nome") ?? undefined,
      busca: attr(tag, "data-busca") ?? undefined,
    },
    id: attr(tag, "id") ?? "",
    _l: {},
    addEventListener(ev, fn) { (this._l[ev] ||= []).push(fn); },
    dispatch(ev, arg) { (this._l[ev] ?? []).forEach((f) => f(arg ?? { preventDefault() {}, key: "Enter" })); },
    closest(sel) {
      const m = /\[data-padm-acao="([^"]+)"\]/.exec(sel);
      if (m) return this.dataset.padmAcao === m[1] ? this : null;
      return null;
    },
  };
}
let padmView;
function makeView() {
  const store = { nav: [], acao: [], selects: {}, search: [], busca: [] };
  return {
    _html: "",
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      store.nav = []; store.acao = []; store.selects = {}; store.search = []; store.busca = [];
      const tags = this._html.match(/<[a-zA-Z][^>]*>/g) ?? [];
      for (const t of tags) {
        const n = fakeNode(t);
        if (n.dataset.padmNav) store.nav.push(n);
        if (n.dataset.padmAcao) store.acao.push(n);
        if (n.dataset.busca !== undefined) store.busca.push(n);
        if (/id="(padm-f-[a-z]+)"/.test(t)) store.selects[n.id] = n;
        if (/type="search"/.test(t) && /id="padm-busca/.test(t)) store.search.push(n);
      }
    },
    _store: store,
  };
}
let nodes = {};
globalThis.document = {
  querySelector: (sel) => {
    if (sel === "#padm-view") return padmView;
    const a = /\[data-padm-acao="([^"]+)"\]/.exec(sel);
    if (a) return padmView._store.acao.find((n) => n.dataset.padmAcao === a[1]) ?? null;
    if (sel.startsWith("#padm-f-")) return padmView._store.selects[sel.slice(1)] ?? null;
    return nodes[sel] ?? null;
  },
  querySelectorAll: (sel) => {
    if (sel === "[data-padm-nav]") return padmView._store.nav;
    if (sel === "[data-busca]") return padmView._store.busca;
    if (sel.includes('type="search"')) return padmView._store.search;
    return [];
  },
};
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const V = await import("../src/painelAdmViews.js");
const UI = await import("../src/painelAdmUi.js");

beforeEach(() => { padmView = makeView(); nodes = {}; V.resetFiltrosDiario(); });

// ===========================================================================
// A) Visão Geral renderiza o resumo
// ===========================================================================
const RESUMO = {
  dataReferencia: "2026-09-15", d1: "2026-09-14",
  resumo: {
    unidadesMonitoradas: 6, empresasMonitoradas: 3, concluidasD1: 4, emPreenchimentoD1: 1,
    naoRealizadasD1: 1, sequenciaBloqueadaD1: 0, criticas: 0, atencao: 2, emDia: 4,
    conformidadeD1: 0.6667, conformidadeMes: 0.94, mesCompleto: 79, mesEsperado: 84,
  },
  acaoNecessariaHoje: [], empresas: [],
};

describe("A) Visão Geral — resumo", () => {
  test("mostra os cartões com os valores recebidos", () => {
    const h = V.htmlVisaoGeral(RESUMO);
    assert.match(h, /Unidades monitoradas/);
    assert.match(h, /Conformidade D-1/);
    assert.match(h, /Conformidade do mês/);
    assert.match(h, />6<|>\s*6\s*</); // unidades
    assert.match(h, /67%/);           // 0.6667 -> 67%
    assert.match(h, /94%/);
    assert.match(h, /79 de 84 dias/);
    assert.match(h, /14\/09\/2026/);  // fechamento cobrado
  });
});

// ===========================================================================
// B) conformidade null -> "—" / estado vazio
// ===========================================================================
describe("B) conformidade null", () => {
  test("fmtConformidade(null) -> texto '—' + nota 'Sem unidades elegíveis'", () => {
    const c = UI.fmtConformidade(null);
    assert.equal(c.texto, "—");
    assert.equal(c.vazio, true);
    assert.match(c.nota, /Sem unidades eleg/i);
  });

  test("Visão Geral com conformidadeD1 null não inventa 0%", () => {
    const h = V.htmlVisaoGeral({ ...RESUMO, resumo: { ...RESUMO.resumo, conformidadeD1: null } });
    assert.match(h, /—/);
    assert.match(h, /Sem unidades eleg/i);
    assert.ok(!/D-1<\/span>\s*<span class="padm-card-valor">0%/.test(h), "não mostra 0% falso");
  });

  test("fmtPct(null) -> '—' ; fmtPct(0) -> '0%' (zero real é diferente de null)", () => {
    assert.equal(UI.fmtPct(null), "—");
    assert.equal(UI.fmtPct(0), "0%");
  });
});

// ===========================================================================
// C) Ação necessária respeita as categorias recebidas
// ===========================================================================
describe("C) Ação necessária hoje — categorias e ordem", () => {
  const acao = [
    { unidadeId: "u1", unidadeNome: "Alfa Centro", organizacaoId: "o1", empresaNome: "Alfa", categoria: "concluido", pendencia: null },
    { unidadeId: "u2", unidadeNome: "Beta Sul", organizacaoId: "o2", empresaNome: "Beta", categoria: "nao_realizado", pendencia: null },
    { unidadeId: "u3", unidadeNome: "Gama Praia", organizacaoId: "o3", empresaNome: "Gama", categoria: "sequencia_bloqueada", pendencia: { total: 3, desde: "2026-09-10" } },
    { unidadeId: "u4", unidadeNome: "Delta Norte", organizacaoId: "o4", empresaNome: "Delta", categoria: "em_preenchimento", pendencia: null },
  ];

  test("grupos na ordem fixa: bloqueada -> não realizado -> em preenchimento (concluído fora)", () => {
    const h = V.htmlVisaoGeral({ ...RESUMO, acaoNecessariaHoje: acao });
    const iBloq = h.indexOf("Sequência bloqueada");
    const iNao = h.indexOf("Não realizado");
    const iPre = h.indexOf("Em preenchimento");
    assert.ok(iBloq > -1 && iNao > -1 && iPre > -1);
    assert.ok(iBloq < iNao && iNao < iPre, "ordem dos grupos");
  });

  test("unidade concluída NÃO entra na lista de pendências de ação", () => {
    const h = V.htmlVisaoGeral({ ...RESUMO, acaoNecessariaHoje: acao });
    assert.ok(!h.includes("Alfa Centro"), "concluída fora da Ação Necessária");
    assert.match(h, /Beta Sul/);
    assert.match(h, /Gama Praia/);
  });

  test("pendência acumulada aparece com dias e data de início", () => {
    const h = V.htmlVisaoGeral({ ...RESUMO, acaoNecessariaHoje: acao });
    assert.match(h, /3 dias/);
    assert.match(h, /desde 10\/09/);
  });

  test("tudo concluído -> estado vazio 'Nada pendente para hoje'", () => {
    const h = V.htmlVisaoGeral({ ...RESUMO, acaoNecessariaHoje: [acao[0]] });
    assert.match(h, /Nada pendente para hoje/i);
  });
});

// ===========================================================================
// D) Empresa abre detalhe   E) Detalhe abre calendário
// ===========================================================================
describe("D/E) navegação interna (pilha, sem contexto tenant)", () => {
  const empresasFake = {
    empresas: [
      { organizacaoId: "o1", empresaNome: "Alfa", unidadesMonitoradas: 2, criticas: 1, atencao: 0, emDia: 1, conformidadeD1: 0.5, conformidadeMes: 0.8 },
      { organizacaoId: "o2", empresaNome: "Beta", unidadesMonitoradas: 1, criticas: 0, atencao: 0, emDia: 1, conformidadeD1: 1, conformidadeMes: 1 },
    ],
  };
  const detalheFake = {
    d1: "2026-09-14",
    organizacao: { organizacaoId: "o1", nome: "Alfa", status: "ativa" },
    consolidado: { criticas: 1, atencao: 0, emDia: 1, conformidadeD1: 0.5, conformidadeMes: 0.8 },
    unidades: [{ unidadeId: "u1", unidadeNome: "Alfa Centro", criticidade: "critico", d1Status: "sequencia_bloqueada", diasPendentes: 3, conformidadeMes: 0.7 }],
    pendencias: [],
  };

  test("D) clicar numa empresa chama o gancho abrirEmpresa(id, nome)", async () => {
    const chamadas = [];
    V.ligarNavegacao({ abrirEmpresa: (id, nome) => chamadas.push(["empresa", id, nome]), abrirUnidade: () => {}, voltar: () => {} });
    await V.renderViewPadm({ tipo: "tela", id: "empresas" }, { api: { empresas: async () => empresasFake } });
    const card = padmView._store.nav.find((n) => n.dataset.id === "o1");
    assert.ok(card, "há um alvo de navegação para a empresa o1");
    card.dispatch("click");
    assert.deepEqual(chamadas[0], ["empresa", "o1", "Alfa"]);
  });

  test("E) no detalhe da empresa, clicar numa unidade chama abrirUnidade(id, nome)", async () => {
    const chamadas = [];
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: (id, nome) => chamadas.push(["unidade", id, nome]), voltar: () => {} });
    await V.renderViewPadm({ tipo: "empresa", empresaId: "o1", empresaNome: "Alfa" }, { api: { detalheEmpresa: async () => detalheFake } });
    assert.match(padmView.innerHTML, /Alfa/);
    const linha = padmView._store.nav.find((n) => n.dataset.id === "u1");
    assert.ok(linha);
    linha.dispatch("click");
    assert.deepEqual(chamadas[0], ["unidade", "u1", "Alfa Centro"]);
  });

  test("E) 'Voltar' no detalhe chama o gancho voltar", async () => {
    let voltou = 0;
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => voltou++ });
    await V.renderViewPadm({ tipo: "empresa", empresaId: "o1" }, { api: { detalheEmpresa: async () => detalheFake } });
    document.querySelector('[data-padm-acao="voltar"]').dispatch("click");
    assert.equal(voltou, 1);
  });
});

// ===========================================================================
// F) filtros do monitoramento geram a query correta
// ===========================================================================
describe("F) Monitoramento Diário — filtros server-side", () => {
  test("mudar um <select> de filtro refaz a chamada com o filtro aplicado", async () => {
    const chamadas = [];
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {} });
    const api = {
      monitoramentoDiario: async (f) => { chamadas.push(f); return { referencia: "2026-09-14", unidades: [] }; },
    };
    await V.renderViewPadm({ tipo: "tela", id: "diario" }, { api });
    assert.deepEqual(chamadas[0], {}, "primeira carga sem filtros");

    const selCrit = document.querySelector("#padm-f-criticidade");
    selCrit.value = "critico";
    selCrit.dispatch("change");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(chamadas[1], { criticidade: "critico" }, "refaz com criticidade=critico");
  });

  test("'Limpar' zera os filtros e recarrega", async () => {
    const chamadas = [];
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {} });
    const api = { monitoramentoDiario: async (f) => { chamadas.push(f); return { referencia: "2026-09-14", unidades: [] }; } };
    V.filtrosDiario.status = "nao_realizado";
    await V.renderViewPadm({ tipo: "tela", id: "diario" }, { api });
    assert.deepEqual(chamadas[0], { status: "nao_realizado" });
    document.querySelector('[data-padm-acao="limpar-filtros"]').dispatch("click");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(chamadas[1], {}, "sem filtros após limpar");
  });
});

// ===========================================================================
// G) futuro não é tratado como pendência
// ===========================================================================
describe("G) futuro / hoje nunca é pendência (nem cor de erro)", () => {
  test("estadoDiaCalendario: NAO_APLICAVEL+futuro -> classe 'futuro' (não crítica)", () => {
    const e = UI.estadoDiaCalendario({ painel: "NAO_APLICAVEL", motivoNaoAplicavel: "futuro" });
    assert.equal(e.classe, "futuro");
    assert.ok(!["nao-realizado", "bloqueado"].includes(e.classe));
  });

  test("estadoDiaCalendario: NAO_APLICAVEL+hoje -> classe 'hoje'", () => {
    assert.equal(UI.estadoDiaCalendario({ painel: "NAO_APLICAVEL", motivoNaoAplicavel: "hoje" }).classe, "hoje");
  });

  test("mesPodeAvancar: mês corrente não avança; mês passado avança", () => {
    assert.equal(V.mesPodeAvancar("2026-09", "2026-09-15"), false);
    assert.equal(V.mesPodeAvancar("2026-08", "2026-09-15"), true);
    assert.equal(V.mesPodeAvancar("2026-10", "2026-09-15"), false); // nunca "futuro"
  });

  test("htmlCalendario: dias futuros não recebem classe de não-realizado; botão 'próximo' desabilitado no mês corrente", () => {
    const dias = [
      { data: "2026-09-01", painel: "COMPLETO", bloqueada: false },
      { data: "2026-09-14", painel: "NAO_LANCADO", bloqueada: false },
      { data: "2026-09-15", painel: "NAO_APLICAVEL", motivoNaoAplicavel: "hoje", bloqueada: false },
      { data: "2026-09-20", painel: "NAO_APLICAVEL", motivoNaoAplicavel: "futuro", bloqueada: false },
    ];
    const h = V.htmlCalendario({ mes: "2026-09", dataReferencia: "2026-09-15", dias, unidade: {} }, "Alfa Centro");
    assert.match(h, /padm-cal-dia--futuro/);
    assert.match(h, /data-padm-acao="mes-proximo"[^>]*disabled/);
    // o dia 20 (futuro) não pode estar marcado como não-realizado
    assert.ok(!/2026-09-20[^"]*·[^"]*Não realizado/.test(h));
  });
});

// ===========================================================================
// H) pendências críticas antes de atenção (ordem do backend preservada)
// ===========================================================================
describe("H) Pendências — grupos e ordem", () => {
  const pend = {
    d1: "2026-09-14",
    unidades: [
      { unidadeId: "c1", unidadeNome: "Crit Um", empresaNome: "A", criticidade: "critico", d1Status: "sequencia_bloqueada", pendenciaMaisAntiga: "2026-08-30", diasPendentes: 5, sequenciaBloqueada: true },
      { unidadeId: "c2", unidadeNome: "Crit Dois", empresaNome: "B", criticidade: "critico", d1Status: "sequencia_bloqueada", pendenciaMaisAntiga: "2026-09-05", diasPendentes: 3, sequenciaBloqueada: true },
      { unidadeId: "a1", unidadeNome: "Aten Um", empresaNome: "C", criticidade: "atencao", d1Status: "nao_realizado", pendenciaMaisAntiga: null, diasPendentes: 0, sequenciaBloqueada: false },
    ],
  };

  test("seção 'Críticas' aparece antes de 'Atenção'", () => {
    const h = V.htmlPendencias(pend);
    assert.ok(h.indexOf("Críticas") < h.indexOf("Atenção"));
  });

  test("dentro do grupo crítico, a ordem recebida do backend é preservada (c1 antes de c2)", () => {
    const h = V.htmlPendencias(pend);
    assert.ok(h.indexOf("Crit Um") < h.indexOf("Crit Dois"));
    assert.ok(h.indexOf("Crit Dois") < h.indexOf("Aten Um"));
  });

  test("lista vazia -> estado 'Nenhuma pendência'", () => {
    assert.match(V.htmlPendencias({ d1: "2026-09-14", unidades: [] }), /Nenhuma pend[êe]ncia/i);
  });
});

// ===========================================================================
// I) loading    J) erro de rede
// ===========================================================================
describe("I) loading  /  J) erro de rede", () => {
  test("I) enquanto a chamada não resolve, a view mostra 'Carregando…'", async () => {
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {} });
    let liberar;
    const api = { visaoGeral: () => new Promise((res) => { liberar = () => res(RESUMO); }) };
    const p = V.renderViewPadm({ tipo: "tela", id: "visao-geral" }, { api });
    assert.match(padmView.innerHTML, /Carregando/);
    liberar();
    await p;
    assert.match(padmView.innerHTML, /Unidades monitoradas/);
  });

  test("J) erro de rede -> mensagem de conexão, distinta de acesso revogado", async () => {
    let revogado = 0;
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {}, aoAcessoRevogado: () => revogado++ });
    await V.renderViewPadm({ tipo: "tela", id: "empresas" }, { api: { empresas: async () => { throw new Error("Failed to fetch"); } } });
    assert.equal(revogado, 0);
    assert.match(padmView.innerHTML, /conex/i);
    assert.ok(!/revogad|dispon[íi]vel/i.test(padmView.innerHTML));
  });

  test("K) 403 numa view -> aoAcessoRevogado (não renderiza erro genérico)", async () => {
    let msg = null;
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {}, aoAcessoRevogado: (m) => { msg = m; } });
    const err = Object.assign(new Error("Acesso restrito ao Painel Administrativo."), { status: 403 });
    await V.renderViewPadm({ tipo: "tela", id: "pendencias" }, { api: { pendencias: async () => { throw err; } } });
    assert.match(msg, /Painel Administrativo/);
  });
});

// ===========================================================================
// M) trial / unidade de teste — o frontend NÃO reintroduz
// ===========================================================================
describe("M) frontend não reintroduz trial/teste (backend já exclui)", () => {
  test("htmlEmpresas renderiza exatamente as empresas recebidas, sem filtro/aumento", () => {
    const dados = { empresas: [
      { organizacaoId: "o1", empresaNome: "Alfa", unidadesMonitoradas: 2, criticas: 0, atencao: 0, emDia: 2, conformidadeD1: 1, conformidadeMes: 1 },
      { organizacaoId: "o2", empresaNome: "Beta", unidadesMonitoradas: 3, criticas: 1, atencao: 1, emDia: 1, conformidadeD1: 0.5, conformidadeMes: 0.7 },
    ] };
    const h = V.htmlEmpresas(dados);
    const cards = (h.match(/data-padm-nav="empresa"/g) ?? []).length;
    assert.equal(cards, 2, "1 card por empresa recebida, nem mais nem menos");
    assert.match(h, /Alfa/); assert.match(h, /Beta/);
  });

  test("a API do painel não tem nenhum parâmetro 'incluirTeste'/'trial'", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/painelAdmApi.js", import.meta.url), "utf8"));
    assert.ok(!/incluirTeste|incluirTrial|ehTeste|trial/i.test(src), "cliente não expõe flag de teste/trial");
  });

  test("Visão Geral vazia (nenhuma empresa) -> não quebra", () => {
    const h = V.htmlVisaoGeral({ ...RESUMO, empresas: [], acaoNecessariaHoje: [] });
    assert.match(h, /Ação necessária hoje/i);
  });
});

// ===========================================================================
// Extras — formatação e calendário
// ===========================================================================
describe("formatação e utilidades", () => {
  test("fmtData / fmtDataCurta / fmtMesLongo", () => {
    assert.equal(UI.fmtData("2026-09-14"), "14/09/2026");
    assert.equal(UI.fmtDataCurta("2026-09-14"), "14/09");
    assert.equal(UI.fmtMesLongo("2026-09"), "setembro/2026");
    assert.equal(UI.fmtData(null), "—");
  });

  test("fmtDiasPendentes: 0 -> '' ; 1 -> '1 dia' ; 3 -> '3 dias'", () => {
    assert.equal(UI.fmtDiasPendentes(0), "");
    assert.equal(UI.fmtDiasPendentes(1), "1 dia");
    assert.equal(UI.fmtDiasPendentes(3), "3 dias");
  });

  test("deslocarMes cruza a virada de ano", () => {
    assert.equal(V.deslocarMes("2026-01", -1), "2025-12");
    assert.equal(V.deslocarMes("2026-12", +1), "2027-01");
  });

  test("estadoDiaCalendario cobre todos os estados do painel", () => {
    assert.equal(UI.estadoDiaCalendario({ painel: "COMPLETO" }).classe, "concluido");
    assert.equal(UI.estadoDiaCalendario({ painel: "INCOMPLETO" }).classe, "em-preenchimento");
    assert.equal(UI.estadoDiaCalendario({ painel: "NAO_LANCADO", bloqueada: true }).classe, "bloqueado");
    assert.equal(UI.estadoDiaCalendario({ painel: "NAO_LANCADO", bloqueada: false }).classe, "nao-realizado");
  });
});
