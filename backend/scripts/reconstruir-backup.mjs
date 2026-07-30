// Backup lógico (JSON + SQL) de insumos, ficha_tecnica, insumo_historico,
// produtos e produto_precos de uma organização. SOMENTE LEITURA.
// Uso: node --env-file=.env scripts/reconstruir-backup.mjs --org=<ORG_ID> [--out=dir]
import fs from "node:fs";
import path from "node:path";
import { supabase as sb } from "../src/config/supabase.js";

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d ?? ""}`).split("=").slice(1).join("=");
const ORG = arg("org", process.env.DEFAULT_ORG_ID);
const STAMP = arg("stamp", new Date().toISOString().replace(/[:.]/g, "-"));
const OUT = arg("out", path.join("backups", `insumos-${STAMP}`));
fs.mkdirSync(OUT, { recursive: true });

const dump = async (tabela, filtro) => {
  let q = sb.from(tabela).select("*");
  if (filtro) q = filtro(q);
  const { data, error } = await q;
  if (error) { console.warn(`  ${tabela}: erro ${error.message}`); return []; }
  return data ?? [];
};

const produtos = await dump("produtos", (q) => q.eq("organizacao_id", ORG));
const prodIds = produtos.map((p) => p.id);
const insumos = await dump("insumos", (q) => q.eq("organizacao_id", ORG));
const fichas = prodIds.length ? await dump("ficha_tecnica", (q) => q.in("produto_id", prodIds)) : [];
const precos = prodIds.length ? await dump("produto_precos", (q) => q.in("produto_id", prodIds)) : [];
const histInsumo = await dump("insumo_historico", (q) => q.eq("organizacao_id", ORG));

const bundle = { organizacao_id: ORG, gerado_em: new Date().toISOString(), contagens: { insumos: insumos.length, produtos: produtos.length, ficha_tecnica: fichas.length, produto_precos: precos.length, insumo_historico: histInsumo.length }, insumos, produtos, ficha_tecnica: fichas, produto_precos: precos, insumo_historico: histInsumo };
fs.writeFileSync(path.join(OUT, "backup.json"), JSON.stringify(bundle, null, 1));

// SQL de restauração (INSERT ... ON CONFLICT DO NOTHING) para insumos e ficha.
const sqlVal = (v) => v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : `'${String(v).replace(/'/g, "''")}'`;
const insertRows = (tabela, rows) => {
  if (!rows.length) return `-- ${tabela}: vazio\n`;
  const cols = Object.keys(rows[0]);
  const linhas = rows.map((r) => `(${cols.map((c) => sqlVal(r[c])).join(", ")})`).join(",\n");
  return `-- ${tabela}: ${rows.length} linhas\nINSERT INTO ${tabela} (${cols.join(", ")}) VALUES\n${linhas}\nON CONFLICT (id) DO NOTHING;\n\n`;
};
const sql = [
  `-- BACKUP insumos+ficha da org ${ORG} em ${bundle.gerado_em}`,
  `-- Restauração: rode este arquivo no SQL Editor (repõe as linhas por id).`,
  insertRows("insumos", insumos),
  insertRows("ficha_tecnica", fichas),
  insertRows("insumo_historico", histInsumo),
].join("\n");
fs.writeFileSync(path.join(OUT, "restore.sql"), sql);

console.log("BACKUP salvo em:", OUT);
console.log("  contagens:", JSON.stringify(bundle.contagens));
