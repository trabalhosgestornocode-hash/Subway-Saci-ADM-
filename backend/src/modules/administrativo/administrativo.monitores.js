// Registro EXTENSÍVEL de monitores do Painel Administrativo + consolidação
// cross-unidade (Visão Geral, "Ação Necessária Hoje", conformidade D-1).
//
// FASE E: só a lógica pura. O carregamento cross-tenant dos lançamentos e os
// endpoints entram na Fase F.
//
// A arquitetura NÃO fica acoplada ao Dashboard iFood: um monitor é só uma
// entrada aqui + um avaliador. Amanhã entram Bonificação Mensal, Parser, etc.,
// sem tocar o motor.

import { MODULOS } from "../../shared/modulos.js";
import { D1_CATEGORIA, ROLLUP } from "./administrativo.status.js";

/**
 * Catálogo de monitores. `modulo` é o que define "unidade monitorada": uma
 * unidade só entra num monitor se a empresa/unidade tem esse módulo ativo
 * (herança empresa->unidade, ver organizacao_modulos/unidade_modulos) — nunca
 * uma lista hardcoded de empresas.
 */
export const MONITORES = {
  dashboard_ifood: {
    chave: "dashboard_ifood",
    nome: "Dashboard iFood",
    modulo: MODULOS.IFOOD_DASHBOARD,
    descricao: "Fechamento financeiro diário do iFood. Lançamento sequencial; a obrigação de cada dia é o D-1.",
    pronto: true,
  },
  // Reservados — entram sem tocar o motor:
  // bonificacao_mensal: { chave, nome, modulo: MODULOS.MONTHLY_BONUS, pronto: false },
  // parser_food_delivery: { chave, nome, modulo: MODULOS.PARSER_FOOD_DELIVERY, pronto: false },
};

/** @returns {Array<{chave, nome, modulo, descricao, pronto}>} */
export function listarMonitores() {
  return Object.values(MONITORES);
}

// ---------------------------------------------------------------------------
// CONSOLIDAÇÃO cross-unidade (monitor Dashboard iFood)
// ---------------------------------------------------------------------------

const ORDEM_ACAO_HOJE = [
  D1_CATEGORIA.SEQUENCIA_BLOQUEADA,
  D1_CATEGORIA.NAO_REALIZADO,
  D1_CATEGORIA.EM_PREENCHIMENTO,
  D1_CATEGORIA.CONCLUIDO,
];

/**
 * "AÇÃO NECESSÁRIA HOJE" — para cada unidade ELEGÍVEL, a categoria do D-1.
 * A pergunta é sempre a mesma: "o lançamento referente a ontem foi feito?"
 *
 * @param {Array<{unidadeId, unidadeNome?, organizacaoId?, empresaNome?, d1: {elegivel: boolean, categoria: string}, pendenciasAcum?: {total: number, desde: string|null}}>} unidades
 * @returns {{referencia: string|null, grupos: Record<string, Array<object>>, contadores: Record<string, number>, total: number}}
 */
