// Gera a LISTA DE REVISÃO (markdown) dos itens ambíguos: duplicatas, prováveis
// renomeações (banco ↔ planilha) e itens sem par. SOMENTE LEITURA.
import fs from "node:fs";
import { supabase as sb } from "../src/config/supabase.js";
const ORG = process.env.DEFAULT_ORG_ID;
const planilha = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const outPath = process.argv[3] || "review.md";

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const toks = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 1 && !/^CX|^FD$|^PCT$|^UN$|^UND$|^C$/.test(w)));
const jac = (a, b) => { const A = toks(a), B = toks(b); let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i || 1); };
const soDigitos = (s) => /^\d+$/.test(String(s ?? ""));

const { data: dbAll } = await sb.from("insumos").select("id, codigo, nome, tipo, preco_unitario").eq("organizacao_id", ORG);
const { data: fichas } = await sb.from("ficha_tecnica").select("insumo_id").not("insumo_id", "is", null);
const usados = new Set((fichas ?? []).map((f) => f.insumo_id));

const planByCod = new Map();
for (const p of planilha) if (p.codigo && soDigitos(p.codigo)) planByCod.set(String(p.codigo), p);

// Casados por código (já tratados) — excluir das listas
const dbCasado = new Set(), planCasado = new Set();
for (const d of dbAll) if (soDigitos(d.codigo) && planByCod.has(String(d.codigo))) { dbCasado.add(d.id); planCasado.add(planByCod.get(String(d.codigo))); }

const soDb = dbAll.filter((d) => !dbCasado.has(d.id));
const soPlan = planilha.filter((p) => !planCasado.has(p));

// Duplicatas no banco
const byNome = new Map();
for (const d of dbAll) { const k = norm(d.nome); (byNome.get(k) ?? byNome.set(k, []).get(k)).push(d); }
const dups = [...byNome.values()].filter((g) => g.length > 1);

// Sugestão de renomeação: para cada soDb, melhor soPlan por Jaccard (>=0.34)
const pares = [], soDbSemPar = [];
const planUsadoPar = new Set();
for (const d of soDb) {
  let best = null, bs = 0;
  for (const p of soPlan) { const s = jac(d.nome, p.nome); if (s > bs) { bs = s; best = p; } }
  if (best && bs >= 0.34) { pares.push({ d, p: best, s: bs }); planUsadoPar.add(best); }
  else soDbSemPar.push(d);
}
const novosSemPar = soPlan.filter((p) => !planUsadoPar.has(p));

const M = [];
M.push(`# Revisão de insumos — itens ambíguos\n`);
M.push(`Base: org Grupo Saci. Casados por código (já atualizados): ${dbCasado.size}. Molho Goulash já excluído.\n`);

M.push(`## 1) Duplicatas no banco (${dups.length} grupos) — unificar\n`);
M.push(`Recomendo manter a linha COM código e repontar as fichas para ela.\n`);
for (const g of dups) {
  M.push(`- **${g[0].nome}**`);
  for (const d of g) M.push(`  - id \`${d.id}\` · código ${d.codigo ?? "—"} · custo ${d.preco_unitario} · ${usados.has(d.id) ? "USADO em ficha" : "livre"}`);
}

M.push(`\n## 2) Prováveis RENOMEAÇÕES (banco → planilha) — confirmar (${pares.length})\n`);
M.push(`Se for o mesmo item, mantenho o do banco (preserva ficha) e atualizo nome/custo pelo da planilha.\n`);
M.push(`| Banco (atual) | → Planilha (novo) | sim. | em ficha |`);
M.push(`|---|---|---|---|`);
for (const { d, p, s } of pares.sort((a, b) => b.s - a.s))
  M.push(`| [${d.codigo ?? "—"}] ${d.nome} (R$ ${d.preco_unitario}) | [${p.codigo ?? "—"}] ${p.nome} (R$ ${p.preco_unitario}) | ${(s * 100).toFixed(0)}% | ${usados.has(d.id) ? "sim" : "não"} |`);

M.push(`\n## 3) NOVOS de verdade (só na planilha) — cadastrar? (${novosSemPar.length})\n`);
for (const p of novosSemPar) M.push(`- [ ] [${p.codigo ?? "—"}] ${p.nome} · ${p.categoria}/${p.unidade} · custo R$ ${p.preco_unitario} (caixa ${p.preco_caixa})`);

M.push(`\n## 4) SÓ NO BANCO, sem par (obsoletos?) — inativar/excluir? (${soDbSemPar.length})\n`);
for (const d of soDbSemPar) M.push(`- [ ] [${d.codigo ?? "—"}] ${d.nome} · custo R$ ${d.preco_unitario} · ${usados.has(d.id) ? "USADO em ficha → inativar" : "livre → pode excluir"}`);

fs.writeFileSync(outPath, M.join("\n"));
console.log(`Revisão gerada: ${outPath}`);
console.log(`Duplicatas: ${dups.length} | Renomeações prováveis: ${pares.length} | Novos: ${novosSemPar.length} | Só-banco s/par: ${soDbSemPar.length}`);
