// SOMENTE LEITURA — estado atual do banco e ficha dos produtos BMT.
import { supabase as sb } from "../src/config/supabase.js";
const ORG = process.env.DEFAULT_ORG_ID;

const { count: nIns } = await sb.from("insumos").select("id", { count: "exact", head: true }).eq("organizacao_id", ORG);
const { data: prods } = await sb.from("produtos").select("id, nome, tipo, tamanho, custo_cache, vendavel").eq("organizacao_id", ORG);
const ids = prods.map((p) => p.id);
const { data: fichas } = await sb.from("ficha_tecnica").select("id, produto_id, insumo_id, quantidade, unidade_uso, quantidade_informada, origem").in("produto_id", ids);
const { data: ins } = await sb.from("insumos").select("id, nome, unidade_medida, preco_unitario, origem").eq("organizacao_id", ORG);
const insById = new Map(ins.map((i) => [i.id, i]));

console.log(`Insumos: ${nIns} | Produtos: ${prods.length} | Linhas de ficha: ${fichas.length}`);
const comOrigem = ins.filter((i) => i.origem).length;
console.log(`Insumos com origem marcada (reconstrução): ${comOrigem}`);
const prodsComFicha = new Set(fichas.map((f) => f.produto_id)).size;
console.log(`Produtos com ficha: ${prodsComFicha}`);

const alvo = prods.filter((p) => /bmt|carne seca|teriack|vegetariano|defumado/i.test(p.nome));
for (const p of alvo.sort((a, b) => a.nome.localeCompare(b.nome))) {
  const linhas = fichas.filter((f) => f.produto_id === p.id);
  console.log(`\n## ${p.nome} [${p.tamanho ?? "-"}] custo_cache=${p.custo_cache}`);
  for (const l of linhas) {
    const i = insById.get(l.insumo_id) ?? {};
    console.log(`   - ${i.nome ?? "?"} | ${l.quantidade_informada ?? l.quantidade} ${l.unidade_uso ?? i.unidade_medida} | custo_un=${i.preco_unitario}`);
  }
}
