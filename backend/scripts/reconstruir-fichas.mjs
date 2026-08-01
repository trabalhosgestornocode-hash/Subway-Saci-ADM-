// ⚠️  OBSOLETO — NÃO USAR. Mantido apenas como referência histórica.
//
// Este script montava a ficha seguindo a REFERÊNCIA DE CÉLULA da fórmula de custo.
// A aba "Sanduíches 15 cm" da planilha tem essas referências DESLOCADAS a partir da
// linha 14, então ele atribuiu recheios trocados (o BMT recebeu "Carne Seca", o
// Vegetariano recebeu frango). O artefato que ele consumia (backups/reconstrucao.json)
// foi REMOVIDO de propósito para que este script não recrie os dados errados.
//
// USE NO LUGAR:  scripts/auditar-fichas.mjs  (monta a composição por RÓTULO)
// ---------------------------------------------------------------------------
//
// RECONSTRUÇÃO da base de insumos + fichas técnicas a partir da planilha oficial.
//
// Segurança: exige --unit-id explícito e --apply para gravar. Sem --apply é
// dry-run (não altera nada). Faz backup antes de aplicar. Preserva produtos,
// preços, vendas, usuários, organizações e unidades.
//
// Uso:
//   DRY-RUN:  node --env-file=.env scripts/reconstruir-fichas.mjs --unit-id=<UUID>
//   APLICAR:  node --env-file=.env scripts/reconstruir-fichas.mjs --unit-id=<UUID> --apply
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { supabase as sb } from "../src/config/supabase.js";

const ORIGEM = "Reconstrução a partir da nova ficha técnica da Crescer com Delivery";
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const UNIT = arg("unit-id");
const APPLY = process.argv.includes("--apply");
const DATA = arg("data") || path.join("backups", "reconstrucao.json");
const RE_COL = /does not exist|schema cache|could not find/i;
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const toks = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 1));
const jac = (a, b) => { const A = toks(a), B = toks(b); let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i || 1); };
const R = [];
const say = (s) => { R.push(s); console.log(s); };

// ---------- 0. Segurança / contexto ----------
if (!UNIT) { console.error("ERRO: informe --unit-id=<UUID> (nenhuma unidade padrão é assumida)."); process.exit(1); }
const { data: unidade, error: eu } = await sb.from("unidades").select("id, nome, organizacao_id").eq("id", UNIT).maybeSingle();
if (eu || !unidade) { console.error("ERRO: unidade não encontrada:", UNIT); process.exit(1); }
const ORG = unidade.organizacao_id;
say(`=== RECONSTRUÇÃO ${APPLY ? "[APPLY]" : "[DRY-RUN]"} ===`);
say(`Unidade: ${unidade.nome} (${UNIT}) · Organização: ${ORG}`);

const plan = JSON.parse(fs.readFileSync(DATA, "utf8"));
say(`Planilha: ${plan.insumos.length} insumos-base · ${plan.produtos.length} produtos com ficha`);

// ---------- 1. Estado atual ----------
const { data: dbProd } = await sb.from("produtos").select("id, nome, tipo, tamanho, vendavel").eq("organizacao_id", ORG);
const { count: nInsAntes } = await sb.from("insumos").select("id", { count: "exact", head: true }).eq("organizacao_id", ORG);
say(`Banco: ${nInsAntes} insumos, ${dbProd.length} produtos (preservados).`);

// ---------- 2. Mapeamento planilha -> produto do banco ----------
const planByNome = new Map(plan.produtos.map((p) => [`${p.aba}|${norm(p.nome_planilha)}`, p]));
const planByNomeSimples = new Map();
for (const p of plan.produtos) if (!planByNomeSimples.has(norm(p.nome_planilha))) planByNomeSimples.set(norm(p.nome_planilha), p);