export function acaoNecessariaHoje(unidades) {
  const grupos = { sequencia_bloqueada: [], nao_realizado: [], em_preenchimento: [], concluido: [] };
  let referencia = null;

  for (const u of unidades ?? []) {
    if (!u.d1?.elegivel) continue;
    referencia = referencia ?? u.d1.data ?? null;
    const cat = u.d1.categoria;
    (grupos[cat] ??= []).push({
      unidadeId: u.unidadeId,
      unidadeNome: u.unidadeNome ?? null,
      organizacaoId: u.organizacaoId ?? null,
      empresaNome: u.empresaNome ?? null,
      categoria: cat,
      // `pendencia` é a leitura DO PERÍODO — nunca importa dias do mês
      // anterior. A parte herdada vai separada, em `herdada`.
      pendencia: u.pendenciasPeriodo?.total
        ? { total: u.pendenciasPeriodo.total, desde: u.pendenciasPeriodo.desde ?? null }
        : null,
      herdada: u.pendenciaHerdada?.herdada
        ? { desde: u.pendenciaHerdada.desde, total: u.pendenciaHerdada.total }
        : null,
    });
  }

  // Ordem DENTRO de cada grupo: pendência mais antiga primeiro, depois
  // empresa, depois unidade. A ordem ENTRE grupos é `ORDEM_ACAO_HOJE`
  // (sequência bloqueada -> não realizado -> em preenchimento -> concluído).
  // NUNCA por percentual.
  //
  // A PRIORIDADE usa a data HISTÓRICA (quem está travado há mais tempo vem
  // primeiro), embora a interface exiba a contagem do período — as duas
  // perguntas são diferentes e o selo "pendência anterior ao período" explica
  // ao operador por que aquele item está no topo com poucos dias no mês.
  const chaveOrdem = (it) => [
    it.pendencia?.desde ?? it.herdada?.desde ?? referencia ?? "9999-99-99",
    (it.empresaNome ?? "").toLowerCase(),
    (it.unidadeNome ?? "").toLowerCase(),
  ];
  for (const cat of Object.keys(grupos)) {
    grupos[cat].sort((a, b) => {
      const ka = chaveOrdem(a), kb = chaveOrdem(b);
      for (let i = 0; i < ka.length; i++) { if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1; }
      return 0;
    });
  }

  // Lista achatada na ordem final (entre grupos + dentro do grupo), pronta pro
  // frontend ("Ação Necessária Hoje" mostra tudo menos os concluídos).
  const ordenada = ORDEM_ACAO_HOJE.flatMap((cat) => grupos[cat] ?? []);
  const pendentes = ordenada.filter((it) => it.categoria !== D1_CATEGORIA.CONCLUIDO);

  const contadores = Object.fromEntries(ORDEM_ACAO_HOJE.map((c) => [c, grupos[c]?.length ?? 0]));
  const total = Object.values(contadores).reduce((s, n) => s + n, 0);
  return { referencia, grupos, ordenada, pendentes, contadores, total };
}

// ---------------------------------------------------------------------------
// PENDÊNCIAS (aba própria) e EMPRESAS (rollup por organização)
// ---------------------------------------------------------------------------

/**
 * Uma unidade tem pendência NO PERÍODO selecionado.
 *
 * Só conta o que produz efeito DENTRO do período: dia pendente/bloqueado no
 * próprio mês, ou D-1 em aberto. Pendência anterior ao período é histórico —
 * viaja em `historicoAnterior` como nota, nunca entra nesta contagem (era o
 * bug: uma unidade com setembro 100% aparecia como crítica por causa de 29/08).
 */
export function temPendencia(u) {
  return u.rollup?.status !== ROLLUP.EM_DIA
    || (u.pendenciasPeriodo?.total ?? 0) > 0
    || u.d1?.categoria === D1_CATEGORIA.EM_PREENCHIMENTO
    || u.d1?.categoria === D1_CATEGORIA.NAO_REALIZADO
    || u.d1?.categoria === D1_CATEGORIA.SEQUENCIA_BLOQUEADA;
}

const PESO_CRITICIDADE = { [ROLLUP.CRITICO]: 0, [ROLLUP.ATENCAO]: 1, [ROLLUP.EM_DIA]: 2 };

/**
 * Lista de pendências ordenada: CRÍTICO primeiro -> pendência mais antiga ->
 * ATENÇÃO -> empresa -> unidade. (item 10 do pedido.)
 * @param {Array<object>} unidades  saída do avaliador de frota
 */
export function listarPendencias(unidades) {
  return (unidades ?? [])
    .filter(temPendencia)
    .map((u) => ({
      organizacaoId: u.organizacaoId ?? null,
      empresaNome: u.empresaNome ?? null,
      unidadeId: u.unidadeId,
      unidadeNome: u.unidadeNome ?? null,
      criticidade: u.rollup?.status ?? null,
      d1Status: u.d1?.categoria ?? null,
      d1StatusDia: u.d1?.statusDia ?? null,
      // sequência travada DENTRO do período — um bloqueio de agosto não
      // rotula setembro como travado.
      sequenciaBloqueada: u.pendenciasPeriodo?.sequenciaBloqueada ?? false,
      // números exibidos: leitura DO PERÍODO
      pendenciaMaisAntiga: u.pendenciasPeriodo?.desde ?? (u.d1?.elegivel && u.d1?.categoria !== D1_CATEGORIA.CONCLUIDO ? u.d1?.data ?? null : null),
      diasPendentes: u.pendenciasPeriodo?.total ?? 0,
      // o que veio de antes do período — mostrado como nota, nunca somado
      pendenciaHerdada: u.pendenciaHerdada?.herdada ?? false,
      pendenciaHerdadaDesde: u.pendenciaHerdada?.desde ?? null,
      diasPendentesHistorico: u.pendenciasAcum?.total ?? 0,
    }))
    .sort((a, b) => {
      const pc = (PESO_CRITICIDADE[a.criticidade] ?? 9) - (PESO_CRITICIDADE[b.criticidade] ?? 9);
      if (pc !== 0) return pc;
      // prioridade pela pendência DO PERÍODO (o histórico só desempata)
      const da = a.pendenciaMaisAntiga ?? a.pendenciaHerdadaDesde ?? "9999-99-99";
      const db = b.pendenciaMaisAntiga ?? b.pendenciaHerdadaDesde ?? "9999-99-99";
      if (da !== db) return da < db ? -1 : 1;
      const ea = (a.empresaNome ?? "").toLowerCase(), eb = (b.empresaNome ?? "").toLowerCase();
      if (ea !== eb) return ea < eb ? -1 : 1;
      const ua = (a.unidadeNome ?? "").toLowerCase(), ub = (b.unidadeNome ?? "").toLowerCase();
      return ua < ub ? -1 : ua > ub ? 1 : 0;
    });
}

