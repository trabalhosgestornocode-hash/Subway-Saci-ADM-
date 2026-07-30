// Correção: reativa todo insumo que ainda está vinculado a uma ficha (um insumo
// EM USO nunca deve ficar inativo). Restaura a integridade das fichas após a
// reconciliação em bloco. Recalcula custo_cache. Dry-run sem --apply.
import { supabase as sb } from "../src/config/supabase.js";
const ORG = process.env.DEFAULT_ORG_ID;
const APPLY = process.argv.includes("--apply");

const { data: prods } = await sb.from("produtos").select("id, nome").eq("organizacao_id", ORG);
const orgProdIds = prods.map((p) => p.id);
const { data: fichas } = await sb.from("ficha_tecnica").select("insumo_id").not("insumo_id", "is", null).in("produto_id", orgProdIds);
const usados = [...new Set(fichas.map((f) => f.insumo_id))];

const { data: inativosUsados } = await sb.from("insumos")
  .select("id, codigo, nome").eq("organizacao_id", ORG).eq("ativo", false).in("id", usados);

console.log(`${APPLY ? "APPLY" : "DRY-RUN"} — insumos inativos AINDA em uso: ${(inativosUsados ?? []).length}`);
for (const i of inativosUsados ?? []) console.log(`  ↺ reativar [${i.codigo ?? "—"}] ${i.nome}`);

if (APPLY && (inativosUsados ?? []).length) {
  const ids = inativosUsados.map((i) => i.id);
  const { error } = await sb.from("insumos").update({ ativo: true }).eq("organizacao_id", ORG).in("id", ids);
  console.log(error ? "ERRO: " + error.message : "reativados.");
  let ok = 0; for (const p of prods) { const { error: e } = await sb.rpc("fn_recalc_custo", { p_produto_id: p.id }); if (!e) ok++; }
  console.log(`recalc: ${ok}/${prods.length}`);
}