// Mapas diretos p/ produtos comerciais genéricos (bebidas/cookies/chips/sobremesa)
const DIRETO_PRODUTO = {
  "Refrigerante Lata 350ml": "Coca-Cola Lata Original", "Refrigerante PET 600ml": "Coca-Cola Garrafa 600mL",
  "Água Mineral 500ml": "Água Mineral Sem Gás", "Suco 290ml": "Del Valle Néctar Uva Lata",
  "Cookie Chocolate": "COOKIE CHOCOLATE DOUBLE 120UN", "Cookie Macadâmia": "COOKIE Macadamia",
  "Cookie Tradicional": "COOKIE GOTAS 120UN", "Batata Rústica": "BATATA Rustica 14K",
  // adicionais com grafia divergente do fuzzy
  "Ad. Mussarela Ralada": "Dobro de Musarela", "Dobro Mussarela": "Dobro de Musarela",
  "Ad. Pepperoni": "Adicional de peperone", "Ad. Cream Cheese": "Dobro de CC",
  "Ad. Cheddar Cremoso": "Dobro de cheddar",
};
// Produtos que viram ficha de 1 insumo (sem produto correspondente na planilha)
const DIRETO_INSUMO = {
  "Doritos Queijo Nacho": "DORITOS", "Ruffles Original": "RUFFLES", "Mousse Coco e Chocolate": "MOUSSE COCO",
};

const insumoByNome = new Map();
for (const i of plan.insumos) { const k = norm(i.nome); if (!insumoByNome.has(k)) insumoByNome.set(k, i); }
const achaInsumo = (frag) => plan.insumos.find((i) => norm(i.nome).includes(norm(frag)));

function mapear(prod) {
  const nomeN = norm(prod.nome);
  // 1) mapa direto p/ produto da planilha
  if (DIRETO_PRODUTO[prod.nome]) { const p = planByNomeSimples.get(norm(DIRETO_PRODUTO[prod.nome])); if (p) return { tipo: "produto", fonte: p }; }
  // 2) mapa direto p/ 1 insumo
  if (DIRETO_INSUMO[prod.nome]) { const ins = achaInsumo(DIRETO_INSUMO[prod.nome]); if (ins) return { tipo: "insumo", insumo: ins }; }
  // 3) sanduíches/saladas por sufixo
  if (prod.tipo === "sanduiche") {
    const aba = prod.tamanho === "30cm" ? "Sanduíches 30 cm" : "Sanduíches 15 cm";
    const base = norm(prod.nome).replace(/ 15CM| 30CM/g, "").replace("STEAK", "STEACK");
    let melhor = null, bs = 0;
    for (const p of plan.produtos) { if (p.aba !== aba) continue; const s = jac(base, norm(p.nome_planilha).replace("STEACK", "STEAK") + "|" + norm(p.nome_planilha)); const s2 = jac(base, norm(p.nome_planilha)); const sc = Math.max(s2, jac(base.replace("STEACK", "STEAK"), norm(p.nome_planilha).replace("STEACK", "STEAK"))); if (sc > bs) { bs = sc; melhor = p; } }
    return bs >= 0.6 ? { tipo: "produto", fonte: melhor } : { tipo: "sem", motivo: "sanduíche sem correspondência na planilha" };
  }
  if (prod.tipo === "salada") {
    const base = norm(prod.nome).replace(/^SALADA /, "");
    let melhor = null, bs = 0;
    for (const p of plan.produtos) { if (p.aba !== "Saladas") continue; const sc = jac(base.replace("STEACK", "STEAK"), norm(p.nome_planilha).replace("STEACK", "STEAK")); if (sc > bs) { bs = sc; melhor = p; } }
    return bs >= 0.6 ? { tipo: "produto", fonte: melhor } : { tipo: "sem", motivo: "salada sem correspondência na planilha" };
  }
  // 4) adicionais por fuzzy (aba Recheios e Adicionais)
  if (prod.tipo === "adicional") {
    let melhor = null, bs = 0;
    for (const p of plan.produtos) { if (p.aba !== "Recheios e Adicionais") continue; const sc = jac(nomeN.replace(/^AD /, "").replace(/^DOBRO /, ""), norm(p.nome_planilha).replace(/^DOBRO /, "").replace(/^ADICIONAL /, "")); if (sc > bs) { bs = sc; melhor = p; } }
    return bs >= 0.5 ? { tipo: "produto", fonte: melhor } : { tipo: "sem", motivo: "adicional sem correspondência (revisar)" };
  }
  return { tipo: "sem", motivo: "sem regra de mapeamento" };
}

const mapeados = [];
for (const prod of dbProd) {
  if (prod.vendavel === false) { mapeados.push({ prod, r: { tipo: "sem", motivo: "submontagem (não comercial)" } }); continue; }
  mapeados.push({ prod, r: mapear(prod) });
}
const comFicha = mapeados.filter((m) => m.r.tipo === "produto" || m.r.tipo === "insumo");
const semFicha = mapeados.filter((m) => m.r.tipo === "sem");

