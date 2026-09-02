// Utilidades compartilhadas pelos serviços do Painel SuperAdmin.
//
// Por que existe: o painel agrega dados de MUITAS tabelas, algumas das quais
// podem não existir ainda no banco de um ambiente (as migrations da Martin
// Brower, de vendas etc. são independentes). Um dashboard que quebra inteiro
// porque uma tabela opcional falta é inútil — então contagens e listagens
// opcionais passam por aqui e degradam para `null` em vez de estourar.

import { supabase } from "../../config/supabase.js";

/**
 * Contagem exata sem trazer linhas. Devolve `null` (não lança) se a tabela não
 * existir ou a consulta falhar — o chamador decide como exibir a ausência.
 * @param {string} tabela
 * @param {(q: any) => any} [filtro] aplica .eq/.in/.gte etc.
 * @returns {Promise<number|null>}
 */
export async function contar(tabela, filtro) {
  try {
    let q = supabase.from(tabela).select("*", { count: "exact", head: true });
    if (filtro) q = filtro(q);
    const { count, error } = await q;
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

/**
 * Igual a `contar`, mas para várias contagens de uma vez, em paralelo.
 * @param {Array<{chave: string, tabela: string, filtro?: (q: any) => any}>} pedidos
 * @returns {Promise<Record<string, number|null>>}
 */
export async function contarVarios(pedidos) {
  const valores = await Promise.all(pedidos.map((p) => contar(p.tabela, p.filtro)));
  return Object.fromEntries(pedidos.map((p, i) => [p.chave, valores[i]]));
}

/**
 * Select tolerante: devolve `[]` se a tabela não existir ou a consulta falhar.
 * @param {string} tabela
 * @param {string} colunas
 * @param {(q: any) => any} [filtro]
 * @param {typeof supabase} [cliente] injeção para teste (padrão: o cliente real)
 * @returns {Promise<any[]>}
 */
export async function buscar(tabela, colunas, filtro, cliente = supabase) {
  try {
    let q = cliente.from(tabela).select(colunas);
    if (filtro) q = filtro(q);
    const { data, error } = await q;
    if (error) return [];
    return data ?? [];
  } catch {
    return [];
  }
}

/** Primeiro dia do mês, em ISO date (YYYY-MM-DD). @param {Date} d */
export function inicioDoMes(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

/**
 * Série mensal de contagens a partir de uma lista de timestamps.
 * Preenche meses sem registro com 0 — um gráfico com buracos mente sobre a
 * forma da curva.
 * @param {string[]} timestamps
 * @param {number} meses
 * @returns {Array<{mes: string, total: number}>}
 */
export function serieMensal(timestamps, meses = 12) {
  const agora = new Date();
  const balde = new Map();
  for (let i = meses - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - i, 1));
    balde.set(d.toISOString().slice(0, 7), 0);
  }
  for (const ts of timestamps) {
    if (!ts) continue;
    const chave = String(ts).slice(0, 7);
    if (balde.has(chave)) balde.set(chave, balde.get(chave) + 1);
  }
  return [...balde.entries()].map(([mes, total]) => ({ mes, total }));
}