/**
 * Rollup por EMPRESA. Conformidade da empresa = Σ completos / Σ esperados
 * (mês) e Σ concluídas D-1 / Σ elegíveis D-1 — NUNCA média de percentuais.
 * @param {Array<object>} unidades  saída do avaliador de frota
 */
/** Peso da categoria do D-1 — ordena as unidades DENTRO de uma empresa. */
const PESO_CATEGORIA = {
  [D1_CATEGORIA.SEQUENCIA_BLOQUEADA]: 0,
  [D1_CATEGORIA.NAO_REALIZADO]: 1,
  [D1_CATEGORIA.EM_PREENCHIMENTO]: 2,
  [D1_CATEGORIA.CONCLUIDO]: 3,
  [D1_CATEGORIA.NAO_APLICAVEL]: 4,
};

/**
 * Forma enxuta de uma unidade dentro do resumo da empresa — o suficiente para
 * o gestor identificar QUAL unidade está pendente sem abrir outra tela.
 */
function resumoUnidade(u) {
  return {
    unidadeId: u.unidadeId,
    unidadeNome: u.unidadeNome ?? null,
    criticidade: u.rollup?.status ?? null,
    d1Status: u.d1?.categoria ?? null,
    sequenciaBloqueada: u.pendenciasPeriodo?.sequenciaBloqueada ?? false,
    diasPendentes: u.pendenciasPeriodo?.total ?? 0,
    pendenciaMaisAntiga: u.pendenciasPeriodo?.desde ?? null,
    pendenciaHerdada: u.pendenciaHerdada?.herdada ?? false,
    pendenciaHerdadaDesde: u.pendenciaHerdada?.desde ?? null,
    conformidadeMes: u.conformidade?.taxa ?? null,
  };
}

/** Ordem das unidades pendentes: mais grave -> mais antiga -> mais dias -> nome. */
function ordenarUnidadesPendentes(lista) {
  return lista.sort((a, b) => {
    const pc = (PESO_CRITICIDADE[a.criticidade] ?? 9) - (PESO_CRITICIDADE[b.criticidade] ?? 9);
    if (pc !== 0) return pc;
    const pk = (PESO_CATEGORIA[a.d1Status] ?? 9) - (PESO_CATEGORIA[b.d1Status] ?? 9);
    if (pk !== 0) return pk;
    const da = a.pendenciaHerdadaDesde ?? a.pendenciaMaisAntiga ?? "9999-99-99";
    const db = b.pendenciaHerdadaDesde ?? b.pendenciaMaisAntiga ?? "9999-99-99";
    if (da !== db) return da < db ? -1 : 1;
    if (b.diasPendentes !== a.diasPendentes) return b.diasPendentes - a.diasPendentes;
    return (a.unidadeNome ?? "").toLowerCase() < (b.unidadeNome ?? "").toLowerCase() ? -1 : 1;
  });
}

/**
 * Rollup por EMPRESA. Conformidade da empresa = Sigma completos / Sigma esperados
 * (mes) e Sigma concluidas D-1 / Sigma elegiveis D-1 -- NUNCA media de percentuais.
 *
 * Alem dos contadores, devolve o que o gestor precisa para IDENTIFICAR o
 * problema sem abrir outra tela:
 *   * `unidadesPendentes` -- quantas unidades da empresa nao estao em dia;
 *   * `pendentes[]`       -- QUAIS sao elas, ja ordenadas por gravidade;
 *   * `piorUnidade`       -- a que deve ser tratada primeiro;
 *   * `d1Ok`              -- o fechamento de ontem fechou em todas?
 *   * `severidade`        -- 0 critica / 1 atencao / 2 saudavel (para filtro e ordem).
 *
 * @param {Array<object>} unidades  saida do avaliador de frota
 */