// ---------- 3. Relatório de simulação ----------
say(`\n## Mapeamento (produtos preservados, fichas reconstruídas)`);
say(`  produtos com ficha reconstruída: ${comFicha.length}`);
say(`  produtos SEM correspondência (preservar, revisar): ${semFicha.length}`);
for (const m of comFicha) {
  const f = m.r.tipo === "produto" ? m.r.fonte : null;
  say(`   ✓ ${m.prod.nome}  ←  ${m.r.tipo === "produto" ? `${f.aba}:${f.nome_planilha} (${f.n_comp} comp, custo ${f.custo_planilha})` : `1× ${m.r.insumo.nome}`}`);
}
for (const m of semFicha) say(`   ⚠ ${m.prod.nome} — ${m.r.motivo}`);

// Produtos da planilha não usados (informativo)
const usados = new Set(comFicha.filter((m) => m.r.tipo === "produto").map((m) => `${m.r.fonte.aba}|${norm(m.r.fonte.nome_planilha)}`));
const planNaoUsados = plan.produtos.filter((p) => !usados.has(`${p.aba}|${norm(p.nome_planilha)}`));
say(`\n## Produtos da planilha sem produto comercial no banco: ${planNaoUsados.length}`);
for (const p of planNaoUsados) say(`   · ${p.aba}: ${p.nome_planilha} (custo ${p.custo_planilha})`);

say(`\nRESUMO SIMULAÇÃO: insumos antigos=${nInsAntes} → novos=${plan.insumos.length} | fichas a reconstruir=${comFicha.length} | produtos preservados=${dbProd.length} | sem ficha=${semFicha.length}`);

if (!APPLY) {
  fs.writeFileSync(path.join("backups", "relatorio-simulacao.txt"), R.join("\n"));
  say(`\n[DRY-RUN] Nada foi alterado. Relatório: backups/relatorio-simulacao.txt`);
  say(`Para aplicar: node --env-file=.env scripts/reconstruir-fichas.mjs --unit-id=${UNIT} --apply`);
  process.exit(0);
}

// ---------- 4. APLICAÇÃO ----------
say(`\n## APLICANDO (backup → limpar → inserir → reconstruir → recalcular)`);
// 4.1 backup
try { execFileSync("node", ["--env-file=.env", "scripts/reconstruir-backup.mjs", `--org=${ORG}`], { stdio: "inherit" }); }
catch (e) { console.error("ERRO no backup — abortando.", e.message); process.exit(1); }

// helper best-effort p/ coluna origem ausente
async function insertBE(tabela, linhas) {
  let r = await sb.from(tabela).insert(linhas).select("id");
  if (r.error && RE_COL.test(r.error.message)) {
    const semOrigem = linhas.map(({ origem, ...x }) => x);
    r = await sb.from(tabela).insert(semOrigem).select("id");
  }
  return r;
}

const prodIds = dbProd.map((p) => p.id);
// 4.2 limpar fichas e insumos antigos
if (prodIds.length) { const d = await sb.from("ficha_tecnica").delete().in("produto_id", prodIds); if (d.error) { console.error("ERRO ao limpar fichas:", d.error.message); process.exit(1); } }
const dIns = await sb.from("insumos").delete().eq("organizacao_id", ORG);
if (dIns.error) { console.error("ERRO ao limpar insumos:", dIns.error.message); process.exit(1); }
say(`  limpo: fichas + ${nInsAntes} insumos antigos (backup salvo).`);

// 4.3 inserir novos insumos
const idPorKey = new Map();
const soDigitos = (s) => /^\d+$/.test(String(s ?? ""));
const linhasIns = plan.insumos.map((i) => ({
  organizacao_id: ORG, codigo: soDigitos(i.codigo) ? i.codigo : null, nome: i.nome, tipo: i.categoria,
  unidade_medida: i.unidade, preco_caixa: i.preco_caixa, rendimento: i.rendimento,
  preco_unitario: i.custo_unitario ?? 0, forma_compra: i.composto ? "composto" : null,
  ativo: true, origem: ORIGEM, preco_atualizado_em: new Date().toISOString(),
}));
// insere em lote e recupera ids na ordem
let ins = await insertBE("insumos", linhasIns);
if (ins.error) { console.error("ERRO ao inserir insumos:", ins.error.message); process.exit(1); }
// recarrega p/ mapear key->id por nome (mais robusto que ordem)
const { data: insDb } = await sb.from("insumos").select("id, nome, unidade_medida, preco_unitario").eq("organizacao_id", ORG);
const insDbByNome = new Map(); for (const d of insDb) insDbByNome.set(norm(d.nome), d);
for (const i of plan.insumos) { const d = insDbByNome.get(norm(i.nome)); if (d) idPorKey.set(i.key, d); }
say(`  inseridos ${insDb.length} insumos novos (origem marcada).`);

