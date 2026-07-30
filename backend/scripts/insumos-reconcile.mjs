// Reconciliação em bloco (aprovada pelo usuário — opção 1).
// Ordem: (1) renomeações >=SIM, (2) dedup, (3) inserir novos, (4) obsoletos.
// Preserva vínculos: renomeia in-place (mantém id/ficha); no dedup reponta a
// ficha do "perdedor" para o "mantido"; nunca toca nos sintéticos SYN-*.
//
// Dry-run por padrão.  Aplicar:  node --env-file=.env scripts/insumos-reconcile.mjs <json> --apply [--sim=0.8]
import fs from "node:fs";
import { supabase as sb } from "../src/config/supabase.js";

const ORG = process.env.DEFAULT_ORG_ID;
const planilha = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const APPLY = process.argv.includes("--apply");
const SIM = Number((process.argv.find((a) => a.startsWith("--sim=")) || "--sim=0.8").split("=")[1]);
const RE_COL = /does not exist|schema cache|could not find/i;
const soDigitos = (s) => /^\d+$/.test(String(s ?? ""));
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const toks = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 1 && !/^(CX|FD|PCT|UN|UND|C)$/.test(w)));
const jac = (a, b) => { const A = toks(a), B = toks(b); let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i || 1); };
const eq = (a, b) => Math.abs(Number(a ?? -1e9) - Number(b ?? -1e9)) < 0.005;
const log = [];
const P = (s) => { log.push(s); console.log(s); };

async function refetch() {
  const { data } = await sb.from("insumos").select("id, codigo, nome, tipo, unidade_medida, preco_caixa, rendimento, preco_unitario, ativo").eq("organizacao_id", ORG);
  const { data: f } = await sb.from("ficha_tecnica").select("id, produto_id, insumo_id").not("insumo_id", "is", null);
  return { db: data ?? [], fichas: f ?? [] };
}
async function histBE(row) { const h = await sb.from("insumo_historico").insert(row); if (h.error && !RE_COL.test(h.error.message)) P("    (hist: " + h.error.message + ")"); }

let { db, fichas } = await refetch();
const usados = new Set(fichas.map((f) => f.insumo_id));
const codsDb = new Set(db.filter((d) => d.codigo).map((d) => String(d.codigo)));

// ---- índices planilha ----
const planByCod = new Map();
for (const p of planilha) if (p.codigo && soDigitos(p.codigo)) planByCod.set(String(p.codigo), p);
const casadoCod = new Set(db.filter((d) => soDigitos(d.codigo) && planByCod.has(String(d.codigo))).map((d) => d.id));
const casadoPlan = new Set([...planByCod.values()].filter((p) => db.some((d) => String(d.codigo) === String(p.codigo))));

const soDb = db.filter((d) => !casadoCod.has(d.id));
const soPlan = planilha.filter((p) => !casadoPlan.has(p));

P(`=== ${APPLY ? "APPLY" : "DRY-RUN"} | limiar renome=${SIM} ===`);

// ---------- (1) RENOMEAÇÕES >= SIM ----------
P(`\n## (1) Renomeações (>= ${SIM * 100}%)`);
const planPego = new Set();
let nRen = 0;
for (const d of soDb) {
  let best = null, bs = 0;
  for (const p of soPlan) { if (planPego.has(p)) continue; const s = jac(d.nome, p.nome); if (s > bs) { bs = s; best = p; } }
  if (!best || bs < SIM) continue;
  planPego.add(best);
  const patch = { nome: best.nome, tipo: best.categoria, preco_caixa: best.preco_caixa, rendimento: best.rendimento, preco_unitario: best.preco_unitario };
  // adota código da planilha só se numérico e livre no banco
  let adotaCod = "";
  if (soDigitos(best.codigo) && !codsDb.has(String(best.codigo))) { patch.codigo = String(best.codigo); codsDb.add(String(best.codigo)); adotaCod = ` +cod ${best.codigo}`; }
  P(`  ~ [${d.codigo ?? "—"}] ${d.nome} → ${best.nome} (${(bs * 100).toFixed(0)}%)${adotaCod} | custo ${d.preco_unitario}→${best.preco_unitario}`);
  nRen++;
  if (APPLY) {
    let r = await sb.from("insumos").update({ ...patch, preco_atualizado_em: new Date().toISOString() }).eq("id", d.id).eq("organizacao_id", ORG);
    if (r.error && RE_COL.test(r.error.message)) r = await sb.from("insumos").update(patch).eq("id", d.id).eq("organizacao_id", ORG);
    if (r.error) { P("    ERRO: " + r.error.message); continue; }
    if (!eq(d.preco_unitario, best.preco_unitario)) await histBE({ organizacao_id: ORG, insumo_id: d.id, preco_anterior: d.preco_caixa, preco_novo: best.preco_caixa, custo_anterior: d.preco_unitario, custo_novo: best.preco_unitario, variacao_pct: d.preco_unitario ? ((best.preco_unitario - d.preco_unitario) / d.preco_unitario) * 100 : null, observacao: "Renomeação/atualização pela planilha" });
  }
}
P(`  total: ${nRen}`);

