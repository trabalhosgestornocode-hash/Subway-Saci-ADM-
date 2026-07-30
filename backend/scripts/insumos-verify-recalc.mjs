// Verifica algumas atualizações e recalcula custo_cache dos produtos da org.
import { supabase as sb } from "../src/config/supabase.js";
const ORG = process.env.DEFAULT_ORG_ID;

// 1) Amostra de verificação
const cods = ["1000907", "1000976", "1000799", "1000913"];
const { data } = await sb.from("insumos").select("codigo, nome, preco_caixa, rendimento, preco_unitario, preco_atualizado_em")
  .eq("organizacao_id", ORG).in("codigo", cods);
console.log("VERIFICAÇÃO (pós-update):");
for (const i of data ?? []) console.log(`  [${i.codigo}] ${i.nome} caixa=${i.preco_caixa} rend=${i.rendimento} un=${i.preco_unitario} em=${i.preco_atualizado_em}`);
console.log("  Molho Goulash presente?", (data ?? []).some((i) => i.codigo === "1000913") ? "SIM (erro!)" : "não (excluído ✔)");

// 2) Histórico gravado?
const { count: hc, error: he } = await sb.from("insumo_historico").select("id", { count: "exact", head: true }).eq("organizacao_id", ORG);
console.log("\ninsumo_historico:", he ? `indisponível (${he.message})` : `${hc} registro(s)`);

// 3) Recalcula custo_cache de todos os produtos da org (fn_recalc_custo já existe no banco)
const { data: prods } = await sb.from("produtos").select("id, nome").eq("organizacao_id", ORG);
let ok = 0, fail = 0;
for (const p of prods ?? []) {
  const { error } = await sb.rpc("fn_recalc_custo", { p_produto_id: p.id });
  if (error) { fail++; if (fail <= 3) console.log("  recalc erro:", p.nome, error.message); }
  else ok++;
}
console.log(`\nRecalc custo_cache: ${ok} ok, ${fail} falha (de ${(prods ?? []).length} produtos).`);
