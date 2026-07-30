// Pós-reconciliação: acha fichas apontando para insumo INATIVO e sugere o
// gêmeo ATIVO para repontar. Também confere se algum produto ficou sem custo.
// SOMENTE LEITURA (a menos de --apply-repoint, que reponta as fichas sugeridas
// com similaridade >= --sim).
import fs from "node:fs";
import { supabase as sb } from "../src/config/supabase.js";
const ORG = process.env.DEFAULT_ORG_ID;
const APPLY = process.argv.includes("--apply-repoint");
const SIM = Number((process.argv.find((a) => a.startsWith("--sim=")) || "--sim=0.5").split("=")[1]);
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const toks = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 1 && !/^(CX|FD|PCT|UN|UND|C)$/.test(w)));
const jac = (a, b) => { const A = toks(a), B = toks(b); let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i || 1); };

const { data: db } = await sb.from("insumos").select("id, codigo, nome, ativo, preco_unitario, unidade_medida").eq("organizacao_id", ORG);
const byId = new Map(db.map((d) => [d.id, d]));
const ativos = db.filter((d) => d.ativo !== false);
const { data: prods } = await sb.from("produtos").select("id, nome, custo_cache").eq("organizacao_id", ORG);
const nomeProd = new Map(prods.map((p) => [p.id, p.nome]));
const orgProdIds = prods.map((p) => p.id);
const { data: fichas } = await sb.from("ficha_tecnica").select("id, produto_id, insumo_id, unidade_uso").not("insumo_id", "is", null).in("produto_id", orgProdIds);

console.log(`Insumos: ${db.length} (ativos ${ativos.length}, inativos ${db.length - ativos.length}). Produtos: ${prods.length}.`);
const semCusto = prods.filter((p) => p.custo_cache == null || Number(p.custo_cache) === 0);
console.log(`Produtos com custo_cache 0/null: ${semCusto.length}${semCusto.length ? " -> " + semCusto.map((p) => p.nome).join(", ") : ""}`);

const linhasInativas = fichas.filter((f) => byId.get(f.insumo_id)?.ativo === false);
console.log(`\nFichas apontando p/ insumo INATIVO: ${linhasInativas.length}`);
const rep = [];
let repontáveis = 0;
for (const f of linhasInativas) {
  const ins = byId.get(f.insumo_id);
  let best = null, bs = 0;
  for (const a of ativos) { const s = jac(ins.nome, a.nome); if (s > bs) { bs = s; best = a; } }
  const alvoOk = best && bs >= SIM && best.unidade_medida === ins.unidade_medida;
  rep.push(`  • ${nomeProd.get(f.produto_id)}: "${ins.nome}" (inativo) ${alvoOk ? `→ "${best.nome}" (${(bs * 100).toFixed(0)}%)` : `→ SEM gêmeo claro (melhor ${best ? best.nome + " " + (bs * 100).toFixed(0) + "%" : "—"})`}`);
  if (alvoOk) {
    repontáveis++;
    if (APPLY) {
      // evita violar unique(produto,insumo): se já existe linha com o alvo, remove a inativa
      const conflito = fichas.some((x) => x.produto_id === f.produto_id && x.insumo_id === best.id);
      if (conflito) await sb.from("ficha_tecnica").delete().eq("id", f.id);
      else await sb.from("ficha_tecnica").update({ insumo_id: best.id }).eq("id", f.id);
    }
  }
}
console.log(rep.join("\n"));
console.log(`\nRepontáveis automaticamente (>=${SIM}, mesma unidade): ${repontáveis} de ${linhasInativas.length}`);
if (APPLY) {
  let ok = 0; for (const p of prods) { const { error } = await sb.rpc("fn_recalc_custo", { p_produto_id: p.id }); if (!error) ok++; }
  console.log(`Repontado + recalc: ${ok}/${prods.length}`);
}
fs.writeFileSync(process.argv[process.argv.length - 1].endsWith(".txt") ? process.argv[process.argv.length - 1] : "postcheck.txt", rep.join("\n"));
