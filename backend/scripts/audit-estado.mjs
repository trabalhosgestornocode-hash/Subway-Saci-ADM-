// SOMENTE LEITURA — mede volume de dados históricos p/ escolher estratégia.
import { supabase as sb } from "../src/config/supabase.js";
const ORG = process.env.DEFAULT_ORG_ID;
const cnt = async (t, f) => { let q = sb.from(t).select("id", { count: "exact", head: true }); if (f) q = f(q); const { count, error } = await q; return error ? `erro(${error.message})` : count; };

console.log("ORG:", ORG);
const { data: unids } = await sb.from("unidades").select("id, nome, organizacao_id").eq("organizacao_id", ORG);
console.log("UNIDADES:", (unids ?? []).map((u) => `${u.id} = ${u.nome}`).join(" | ") || "nenhuma");

console.log("\nVOLUME DE DADOS:");
console.log("  insumos:", await cnt("insumos", (q) => q.eq("organizacao_id", ORG)));
console.log("  produtos:", await cnt("produtos", (q) => q.eq("organizacao_id", ORG)));
console.log("  produto_precos:", await cnt("produto_precos"));
console.log("  ficha_tecnica:", await cnt("ficha_tecnica"));
console.log("  vendas:", await cnt("vendas"));
console.log("  vendas_itens:", await cnt("vendas_itens"));
console.log("  movimentacoes_estoque:", await cnt("movimentacoes_estoque"));
console.log("  estoque:", await cnt("estoque"));
console.log("  pedidos_compra_itens:", await cnt("pedidos_compra_itens"));
console.log("  lotes:", await cnt("lotes"));
console.log("  insumo_historico:", await cnt("insumo_historico", (q) => q.eq("organizacao_id", ORG)));
console.log("  produto_historico:", await cnt("produto_historico", (q) => q.eq("organizacao_id", ORG)));

// Insumos referenciados por movimentacoes/estoque/pedidos (bloqueiam hard-delete)
for (const t of ["movimentacoes_estoque", "estoque", "pedidos_compra_itens", "lotes"]) {
  const { data } = await sb.from(t).select("insumo_id").limit(1000);
  const n = new Set((data ?? []).map((r) => r.insumo_id)).size;
  console.log(`  insumos referenciados em ${t}: ${n}`);
}
