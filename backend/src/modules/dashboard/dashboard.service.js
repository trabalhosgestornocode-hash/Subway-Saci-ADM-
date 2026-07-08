import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

// Resumo operacional da unidade. (Faturamento fica zerado até haver vendas.)
export async function resumo({ unidadeId }) {
  if (!unidadeId) throw ApiError.badRequest("Unidade não vinculada ao perfil do usuário.");

  const [faturamento, estoqueCritico, ranking] = await Promise.all([
    supabase.from("vw_faturamento_diario").select("dia, origem, qtd_vendas, faturamento").eq("unidade_id", unidadeId),
    supabase.from("vw_estoque_critico").select("insumo, quantidade_atual, estoque_minimo, unidade_medida").eq("unidade_id", unidadeId),
    supabase.from("vw_produtos_vendidos").select("nome, qtd_total, receita_total").eq("unidade_id", unidadeId).order("qtd_total", { ascending: false }).limit(10),
  ]);

  for (const r of [faturamento, estoqueCritico, ranking]) {
    if (r.error) throw ApiError.internal(r.error.message);
  }

  const totalFaturamento = (faturamento.data ?? []).reduce((s, r) => s + Number(r.faturamento || 0), 0);

  return {
    faturamento: {
      total: totalFaturamento,
      porDiaOrigem: faturamento.data ?? [],
    },
    estoqueCritico: estoqueCritico.data ?? [],
    topProdutos: ranking.data ?? [],
  };
}
