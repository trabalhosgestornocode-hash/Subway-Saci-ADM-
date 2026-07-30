// SOMENTE LEITURA — diff entre a planilha (base_planilha.json) e a tabela insumos.
// Não escreve nada. Rodar: node --env-file=.env scripts/insumos-diff.mjs <json>
import fs from "node:fs";
import { supabase as sb } from "../src/config/supabase.js";

const ORG = process.env.DEFAULT_ORG_ID;
const jsonPath = process.argv[2];
const planilha = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
// chave "curta" = primeiras palavras significativas (ignora pack tipo CX4X1KG, 500UN)
const chaveNome = (s) => norm(s).split(" ").filter((w) => !/^\d+X?\d*(KG|G|UN|ML|L|GR|CX|PCT|UND|FD|CJ|BOX)?$/i.test(w) && !/^C\d+$/i.test(w)).slice(0, 3).join(" ");

const { data: dbAll } = await sb.from("insumos")
  .select("id, codigo, nome, tipo, unidade_medida, preco_caixa, rendimento, preco_unitario, ativo")
  .eq("organizacao_id", ORG).order("nome");
const { data: fichas } = await sb.from("ficha_tecnica").select("insumo_id").not("insumo_id", "is", null);
const usados = new Set((fichas ?? []).map((f) => f.insumo_id));

// Índices da planilha
const planByCod = new Map();
const planByNome = new Map();
for (const p of planilha) {
  if (p.codigo) planByCod.set(String(p.codigo), p);
  const k = chaveNome(p.nome);
  if (k && !planByNome.has(k)) planByNome.set(k, p);
}

// Duplicatas no banco (mesmo nome normalizado)
const dbByNome = new Map();
for (const d of dbAll) {
  const k = norm(d.nome);
  if (!dbByNome.has(k)) dbByNome.set(k, []);
  dbByNome.get(k).push(d);
}
const duplicatas = [...dbByNome.values()].filter((g) => g.length > 1);

// Classificação
const matched = [], novos = [], soDb = [];
const planUsados = new Set();

for (const d of dbAll) {
  let p = d.codigo ? planByCod.get(String(d.codigo)) : null;
  let via = p ? "codigo" : null;
  if (!p) { const k = chaveNome(d.nome); p = planByNome.get(k); if (p) via = "nome"; }
  if (p) { matched.push({ d, p, via }); planUsados.add(p); }
  else soDb.push(d);
}
for (const p of planilha) if (!planUsados.has(p)) novos.push(p);

const eq = (a, b) => Math.abs(Number(a ?? -1) - Number(b ?? -1)) < 0.005;
const alterados = matched.filter(({ d, p }) => !eq(d.preco_unitario, p.preco_unitario) || !eq(d.preco_caixa, p.preco_caixa));

// ---------- RELATÓRIO ----------
const L = [];
L.push(`DB insumos: ${dbAll.length} | Planilha insumos-base: ${planilha.length}`);
L.push(`\n== CASADOS: ${matched.length} (por código: ${matched.filter(m=>m.via==="codigo").length}, por nome: ${matched.filter(m=>m.via==="nome").length}) ==`);
L.push(`   destes, com custo/preço DIFERENTE: ${alterados.length}`);
for (const { d, p, via } of alterados.slice(0, 200)) {
  L.push(`   ~ [${d.codigo ?? "—"}] ${d.nome}  (match:${via})`);
  L.push(`       preco_unit: ${d.preco_unitario} -> ${p.preco_unitario}   caixa: ${d.preco_caixa} -> ${p.preco_caixa}  rend: ${d.rendimento} -> ${p.rendimento}`);
}

L.push(`\n== NOVOS (na planilha, não no banco): ${novos.length} ==`);
for (const p of novos) L.push(`   + [${p.codigo ?? "—"}] ${p.nome}  (${p.categoria}/${p.unidade}) un=${p.preco_unitario} caixa=${p.preco_caixa}`);

L.push(`\n== SÓ NO BANCO (não na planilha) → candidatos a REMOVER: ${soDb.length} ==`);
for (const d of soDb) L.push(`   - [${d.codigo ?? "—"}] ${d.nome}  ${usados.has(d.id) ? "⚠ USADO EM FICHA (inativar, não excluir)" : "livre (pode excluir)"}`);

L.push(`\n== DUPLICATAS no banco (mesmo nome): ${duplicatas.length} grupos ==`);
for (const g of duplicatas) {
  L.push(`   • ${g[0].nome}:`);
  for (const d of g) L.push(`       id=${d.id} codigo=${d.codigo ?? "—"} un=${d.preco_unitario} ${usados.has(d.id) ? "USADO" : "livre"}`);
}

const rep = L.join("\n");
fs.writeFileSync(process.argv[3] || "diff_report.txt", rep);
console.log(rep);