export function consolidarEmpresas(unidades) {
  const mapa = new Map();
  for (const u of unidades ?? []) {
    const chave = u.organizacaoId ?? "sem_empresa";
    if (!mapa.has(chave)) {
      mapa.set(chave, {
        organizacaoId: u.organizacaoId ?? null,
        empresaNome: u.empresaNome ?? null,
        unidadesMonitoradas: 0, emDia: 0, atencao: 0, criticas: 0,
        d1Elegiveis: 0, d1Concluidas: 0, d1EmPreenchimento: 0, d1NaoRealizadas: 0, d1Bloqueadas: 0,
        mesCompleto: 0, mesEsperado: 0,
        pendentes: [], emDiaLista: [], comHistorico: [],
      });
    }
    const g = mapa.get(chave);
    g.unidadesMonitoradas += 1;
    if (u.rollup?.status === ROLLUP.EM_DIA) {
      g.emDia += 1;
      g.emDiaLista.push(resumoUnidade(u));
    }
    else if (u.rollup?.status === ROLLUP.ATENCAO) g.atencao += 1;
    else if (u.rollup?.status === ROLLUP.CRITICO) g.criticas += 1;
    if (u.d1?.elegivel) {
      g.d1Elegiveis += 1;
      if (u.d1.categoria === D1_CATEGORIA.CONCLUIDO) g.d1Concluidas += 1;
      else if (u.d1.categoria === D1_CATEGORIA.EM_PREENCHIMENTO) g.d1EmPreenchimento += 1;
      else if (u.d1.categoria === D1_CATEGORIA.NAO_REALIZADO) g.d1NaoRealizadas += 1;
      else if (u.d1.categoria === D1_CATEGORIA.SEQUENCIA_BLOQUEADA) g.d1Bloqueadas += 1;
    }
    g.mesCompleto += u.conformidade?.completos ?? 0;
    g.mesEsperado += u.conformidade?.esperados ?? 0;
    // MESMO criterio de `temPendencia` -- uma so definicao de "pendente".
    if (temPendencia(u)) g.pendentes.push(resumoUnidade(u));
    if (u.pendenciaHerdada?.herdada) g.comHistorico.push(u.pendenciaHerdada.desde ?? null);
  }

  return [...mapa.values()]
    .map((g) => {
      const pendentes = ordenarUnidadesPendentes(g.pendentes);
      // Contexto: alguma unidade arrasta pendência de antes do período? Vira
      // nota discreta na interface — não muda severidade, cor nem contador.
      const heranca = g.comHistorico.filter(Boolean).sort();
      const severidade = g.criticas > 0 ? 0 : g.atencao > 0 ? 1 : 2;
      const { comHistorico, ...semAuxiliar } = g;
      return {
        ...semAuxiliar,
        pendentes,
        emDiaLista: [...g.emDiaLista].sort((a, b) =>
          (a.unidadeNome ?? "").localeCompare(b.unidadeNome ?? "", "pt-BR")),
        unidadesPendentes: pendentes.length,
        historicoAnterior: { existe: heranca.length > 0, desde: heranca[0] ?? null, unidades: heranca.length },
        piorUnidade: pendentes[0] ?? null,
        // pendencia mais antiga da empresa (ja considerando a heranca)
        pendenciaMaisAntiga: pendentes
          .map((p) => p.pendenciaHerdadaDesde ?? p.pendenciaMaisAntiga)
          .filter(Boolean)
          .sort()[0] ?? null,
        // "o fechamento de ontem fechou em todas as unidades elegiveis?"
        d1Ok: g.d1Elegiveis > 0 ? g.d1Concluidas === g.d1Elegiveis : null,
        severidade,
        conformidadeD1: g.d1Elegiveis ? g.d1Concluidas / g.d1Elegiveis : null,
        conformidadeMes: g.mesEsperado ? g.mesCompleto / g.mesEsperado : null,
      };
    })
    // ORDEM INTELIGENTE (item 12): criticas -> mais unidades pendentes ->
    // pendencia mais antiga -> atencao -> saudaveis -> nome.
    .sort((a, b) => {
      if (a.severidade !== b.severidade) return a.severidade - b.severidade;
      if (b.criticas !== a.criticas) return b.criticas - a.criticas;
      if (b.unidadesPendentes !== a.unidadesPendentes) return b.unidadesPendentes - a.unidadesPendentes;
      const da = a.pendenciaMaisAntiga ?? "9999-99-99";
      const db = b.pendenciaMaisAntiga ?? "9999-99-99";
      if (da !== db) return da < db ? -1 : 1;
      if (b.atencao !== a.atencao) return b.atencao - a.atencao;
      return (a.empresaNome ?? "").toLowerCase() < (b.empresaNome ?? "").toLowerCase() ? -1 : 1;
    });
}

