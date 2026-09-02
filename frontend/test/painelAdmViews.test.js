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
    assert.match(h, /Empresas com pendência/);
    assert.match(h, /Unidades com pendência/);
    assert.match(h, /Conformidade D-1/);
    assert.match(h, /Conformidade do mês/);
    assert.match(h, /6 unidades monitoradas/); // total aparece como contexto do cartão
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
    const iBloq = h.indexOf("Sequência travada");
    const iNao = h.indexOf("Não iniciado");
    const iPre = h.indexOf("Em aberto");
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
    assert.match(h, /Nada pendente neste fechamento/i);
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
    assert.match(V.htmlPendencias({ d1: "2026-09-14", unidades: [] }), /Nenhuma pendência/i);
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
    assert.match(padmView.innerHTML, /Unidades com pendência/);
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
    assert.match(h, /Ação necessária/i);
  });
});

// ===========================================================================
// Extras — formatação e calendário
// ===========================================================================
describe("formatação e utilidades", () => {
  test("fmtData / fmtDataCurta / fmtMesLongo", () => {
    assert.equal(UI.fmtData("2026-09-14"), "14/09/2026");
    assert.equal(UI.fmtDataCurta("2026-09-14"), "14/09");
    assert.equal(UI.fmtMesLongo("2026-09"), "Setembro 2026");
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

// ===========================================================================
// REDESENHO — estrutura nova, período e estados (itens 20.7 / 20.9 / 20.14)
// ===========================================================================
describe("estrutura nova da Visão Geral", () => {
  const COM_PERIODO = { ...RESUMO, periodo: "2026-09", mesCorrente: true };

  test("faixa de período mostra o mês por extenso e o fechamento monitorado", () => {
    const h = V.htmlVisaoGeral(COM_PERIODO);
    assert.match(h, /padm-faixa/);
    assert.match(h, /Setembro 2026/);
    assert.match(h, /Fechamento monitorado/i);
    assert.match(h, /14\/09\/2026/);
  });

  test("mês fechado ganha a tag 'mês fechado'; mês corrente não", () => {
    const fechado = V.htmlVisaoGeral({ ...COM_PERIODO, periodo: "2026-08", mesCorrente: false });
    assert.match(fechado, /mês fechado/i);
    assert.ok(!/mês fechado/i.test(V.htmlVisaoGeral(COM_PERIODO)));
  });

  test("hierarquia: faixa -> cartões -> ação necessária -> empresas, nesta ordem", () => {
    const h = V.htmlVisaoGeral({
      ...COM_PERIODO,
      acaoNecessariaHoje: [{ unidadeId: "u", unidadeNome: "U", organizacaoId: "o", empresaNome: "E", categoria: "nao_realizado", pendencia: null }],
      empresas: [{ organizacaoId: "o", empresaNome: "E", unidadesMonitoradas: 1, criticas: 0, atencao: 1, emDia: 0, conformidadeD1: 0, conformidadeMes: 0.5 }],
    });
    const ordem = ["padm-faixa", "padm-cards", "padm-acao", "padm-emps"].map((t) => h.indexOf(t));
    assert.ok(ordem.every((i) => i > -1), "todas as seções presentes");
    assert.deepEqual(ordem, [...ordem].sort((a, b) => a - b), "seções na ordem da hierarquia");
  });

  test("cartão de críticas ganha tom crítico só quando há crítica", () => {
    const com = V.htmlVisaoGeral({ ...COM_PERIODO, resumo: { ...RESUMO.resumo, criticas: 3 } });
    assert.match(com, /padm-card--critico/);
    // sem nenhuma pendência (nem crítica, nem empresa afetada) nada é destacado
    const limpo = V.htmlVisaoGeral({
      ...COM_PERIODO,
      resumo: { ...RESUMO.resumo, criticas: 0, atencao: 0, empresasComPendencia: 0, unidadesComPendencia: 0 },
      empresas: [],
    });
    assert.ok(!/padm-card--destaque/.test(limpo), "sem pendência, sem destaque");
  });

  test("conformidade desenha a barra de progresso; conformidade null não desenha", () => {
    assert.match(V.htmlVisaoGeral(COM_PERIODO), /padm-card-barra/);
    const semBase = V.htmlVisaoGeral({ ...COM_PERIODO, resumo: { ...RESUMO.resumo, conformidadeD1: null, conformidadeMes: null } });
    assert.ok(!/padm-card-barra/.test(semBase), "sem taxa, sem barra");
  });

  test("empresas mostram barra de saúde proporcional (crítica/atenção/em dia)", () => {
    const h = V.htmlVisaoGeral({
      ...COM_PERIODO,
      empresas: [{ organizacaoId: "o1", empresaNome: "Alfa", unidadesMonitoradas: 4, criticas: 1, atencao: 1, emDia: 2, conformidadeD1: 0.5, conformidadeMes: 0.8 }],
    });
    assert.match(h, /padm-saude/);
    assert.match(h, /padm-saude--critico/);
    assert.match(h, /padm-saude--ok/);
  });

  test("grupos de ação trazem o texto de ajuda que explica o status", () => {
    const h = V.htmlVisaoGeral({
      ...COM_PERIODO,
      acaoNecessariaHoje: [{ unidadeId: "u", unidadeNome: "U", organizacaoId: "o", empresaNome: "E", categoria: "sequencia_bloqueada", pendencia: { total: 2, desde: "2026-09-11" } }],
    });
    assert.match(h, /padm-grupo-ajuda/);
    assert.match(h, /travando os seguintes/i);
    assert.match(h, /padm-item-ordem/, "itens numerados por prioridade");
  });
});

describe("estados de carregamento e vazio", () => {
  test("skeleton do painel: cartões + lista (não é spinner genérico)", () => {
    const sk = UI.carregando("painel");
    assert.match(sk, /padm-sk--card/);
    assert.match(sk, /padm-sk--linha/);
    assert.match(sk, /aria-busy="true"/);
  });

  test("skeleton do calendário desenha a grade de dias", () => {
    const sk = UI.carregando("calendario");
    assert.match(sk, /padm-sk-cal/);
    assert.equal((sk.match(/padm-sk--dia/g) ?? []).length, 35);
  });

  test("renderViewPadm usa o skeleton certo por tela", async () => {
    V.ligarNavegacao({ abrirEmpresa: () => {}, abrirUnidade: () => {}, voltar: () => {} });
    let liberar;
    const p = V.renderViewPadm({ tipo: "calendario", unidadeId: "u1" }, {
      api: { calendarioUnidade: () => new Promise((res) => { liberar = () => res({ mes: "2026-09", dataReferencia: "2026-09-15", dias: [], unidade: {} }); }) },
    });
    assert.match(padmView.innerHTML, /padm-sk-cal/);
    liberar();
    await p;
  });

  test("erro de rede e erro do servidor dizem coisas diferentes", () => {
    const rede = UI.erro(new Error("Failed to fetch"));
    const servidor = UI.erro(new Error("Falha ao consultar organizações."));
    assert.match(rede, /Sem conexão com o servidor/i);
    assert.match(servidor, /Não foi possível carregar/i);
    assert.match(servidor, /Falha ao consultar organiza/i);
    assert.ok(!/revogad/i.test(rede) && !/revogad/i.test(servidor));
  });

  test("vazio positivo (nada pendente) usa tom 'ok'; vazio neutro usa tom 'neutro'", () => {
    assert.match(UI.vazio("Fila vazia", "x"), /padm-estado--ok/);
    assert.match(UI.vazio("Sem dados", "x", { tom: "neutro", icone: "inbox" }), /padm-estado--neutro/);
  });
});

describe("calendário — leitura premium", () => {
  const mkDias = () => {
    const dias = [];
    for (let d = 1; d <= 30; d++) {
      const data = `2026-09-${String(d).padStart(2, "0")}`;
      if (d <= 12) dias.push({ data, painel: "COMPLETO", bloqueada: false });
      else if (d === 13) dias.push({ data, painel: "INCOMPLETO", bloqueada: false });
      else if (d === 14) dias.push({ data, painel: "NAO_LANCADO", bloqueada: true });
      else if (d === 15) dias.push({ data, painel: "NAO_APLICAVEL", motivoNaoAplicavel: "hoje", bloqueada: false });
      else dias.push({ data, painel: "NAO_APLICAVEL", motivoNaoAplicavel: "futuro", bloqueada: false });
    }
    return dias;
  };

  test("legenda lateral conta os dias de cada estado", () => {
    const h = V.htmlCalendario({ mes: "2026-09", dataReferencia: "2026-09-15", dias: mkDias(), unidade: {} }, "Alfa");
    assert.match(h, /padm-cal-legenda/);
    assert.match(h, /Como ler/);
    assert.match(h, /Ainda não venceu/);
    assert.match(h, /<b>12<\/b>/, "12 dias concluídos contados na legenda");
  });

  test("hoje e futuro têm classes próprias — nunca a de erro", () => {
    const h = V.htmlCalendario({ mes: "2026-09", dataReferencia: "2026-09-15", dias: mkDias(), unidade: {} }, "Alfa");
    assert.match(h, /padm-cal-dia--hoje/);
    assert.match(h, /padm-cal-dia--futuro/);
    assert.match(h, /padm-cal-dia--bloqueado/);
    assert.ok(!/20\/09\/2026 — Não realizado/.test(h), "dia futuro nunca é rotulado como não realizado");
  });

  test("aviso de sequência bloqueada só aparece quando o backend marca", () => {
    const base = { mes: "2026-09", dataReferencia: "2026-09-15", dias: mkDias(), unidade: {} };
    assert.match(V.htmlCalendario({ ...base, sequenciaBloqueada: true }, "Alfa"), /padm-aviso--critico/);
    assert.ok(!/padm-aviso--critico/.test(V.htmlCalendario(base, "Alfa")));
  });
});

describe("responsividade — marcação que as media queries dependem", () => {
  test("itens de lista e filtros carregam as classes usadas no mobile", () => {
    const h = V.htmlDiario({
      referencia: "2026-09-14", periodo: "2026-09", mesCorrente: true,
      unidades: [{ unidadeId: "u", unidadeNome: "U", organizacaoId: "o", empresaNome: "E", categoria: "nao_realizado", criticidade: "atencao", diasPendentes: 0, conformidadeMes: 0.9, ultimoConcluido: "2026-09-13" }],
    });
    for (const cls of ["padm-item", "padm-item-txt", "padm-item-tags", "padm-item-dados", "padm-f-campo", "padm-busca"]) {
      assert.match(h, new RegExp(cls), `falta a classe ${cls}`);
    }
  });
});

// ===========================================================================
// RECORTE VISUAL DO PERÍODO — a interface usa a pendência DO PERÍODO
// ===========================================================================
describe("pendência do período vs herdada (interface)", () => {
  const BASE = { ...RESUMO, periodo: "2026-09", mesCorrente: true, d1: "2026-09-04", dataReferencia: "2026-09-05" };

  test("Ação necessária exibe os dias DO PERÍODO, nunca a data do mês anterior", () => {
    const h = V.htmlVisaoGeral({
      ...BASE,
      acaoNecessariaHoje: [{
        unidadeId: "u1", unidadeNome: "Praia Grande", organizacaoId: "o1", empresaNome: "Rede Litoral",
        categoria: "sequencia_bloqueada",
        pendencia: { total: 3, desde: "2026-09-01" },
        herdada: { desde: "2026-08-26", total: 6 },
      }],
    });
    assert.match(h, /3 dias/, "contagem do período");
    assert.match(h, /desde 01\/09/, "início do período");
    assert.ok(!/6 dias/.test(h), "a contagem histórica NÃO aparece como métrica");
    // a métrica (bloco .padm-item-pend) não pode conter nenhuma data de agosto
    const metrica = /<span class="padm-item-pend">([\s\S]*?)<\/span>\s*<span class="padm-item-ir"/.exec(h)?.[1] ?? "";
    assert.match(metrica, /3 dias/);
    assert.ok(!/\/08/.test(metrica), "a métrica de setembro não cita agosto");
    assert.ok(!/desde 26\/08/.test(h), "'desde DD/MM' é vocabulário da métrica — a nota usa 'vem de'");
  });

  test("a herança aparece como nota secundária, com a data original", () => {
    const h = V.htmlVisaoGeral({
      ...BASE,
      acaoNecessariaHoje: [{
        unidadeId: "u1", unidadeNome: "Praia Grande", organizacaoId: "o1", empresaNome: "Rede Litoral",
        categoria: "sequencia_bloqueada",
        pendencia: { total: 3, desde: "2026-09-01" },
        herdada: { desde: "2026-08-26", total: 6 },
      }],
    });
    assert.match(h, /padm-herdada/);
    assert.match(h, /pendência anterior ao período/i);
    assert.match(h, /vem de 26\/08/, "a data original vive só na nota, com outro conector");
  });

  test("sem herança, nenhuma nota é renderizada", () => {
    const h = V.htmlVisaoGeral({
      ...BASE,
      acaoNecessariaHoje: [{
        unidadeId: "u1", unidadeNome: "U", organizacaoId: "o1", empresaNome: "E",
        categoria: "nao_realizado", pendencia: { total: 2, desde: "2026-09-02" }, herdada: null,
      }],
    });
    assert.ok(!/padm-herdada/.test(h));
    assert.match(h, /2 dias/);
  });

  test("período limpo + herança: 0 dias no mês, mas a nota explica o topo da fila", () => {
    const h = V.htmlVisaoGeral({
      ...BASE,
      acaoNecessariaHoje: [{
        unidadeId: "u1", unidadeNome: "Praia Grande", organizacaoId: "o1", empresaNome: "Rede Litoral",
        categoria: "nao_realizado", pendencia: null, herdada: { desde: "2026-08-26", total: 6 },
      }],
    });
    assert.match(h, /padm-herdada/);
    assert.ok(!/\d+ dias<\/b>/.test(h), "não inventa contagem no período");
  });

  test("Pendências: 'no período' na métrica, herança na nota", () => {
    const h = V.htmlPendencias({
      d1: "2026-09-04", periodo: "2026-09", mesCorrente: true,
      unidades: [{
        unidadeId: "c1", unidadeNome: "Praia Grande", empresaNome: "Rede Litoral",
        criticidade: "critico", d1Status: "sequencia_bloqueada", sequenciaBloqueada: true,
        pendenciaMaisAntiga: "2026-09-01", diasPendentes: 3,
        pendenciaHerdada: true, pendenciaHerdadaDesde: "2026-08-26", diasPendentesHistorico: 9,
      }],
    });
    assert.match(h, /3 dias/, "métrica do período");
    assert.match(h, /desde 01\/09/);
    assert.match(h, /padm-herdada/);
    assert.ok(!/9 dias/.test(h), "o total histórico não vira métrica");
  });

  test("Monitoramento Diário e Detalhe também usam a leitura do período", () => {
    const diario = V.htmlDiario({
      referencia: "2026-09-04", periodo: "2026-09", mesCorrente: true,
      unidades: [{
        unidadeId: "u", unidadeNome: "U", organizacaoId: "o", empresaNome: "E",
        categoria: "sequencia_bloqueada", criticidade: "critico",
        diasPendentes: 3, pendenciaMaisAntiga: "2026-09-01",
        pendenciaHerdada: true, pendenciaHerdadaDesde: "2026-08-26",
        conformidadeMes: 0.25, ultimoConcluido: "2026-08-25",
      }],
    });
    assert.match(diario, /no período/);
    assert.match(diario, /padm-herdada/);

    const det = V.htmlDetalheEmpresa({
      periodo: "2026-09", mesCorrente: true, d1: "2026-09-04",
      organizacao: { nome: "Rede Litoral", status: "ativa" }, consolidado: {},
      unidades: [{
        unidadeId: "u", unidadeNome: "Praia Grande", criticidade: "critico", d1Status: "sequencia_bloqueada",
        diasPendentes: 3, conformidadeMes: 0.25,
        pendenciaHerdada: true, pendenciaHerdadaDesde: "2026-08-26",
      }],
      pendencias: [],
    });
    assert.match(det, /no período/);
    assert.match(det, /padm-herdada/);
  });

  test("notaHerdada aceita objeto ou booleano+data e é vazia quando não há herança", () => {
    assert.equal(UI.notaHerdada(null), "");
    assert.equal(UI.notaHerdada(false, "2026-08-26"), "");
    assert.match(UI.notaHerdada({ desde: "2026-08-26", total: 6 }), /26\/08/);
    assert.match(UI.notaHerdada(true, "2026-08-26"), /26\/08/);
    assert.match(UI.notaHerdada(true, null), /pendência anterior ao período/i);
  });
});
