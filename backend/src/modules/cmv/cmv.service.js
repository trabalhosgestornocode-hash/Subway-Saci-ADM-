import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

// Margem/CMV por produto x canal x tabela (view vw_produto_margem).
export async function listarMargens({ organizacaoId, canal, tabela }) {
  let q = supabase
    .from("vw_produto_margem")
    .select("produto_id, nome, tamanho, canal, tabela, preco, custo, comissao_pct, lucro_liquido, cmv_pct, desatualizado")
    .eq("organizacao_id", organizacaoId)
    .order("nome");
  if (canal) q = q.eq("canal", canal);
  if (tabela) q = q.eq("tabela", tabela);
  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);
  return data;
}

// CMV de 1 produto (todas as combinações canal/tabela)
export async function margemProduto({ organizacaoId, produtoId }) {
  const { data, error } = await supabase
    .from("vw_produto_margem")
    .select("*")
    .eq("organizacao_id", organizacaoId)
    .eq("produto_id", produtoId);
  if (error) throw ApiError.internal(error.message);
  return data;
}
