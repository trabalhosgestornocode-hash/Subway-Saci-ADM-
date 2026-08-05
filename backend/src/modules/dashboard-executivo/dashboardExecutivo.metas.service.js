// Resolução de metas de rentabilidade — cascata unidade > organização > global.
// Metas ficam centralizadas em `metas_indicadores` (migration 023) para não se
// espalharem/duplicarem pelo código (a planilha de origem já mostra metas
// diferentes por loja, então hardcode não serve).

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

export const INDICADORES = ["taxas_comissoes", "servicos_promocoes", "taxas_entregadores", "total_deducoes"];

/**
 * Resolve as metas efetivas para uma unidade, em cascata: linha específica da
 * unidade -> linha da organização (unidade_id null) -> linha global (ambos
 * null). `meta_ideal`/`limite` são gravados como fração (0.2050) e aqui já
 * saem convertidos para porcentagem (0-100), a escala que `dashboardExecutivo
 * .calc.js` usa.
 * @param {{organizacaoId: string, unidadeId: string}} p
 * @returns {Promise<Record<string, {metaIdeal: number, limite: number}>>}
 */
export async function resolverMetas({ organizacaoId, unidadeId }) {
  const { data, error } = await supabase
    .from("metas_indicadores")
    .select("organizacao_id, unidade_id, indicador, meta_ideal, limite")
    .or(`unidade_id.eq.${unidadeId},and(unidade_id.is.null,organizacao_id.eq.${organizacaoId}),and(unidade_id.is.null,organizacao_id.is.null)`);

  if (error) throw ApiError.internal(error.message);

  const porIndicador = new Map();
  // Prioridade: unidade (3) > organização (2) > global (1). Mantém a de maior prioridade.
  const prioridade = (linha) => (linha.unidade_id ? 3 : linha.organizacao_id ? 2 : 1);
  for (const linha of data ?? []) {
    const atual = porIndicador.get(linha.indicador);
    if (!atual || prioridade(linha) > prioridade(atual)) porIndicador.set(linha.indicador, linha);
  }

  /** @type {Record<string, {metaIdeal: number, limite: number}>} */
  const resultado = {};
  for (const indicador of INDICADORES) {
    const linha = porIndicador.get(indicador);
    if (!linha) continue;
    resultado[indicador] = { metaIdeal: Number(linha.meta_ideal) * 100, limite: Number(linha.limite) * 100 };
  }
  return resultado;
}
