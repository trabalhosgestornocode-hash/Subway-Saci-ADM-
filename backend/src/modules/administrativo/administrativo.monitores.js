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
      pendencia: u.pendenciasAcum?.total ? { total: u.pendenciasAcum.total, desde: u.pendenciasAcum.desde ?? null } : null,
    });
  }

  const contadores = Object.fromEntries(ORDEM_ACAO_HOJE.map((c) => [c, grupos[c]?.length ?? 0]));
  const total = Object.values(contadores).reduce((s, n) => s + n, 0);
  return { referencia, grupos, contadores, total };
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
