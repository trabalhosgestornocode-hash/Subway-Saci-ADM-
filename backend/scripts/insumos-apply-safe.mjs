// Aplica APENAS o que é 100% seguro na base de insumos:
//   1) Atualiza custo (preco_unitario/preco_caixa/rendimento) dos insumos casados
//      por CÓDIGO NUMÉRICO EXATO com a planilha (sem tocar em ficha).
//   2) Exclui SOMENTE o Molho Goulash [1000913] se estiver livre (sem ficha).
// Registra insumo_historico (best-effort). Preserva todos os vínculos.
//
// Dry-run por padrão. Para gravar:  node --env-file=.env scripts/insumos-apply-safe.mjs <json> --apply
import fs from "node:fs";
import { supabase as sb } from "../src/config/supabase.js";

const ORG = process.env.DEFAULT_ORG_ID;
const jsonPath = process.argv[2];
const APPLY = process.argv.includes("--apply");
const planilha = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

const RE_COL = /does not exist|schema cache|could not find/i;
const soDigitos = (s) => /^\d+$/.test(String(s ?? ""));
const eq = (a, b) => Math.abs(Number(a ?? -999999) - Number(b ?? -999999)) < 0.005;

const planByCod = new Map();
for (const p of planilha) if (p.codigo && soDigitos(p.codigo)) planByCod.set(String(p.codigo), p);

const { data: dbAll } = await sb.from("insumos")
  .select("id, codigo, nome, preco_caixa, rendimento, preco_unitario, unidade_medida")
  .eq("organizacao_id", ORG);
const { data: fichas } = await sb.from("ficha_tecnica").select("insumo_id").not("insumo_id", "is", null);
const usados = new Set((fichas ?? []).map((f) => f.insumo_id));

console.log(APPLY ? "=== MODO APPLY (gravando) ===" : "=== DRY-RUN (nada será gravado) ===");

// ---------- 1) UPDATES por código exato ----------
let atualizados = 0;
for (const d of dbAll) {
  if (!soDigitos(d.codigo)) continue;
  const p = planByCod.get(String(d.codigo));
  if (!p) continue;
  const mudou = !eq(d.preco_unitario, p.preco_unitario) || !eq(d.preco_caixa, p.preco_caixa) || !eq(d.rendimento, p.rendimento);
  if (!mudou) continue;

  console.log(`~ [${d.codigo}] ${d.nome}`);
  console.log(`    preco_unit ${d.preco_unitario} -> ${p.preco_unitario} | caixa ${d.preco_caixa} -> ${p.preco_caixa} | rend ${d.rendimento} -> ${p.rendimento}`);

  if (APPLY) {
    const patchFull = {
      preco_unitario: p.preco_unitario, preco_caixa: p.preco_caixa, rendimento: p.rendimento,
      preco_atualizado_em: new Date().toISOString(),
    };
    let r = await sb.from("insumos").update(patchFull).eq("id", d.id).eq("organizacao_id", ORG);
    if (r.error && RE_COL.test(r.error.message)) {
      r = await sb.from("insumos").update({ preco_unitario: p.preco_unitario, preco_caixa: p.preco_caixa, rendimento: p.rendimento }).eq("id", d.id).eq("organizacao_id", ORG);
    }
    if (r.error) { console.log("    ERRO:", r.error.message); continue; }
    // histórico best-effort
    const hist = {
      organizacao_id: ORG, insumo_id: d.id,
      preco_anterior: d.preco_caixa, preco_novo: p.preco_caixa,
      custo_anterior: d.preco_unitario, custo_novo: p.preco_unitario,
      variacao_pct: d.preco_unitario ? ((p.preco_unitario - d.preco_unitario) / d.preco_unitario) * 100 : null,
      observacao: "Sincronização com planilha atualizada (Base de Insumos)",
    };
    const h = await sb.from("insumo_historico").insert(hist);
    if (h.error && !RE_COL.test(h.error.message)) console.log("    (hist não gravado:", h.error.message, ")");
  }
  atualizados++;
}

// ---------- 2) DELETE Molho Goulash (se livre) ----------
const goulash = dbAll.find((d) => String(d.codigo) === "1000913" || /molho goulash/i.test(d.nome));
console.log("\n-- Exclusão obsoleto confirmado --");
if (!goulash) {
  console.log("Molho Goulash não encontrado (já removido?).");
} else if (usados.has(goulash.id)) {
  console.log(`Molho Goulash [${goulash.codigo}] está EM USO em ficha — NÃO será excluído (inativar seria o correto).`);
} else {
  console.log(`- [${goulash.codigo}] ${goulash.nome}  (livre) -> EXCLUIR`);
  if (APPLY) {
    const del = await sb.from("insumos").delete().eq("id", goulash.id).eq("organizacao_id", ORG);
    console.log(del.error ? "    ERRO: " + del.error.message : "    excluído.");
  }
}

console.log(`\nResumo: ${atualizados} insumo(s) ${APPLY ? "atualizados" : "a atualizar"}.`);