// 4.4 reconstruir fichas
function linhasFicha(produtoId, fonte) {
  const comps = fonte.tipo === "produto" ? fonte.fonte.componentes
    : [{ insumo_nome: fonte.insumo.nome, quantidade: 1, unidade: fonte.insumo.unidade, insumo_key: fonte.insumo.key }];
  const linhas = [];
  let ordem = 0;
  for (const c of comps) {
    const insDbRow = insDbByNome.get(norm(c.insumo_nome));
    if (!insDbRow) continue;
    const uni = insDbRow.unidade_medida;
    let qtdBase = Number(c.quantidade);      // já na unidade-base do insumo
    let unidadeUso = uni, qtdInformada = qtdBase;
    if (uni === "kg" && qtdBase < 1) { unidadeUso = "g"; qtdInformada = Math.round(qtdBase * 100000) / 100; }
    if (uni === "l" && qtdBase < 1) { unidadeUso = "ml"; qtdInformada = Math.round(qtdBase * 100000) / 100; }
    linhas.push({ produto_id: produtoId, insumo_id: insDbRow.id, quantidade: qtdBase,
      unidade_uso: unidadeUso, quantidade_informada: qtdInformada, ordem: ordem++, ativo: true, origem: ORIGEM });
  }
  // dedupe por insumo (unique produto_id,insumo_id): soma quantidades
  const porInsumo = new Map();
  for (const l of linhas) {
    const ex = porInsumo.get(l.insumo_id);
    if (ex) { ex.quantidade += l.quantidade; ex.quantidade_informada += l.quantidade_informada; }
    else porInsumo.set(l.insumo_id, l);
  }
  return [...porInsumo.values()];
}
let nFichaLinhas = 0, nProdFicha = 0;
for (const m of comFicha) {
  const linhas = linhasFicha(m.prod.id, m.r.tipo === "produto" ? { tipo: "produto", fonte: m.r.fonte } : { tipo: "insumo", insumo: m.r.insumo });
  if (!linhas.length) continue;
  const r = await insertBE("ficha_tecnica", linhas);
  if (r.error) { say(`   ERRO ficha ${m.prod.nome}: ${r.error.message}`); continue; }
  nFichaLinhas += linhas.length; nProdFicha++;
}
say(`  fichas reconstruídas: ${nProdFicha} produtos, ${nFichaLinhas} linhas.`);

// 4.5 recalcular custo_cache
let okRe = 0; for (const p of dbProd) { const { error } = await sb.rpc("fn_recalc_custo", { p_produto_id: p.id }); if (!error) okRe++; }
say(`  custo_cache recalculado: ${okRe}/${dbProd.length}`);

// 4.6 validação (custo vs planilha)
const { data: prodPos } = await sb.from("produtos").select("id, nome, custo_cache").eq("organizacao_id", ORG);
const custoById = new Map(prodPos.map((p) => [p.id, p.custo_cache]));
let okV = 0, divV = 0;
for (const m of comFicha) {
  if (m.r.tipo !== "produto") { okV++; continue; }
  const esperado = m.r.fonte.custo_planilha;
  const real = Number(custoById.get(m.prod.id) ?? 0);
  if (esperado && Math.abs(real - esperado) <= Math.max(0.05, 0.02 * esperado)) okV++;
  else { divV++; say(`   !! custo divergente ${m.prod.nome}: banco ${real} vs planilha ${esperado}`); }
}
say(`  validação custo: ${okV} ok, ${divV} divergentes.`);

say(`\nRESUMO APLICAÇÃO: insumos ${nInsAntes}→${insDb.length} | fichas ${nProdFicha} produtos/${nFichaLinhas} linhas | preservados ${dbProd.length} | sem ficha ${semFicha.length} | custo ok ${okV}`);
fs.writeFileSync(path.join("backups", "relatorio-aplicacao.txt"), R.join("\n"));
say(`Relatório: backups/relatorio-aplicacao.txt · Rollback: restaure o backup mais recente (backups/insumos-*/restore.sql).`);
