// SOMENTE LEITURA — inspeciona organizações e insumos existentes.
// Rodar: node --env-file=.env scripts/insumos-inspect.mjs
import { supabase as sb } from "../src/config/supabase.js";

const { data: orgs } = await sb.from("organizacoes").select("id, nome, ativo").order("created_at");
console.log("ORGANIZAÇÕES:");
for (const o of orgs ?? []) {
  const { count } = await sb.from("insumos").select("id", { count: "exact", head: true }).eq("organizacao_id", o.id);
  console.log(`  ${o.id}  ${o.nome}  ativo=${o.ativo}  insumos=${count}`);
}
console.log("DEFAULT_ORG_ID:", process.env.DEFAULT_ORG_ID);

const org = process.env.DEFAULT_ORG_ID;
const { data: ins } = await sb.from("insumos")
  .select("id, codigo, nome, tipo, unidade_medida, preco_caixa, rendimento, preco_unitario, ativo")
  .eq("organizacao_id", org).order("nome");
console.log(`\nINSUMOS na org default (${(ins ?? []).length}):`);
for (const i of ins ?? []) {
  console.log(`  [${i.codigo ?? "—"}] ${i.nome} | ${i.tipo}/${i.unidade_medida} | caixa=${i.preco_caixa} rend=${i.rendimento} un=${i.preco_unitario} ativo=${i.ativo}`);
}

// Quantos insumos estão vinculados a fichas (para saber o que NÃO pode ser hard-deletado)
const { data: fichas } = await sb.from("ficha_tecnica").select("insumo_id").not("insumo_id", "is", null);
const usados = new Set((fichas ?? []).map((f) => f.insumo_id));
console.log(`\nINSUMOS vinculados a fichas: ${usados.size}`);