// ---------- (2) DEDUP ----------
if (APPLY) ({ db, fichas } = await refetch());
P(`\n## (2) Duplicatas (mesmo nome) — unificar`);
const grupos = new Map();
for (const d of db) { const k = norm(d.nome); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(d); }
let nDedup = 0;
for (const g of [...grupos.values()].filter((x) => x.length > 1)) {
  // mantido: prioriza código numérico; senão qualquer código; senão menor id
  const keeper = g.slice().sort((a, b) => (soDigitos(b.codigo) - soDigitos(a.codigo)) || ((b.codigo ? 1 : 0) - (a.codigo ? 1 : 0)) || String(a.id).localeCompare(String(b.id)))[0];
  const losers = g.filter((x) => x.id !== keeper.id);
  P(`  • ${keeper.nome}: manter [${keeper.codigo ?? "—"}] ${keeper.id.slice(0, 8)}; remover ${losers.map((l) => l.id.slice(0, 8)).join(",")}`);
  nDedup += losers.length;
  if (APPLY) {
    for (const loser of losers) {
      const linhas = fichas.filter((f) => f.insumo_id === loser.id);
      for (const ln of linhas) {
        const conflito = fichas.some((f) => f.produto_id === ln.produto_id && f.insumo_id === keeper.id);
        if (conflito) { await sb.from("ficha_tecnica").delete().eq("id", ln.id); }
        else { await sb.from("ficha_tecnica").update({ insumo_id: keeper.id }).eq("id", ln.id); ln.insumo_id = keeper.id; }
      }
      const del = await sb.from("insumos").delete().eq("id", loser.id).eq("organizacao_id", ORG);
      if (del.error) P("    ERRO ao excluir " + loser.id + ": " + del.error.message);
    }
  }
}
P(`  linhas removidas: ${nDedup}`);

// ---------- (3) INSERIR NOVOS ----------
if (APPLY) ({ db, fichas } = await refetch());
const nomesDb = new Set(db.map((d) => norm(d.nome)));
const novos = soPlan.filter((p) => !planPego.has(p) && !nomesDb.has(norm(p.nome)));
P(`\n## (3) Novos a cadastrar: ${novos.length}`);
let nIns = 0;
for (const p of novos) {
  const codigo = soDigitos(p.codigo) && !codsDb.has(String(p.codigo)) ? String(p.codigo) : null;
  if (codigo) codsDb.add(codigo);
  P(`  + [${codigo ?? "—"}] ${p.nome} (${p.categoria}/${p.unidade}) R$ ${p.preco_unitario}`);
  nIns++;
  if (APPLY) {
    const linha = { organizacao_id: ORG, codigo, nome: p.nome, tipo: p.categoria, unidade_medida: p.unidade, preco_caixa: p.preco_caixa, rendimento: p.rendimento, preco_unitario: p.preco_unitario, ativo: true };
    let r = await sb.from("insumos").insert({ ...linha, preco_atualizado_em: new Date().toISOString() });
    if (r.error && RE_COL.test(r.error.message)) r = await sb.from("insumos").insert(linha);
    if (r.error) P("    ERRO: " + r.error.message);
  }
}

// ---------- (4) OBSOLETOS (sem par) ----------
if (APPLY) ({ db, fichas } = await refetch());
const usados2 = new Set(fichas.map((f) => f.insumo_id));
// recomputa "sem par": nomes do banco que não existem na planilha (por nome/token) e sem código casado
const planNomes = planilha.map((p) => p.nome);
const temParPlan = (nome) => planilha.some((p) => norm(p.nome) === norm(nome)) || planNomes.some((pn) => jac(nome, pn) >= SIM);
const obsoletos = db.filter((d) => !(soDigitos(d.codigo) && planByCod.has(String(d.codigo))) && !temParPlan(d.nome));
P(`\n## (4) Obsoletos (sem par na planilha): ${obsoletos.length}`);
let nDel = 0, nInat = 0, nSkip = 0;
for (const d of obsoletos) {
  if (String(d.codigo).startsWith("SYN-")) { P(`  = SKIP sintético [${d.codigo}] ${d.nome}`); nSkip++; continue; }
  if (usados2.has(d.id)) {
    P(`  ⊘ inativar [${d.codigo ?? "—"}] ${d.nome} (em ficha)`); nInat++;
    if (APPLY) await sb.from("insumos").update({ ativo: false }).eq("id", d.id).eq("organizacao_id", ORG);
  } else {
    P(`  ✗ excluir  [${d.codigo ?? "—"}] ${d.nome} (livre)`); nDel++;
    if (APPLY) { const del = await sb.from("insumos").delete().eq("id", d.id).eq("organizacao_id", ORG); if (del.error) P("    ERRO: " + del.error.message); }
  }
}
P(`  excluir: ${nDel} | inativar: ${nInat} | SYN preservados: ${nSkip}`);

// ---------- recalc ----------
if (APPLY) {
  const { data: prods } = await sb.from("produtos").select("id").eq("organizacao_id", ORG);
  let ok = 0; for (const pr of prods ?? []) { const { error } = await sb.rpc("fn_recalc_custo", { p_produto_id: pr.id }); if (!error) ok++; }
  P(`\nRecalc custo_cache: ${ok}/${(prods ?? []).length}`);
}

P(`\nRESUMO: renome=${nRen} dedup=${nDedup} novos=${nIns} excluir=${nDel} inativar=${nInat} SYN=${nSkip}`);
fs.writeFileSync(process.argv[3] || "reconcile.log", log.join("\n"));