/**
 * Conformidade D-1 (o HEADLINE do dia): unidades com D-1 concluído / unidades
 * elegíveis para D-1.
 * @param {Array<{d1: {elegivel: boolean, categoria: string}}>} unidades
 * @returns {{elegiveis: number, concluidas: number, emPreenchimento: number, naoRealizadas: number, bloqueadas: number, taxa: number|null}}
 */
export function conformidadeD1(unidades) {
  const elegiveis = (unidades ?? []).filter((u) => u.d1?.elegivel);
  const conta = (cat) => elegiveis.filter((u) => u.d1.categoria === cat).length;
  const concluidas = conta(D1_CATEGORIA.CONCLUIDO);
  return {
    elegiveis: elegiveis.length,
    concluidas,
    emPreenchimento: conta(D1_CATEGORIA.EM_PREENCHIMENTO),
    naoRealizadas: conta(D1_CATEGORIA.NAO_REALIZADO),
    bloqueadas: conta(D1_CATEGORIA.SEQUENCIA_BLOQUEADA),
    taxa: elegiveis.length ? concluidas / elegiveis.length : null,
  };
}

/**
 * Resumo consolidado da operação (cards da Visão Geral). Tudo derivado — nunca
 * um número inventado.
 * @param {Array<{
 *   unidadeId, organizacaoId,
 *   rollup: {status: string},
 *   conformidade: {esperados: number, completos: number},
 *   d1: {elegivel: boolean, categoria: string},
 * }>} unidades
 * @returns {object}
 */
export function consolidarOperacao(unidades) {
  const lista = unidades ?? [];
  const empresas = new Set(lista.map((u) => u.organizacaoId).filter(Boolean));

  const porStatus = (s) => lista.filter((u) => u.rollup?.status === s).length;

  // Conformidade MENSAL consolidada: soma de numeradores / soma de
  // denominadores (nunca média de percentuais).
  let somaCompletos = 0, somaEsperados = 0;
  for (const u of lista) {
    somaCompletos += u.conformidade?.completos ?? 0;
    somaEsperados += u.conformidade?.esperados ?? 0;
  }

  return {
    empresasMonitoradas: empresas.size,
    unidadesMonitoradas: lista.length,
    emDia: porStatus(ROLLUP.EM_DIA),
    atencao: porStatus(ROLLUP.ATENCAO),
    criticas: porStatus(ROLLUP.CRITICO),
    d1: conformidadeD1(lista),
    conformidadeMes: {
      completos: somaCompletos,
      esperados: somaEsperados,
      taxa: somaEsperados ? somaCompletos / somaEsperados : null,
    },
  };
}

/**
 * Agrupa unidades por empresa (hierarquia — item 19 do pedido original).
 * @param {Array<{unidadeId, organizacaoId, empresaNome?, rollup: {status: string}}>} unidades
 */
export function agruparPorEmpresa(unidades) {
  const mapa = new Map();
  for (const u of unidades ?? []) {
    const chave = u.organizacaoId ?? "sem_empresa";
    if (!mapa.has(chave)) mapa.set(chave, { organizacaoId: u.organizacaoId ?? null, empresaNome: u.empresaNome ?? null, unidades: [] });
    mapa.get(chave).unidades.push(u);
  }
  return [...mapa.values()].map((g) => ({
    ...g,
    total: g.unidades.length,
    emDia: g.unidades.filter((u) => u.rollup?.status === ROLLUP.EM_DIA).length,
    atencao: g.unidades.filter((u) => u.rollup?.status === ROLLUP.ATENCAO).length,
    criticas: g.unidades.filter((u) => u.rollup?.status === ROLLUP.CRITICO).length,
  }));
}
