/**
 * AUDITORIA CORRETIVA de Insumos e Fichas Técnicas contra a planilha oficial.
 *
 * Compara, componente a componente, o que está no banco com a representação
 * CANÔNICA da planilha (backups/canonico.json), gerada por rótulo — e não por
 * referência de célula, que é onde a planilha está quebrada.
 *
 * Modos:
 *   AUDITAR (padrão, não altera nada):
 *     node --env-file=.env scripts/auditar-fichas.mjs --unit-id=<UUID>
 *   CORRIGIR:
 *     node --env-file=.env scripts/auditar-fichas.mjs --unit-id=<UUID> --apply
 *   Extras:
 *     --incluir-inferidos   monta ficha de produto que existe no sistema mas não
 *                           tem linha na planilha, usando recheio de mesmo rótulo
 *                           + a base padrão do tipo (regra idêntica aos demais).
 *
 * Saídas: backups/relatorio-auditoria.md e backups/relatorio-auditoria.json
 */
import fs from "node:fs";
import path from "node:path";
import { supabase as sb } from "../src/config/supabase.js";
import { converterQuantidade } from "../src/modules/insumos/insumos.calc.js";

const ORIGEM = "Auditoria corretiva — ficha técnica oficial Crescer com Delivery";
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const UNIT = arg("unit-id");
const APPLY = process.argv.includes("--apply");
const INFERIDOS = process.argv.includes("--incluir-inferidos");
const STRICT = process.argv.includes("--strict");
const TOL_QTD = 1e-6;      // tolerância de quantidade (unidade-base)
const TOL_CUSTO = 0.01;    // R$ 0,01 de tolerância no custo total
const RE_COL = /does not exist|schema cache|could not find/i;

const N = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim()
  .replace(/STEACK/g, "STEAK");

if (!UNIT) { console.error("ERRO: informe --unit-id=<UUID>. Nenhuma unidade é assumida."); process.exit(1); }
const { data: unidade } = await sb.from("unidades").select("id, nome, organizacao_id").eq("id", UNIT).maybeSingle();
if (!unidade) { console.error("ERRO: unidade não encontrada:", UNIT); process.exit(1); }
const ORG = unidade.organizacao_id;

// Referência canônica versionada (gerada da planilha por rótulo). Fica em
// database/ para que a validação funcione em qualquer clone do repositório.
const CANON_PATH = arg("file") || path.join("..", "database", "ficha-tecnica-canonica.json");
const CANON = JSON.parse(fs.readFileSync(CANON_PATH, "utf8"));
// Normaliza as chaves de recheio com a MESMA função do JS (o Python não faz
// STEACK->STEAK), senão "Steack Cheddar" casaria com "Dobro de cheddar".
CANON.blocos.recheios = Object.fromEntries(Object.entries(CANON.blocos.recheios).map(([k, v]) => [N(k), v]));

// ---------------------------------------------------------------- estado do banco
const [{ data: dbIns }, { data: dbProd }] = await Promise.all([
  sb.from("insumos").select("id, codigo, nome, tipo, unidade_medida, preco_caixa, rendimento, preco_unitario, ativo").eq("organizacao_id", ORG),
  sb.from("produtos").select("id, nome, tipo, tamanho, vendavel, custo_cache, custo_manual").eq("organizacao_id", ORG),
]);
const prodIds = dbProd.map((p) => p.id);
const { data: dbFicha } = await sb.from("ficha_tecnica").select("id, produto_id, insumo_id, quantidade, unidade_uso, quantidade_informada, ativo").in("produto_id", prodIds);
const { data: dbPrecos } = await sb.from("produto_precos").select("produto_id, canal, tabela, preco").in("produto_id", prodIds);

const insById = new Map(dbIns.map((i) => [i.id, i]));
const insByNome = new Map(); for (const i of dbIns) if (!insByNome.has(N(i.nome))) insByNome.set(N(i.nome), i);
const fichaPorProd = new Map(); for (const f of dbFicha) { if (!fichaPorProd.has(f.produto_id)) fichaPorProd.set(f.produto_id, []); fichaPorProd.get(f.produto_id).push(f); }
const precoPorProd = new Map();
for (const p of dbPrecos) { const cur = precoPorProd.get(p.produto_id); const v = Number(p.preco); if (v > 0 && (cur === undefined || v < cur)) precoPorProd.set(p.produto_id, v); }

// ---------------------------------------------------------------- 1. AUDITORIA DE INSUMOS
const canonInsByNome = new Map(); for (const i of CANON.insumos) if (!canonInsByNome.has(N(i.nome))) canonInsByNome.set(N(i.nome), i);
const canonInsByCod = new Map(); for (const i of CANON.insumos) if (i.codigo && /^\d+$/.test(i.codigo)) canonInsByCod.set(String(i.codigo), i);

const auditIns = { corretos: [], divergentes: [], ausentes: [], extras: [], duplicados: [] };
const vistos = new Map();
for (const d of dbIns) {
  const k = N(d.nome);
  if (vistos.has(k)) auditIns.duplicados.push({ nome: d.nome, ids: [vistos.get(k).id, d.id] });
  else vistos.set(k, d);
  const c = (d.codigo && canonInsByCod.get(String(d.codigo))) || canonInsByNome.get(k);
  if (!c) { auditIns.extras.push({ id: d.id, codigo: d.codigo, nome: d.nome, custo: d.preco_unitario }); continue; }
  const difs = [];
  // null e 0 significam a mesma coisa aqui ("sem custo"/"sem valor") — comparar
  // literalmente geraria divergência eterna em linhas vazias da planilha.
  const nz = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v));
  const eq = (a, b, tol = 0.005) => Math.abs(nz(a) - nz(b)) < tol;
  if (!eq(d.preco_unitario, c.custo_unitario, 1e-4)) difs.push(`custo_unitario ${d.preco_unitario} != ${c.custo_unitario}`);
  if (!eq(d.preco_caixa, c.preco_caixa)) difs.push(`preco_caixa ${d.preco_caixa} != ${c.preco_caixa}`);
  if (!eq(d.rendimento, c.rendimento)) difs.push(`rendimento ${d.rendimento} != ${c.rendimento}`);
  if (d.unidade_medida !== c.unidade) difs.push(`unidade ${d.unidade_medida} != ${c.unidade}`);
  if (d.tipo !== c.categoria) difs.push(`categoria ${d.tipo} != ${c.categoria}`);
  if (difs.length) auditIns.divergentes.push({ id: d.id, nome: d.nome, difs, canon: c });
  else auditIns.corretos.push(d.nome);
}
for (const c of CANON.insumos) if (!insByNome.has(N(c.nome))) auditIns.ausentes.push({ nome: c.nome, codigo: c.codigo, custo: c.custo_unitario });

// ---------------------------------------------------------------- 2. MAPEAMENTO DE PRODUTOS
const DIRETO = {
  "Refrigerante Lata 350ml": ["Bebidas", "Coca-Cola Lata Original"], "Refrigerante PET 600ml": ["Bebidas", "Coca-Cola Garrafa 600mL"],
  "Água Mineral 500ml": ["Bebidas", "Água Mineral Sem Gás"], "Suco 290ml": ["Bebidas", "Del Valle Néctar Uva Lata"],
  "Cookie Chocolate": ["Cookies, Chips e Brownies", "COOKIE CHOCOLATE DOUBLE 120UN"],
  "Cookie Macadâmia": ["Cookies, Chips e Brownies", "COOKIE Macadamia"],
  "Cookie Tradicional": ["Cookies, Chips e Brownies", "COOKIE GOTAS 120UN"],
  "Batata Rústica": ["Cookies, Chips e Brownies", "BATATA Rustica 14K"],
  "Ad. Mussarela Ralada": ["Recheios e Adicionais", "Dobro de Musarela"], "Dobro Mussarela": ["Recheios e Adicionais", "Dobro de Musarela"],
  "Ad. Pepperoni": ["Recheios e Adicionais", "Adicional de peperone"], "Ad. Cream Cheese": ["Recheios e Adicionais", "Dobro de CC"],
  "Ad. Cheddar Cremoso": ["Recheios e Adicionais", "Dobro de cheddar"], "Ad. Cheddar Fatiado": ["Recheios e Adicionais", "Dobro de queijo"],
  "Ad. Salame": ["Recheios e Adicionais", "Adicional de salame"], "Ad. Bacon": ["Recheios e Adicionais", "Dobro de Bacon"],
  "Ad. Presunto": ["Recheios e Adicionais", "Dobro recheio Presunto"],
  "Dobro Recheio BMT": ["Recheios e Adicionais", "Dobro recheio BMT"],
  "Dobro Recheio Carne Seca": ["Recheios e Adicionais", "Dobro de Recheio Carne Seca"],
  "Dobro Recheio Churrasco": ["Recheios e Adicionais", "Dobro recheio Churrasco"],
  "Dobro Recheio Empanado": ["Recheios e Adicionais", "Dobro recheio Empanado"],
  "Dobro Recheio Frango": ["Recheios e Adicionais", "Dobro recheio Frango"],
  "Dobro Recheio Frango Defumado": ["Recheios e Adicionais", "Dobro recheio Frango Defumado"],
  "Dobro Recheio Steack Cheddar": ["Recheios e Adicionais", "Dobro recheio Steack Cheddar"],
  "Dobro Teriack": ["Recheios e Adicionais", "Dobro de teriack"],
};
const DIRETO_INSUMO = { "Doritos Queijo Nacho": "DORITOS QUEIJO NACHO 58UNX32G", "Ruffles Original": "BATATA RUFFLES ORIG 33GX50UN" };
const canonByKey = new Map(); for (const p of CANON.produtos) canonByKey.set(`${p.aba}|${N(p.nome_planilha)}`, p);

/** Sabor canônico do recheio a partir do nome comercial (para inferência). */
function saborDe(nome) {
  let n = N(nome).replace(/^SALADA /, "").replace(/ (15CM|30CM)$/, "").replace(/^AD /, "").replace(/^DOBRO /, "");
  if (n === "VEGETARIANO") return "__SEM__";
  if (/FRANGO STEAK/.test(n)) return "FRANGO";
  const chaves = Object.keys(CANON.blocos.recheios);
  if (chaves.includes(n)) return n;
  const cands = chaves.filter((s) => s && (n.includes(s) || s.includes(n)));
  return cands.length ? cands.sort((a, b) => b.length - a.length)[0] : null;
}

function mapear(prod) {
  if (prod.vendavel === false) return { tipo: "ignorado", motivo: "submontagem (não comercial)" };
  if (DIRETO[prod.nome]) { const [aba, nm] = DIRETO[prod.nome]; const c = canonByKey.get(`${aba}|${N(nm)}`); if (c) return { tipo: "canon", canon: c, via: "mapa-direto" }; }
  if (DIRETO_INSUMO[prod.nome]) {
    const ins = CANON.insumos.find((i) => N(i.nome) === N(DIRETO_INSUMO[prod.nome]));
    if (ins) return { tipo: "sintetico", componentes: [{ insumo_nome: ins.nome, quantidade: 1, unidade: ins.unidade, custo_unitario: ins.custo_unitario, custo_aplicado: ins.custo_unitario }], via: "insumo-direto" };
  }
  if (prod.tipo === "sanduiche") {
    const aba = prod.tamanho === "30cm" ? "Sanduíches 30 cm" : "Sanduíches 15 cm";
    const nome = N(prod.nome).replace(/ (15CM|30CM)$/, "");
    for (const [k, c] of canonByKey) if (k.startsWith(`${aba}|`) && N(k.split("|")[1]) === nome) return { tipo: "canon", canon: c, via: "nome+tamanho" };
    return inferir(prod, prod.tamanho === "30cm" ? "30cm" : "15cm", prod.tamanho === "30cm" ? 2 : 1);
  }
  if (prod.tipo === "salada") {
    const nome = N(prod.nome).replace(/^SALADA /, "");
    for (const [k, c] of canonByKey) if (k.startsWith("Saladas|") && N(k.split("|")[1]) === nome) return { tipo: "canon", canon: c, via: "nome+tamanho" };
    return inferir(prod, "salada", 2);
  }
  return { tipo: "sem", motivo: "sem regra de mapeamento" };
}

/** Monta ficha para produto sem linha na planilha, usando a MESMA regra dos demais. */
function inferir(prod, baseKey, mult) {
  const sabor = saborDe(prod.nome);
  if (!sabor) return { tipo: "sem", motivo: `sem recheio de rótulo correspondente na planilha` };
  const base = CANON.blocos.bases[baseKey] ?? [];
  const comps = base.map((c) => ({ ...c }));
  if (sabor !== "__SEM__") {
    const rec = CANON.blocos.recheios[sabor];
    if (!rec) return { tipo: "sem", motivo: `recheio "${sabor}" não encontrado` };
    for (const c of rec.componentes) comps.push({ ...c, quantidade: c.quantidade * mult, custo_aplicado: c.custo_aplicado * mult });
  }
  const agreg = new Map();
  for (const c of comps) {
    const k = N(c.insumo_nome); const ex = agreg.get(k);
    if (ex) { ex.quantidade += c.quantidade; ex.custo_aplicado += c.custo_aplicado; } else agreg.set(k, { ...c });
  }
  return { tipo: "inferido", componentes: [...agreg.values()], via: `inferido: recheio "${sabor}" + base ${baseKey}` };
}

// ---------------------------------------------------------------- 3. AUDITORIA DAS FICHAS
const difs = [];              // linhas da tabela de diferenças
const auditProd = { corretos: [], divergentes: [], semFicha: [], inferidos: [], naoMapeados: [], ignorados: [] };
const planoCorrecao = [];     // {produto, componentes canônicos}

for (const prod of dbProd) {
  const m = mapear(prod);
  if (m.tipo === "ignorado") { auditProd.ignorados.push({ nome: prod.nome, motivo: m.motivo }); continue; }
  if (m.tipo === "sem") { auditProd.naoMapeados.push({ nome: prod.nome, motivo: m.motivo }); continue; }

  const canonComps = m.tipo === "canon" ? m.canon.componentes : m.componentes;
  const atual = fichaPorProd.get(prod.id) ?? [];

  // indexa por insumo (nome normalizado)
  const atualPorNome = new Map();
  for (const f of atual) { const i = insById.get(f.insumo_id); if (i) atualPorNome.set(N(i.nome), { f, i }); }
  const canonPorNome = new Map(canonComps.map((c) => [N(c.insumo_nome), c]));

  const problemas = [];
  for (const [k, { f, i }] of atualPorNome) {
    if (!canonPorNome.has(k)) {
      problemas.push({ tipo: "extra", insumo: i.nome });
      difs.push({ produto: prod.nome, componente: i.nome, sistema: `${f.quantidade_informada ?? f.quantidade} ${f.unidade_uso ?? i.unidade_medida}`, planilha: "ausente", acao: "Remover" });
    }
  }
  for (const [k, c] of canonPorNome) {
    const at = atualPorNome.get(k);
    if (!at) {
      problemas.push({ tipo: "ausente", insumo: c.insumo_nome });
      difs.push({ produto: prod.nome, componente: c.insumo_nome, sistema: "ausente", planilha: `${c.quantidade} ${c.unidade}`, acao: "Adicionar" });
      continue;
    }
    const qAtual = Number(at.f.quantidade);
    if (Math.abs(qAtual - Number(c.quantidade)) > Math.max(TOL_QTD, Math.abs(c.quantidade) * 1e-6)) {
      problemas.push({ tipo: "quantidade", insumo: c.insumo_nome, de: qAtual, para: c.quantidade });
      difs.push({ produto: prod.nome, componente: c.insumo_nome, sistema: `${qAtual} (base)`, planilha: `${c.quantidade} (base)`, acao: "Ajustar quantidade" });
    }
    if (at.i.unidade_medida !== c.unidade) {
      problemas.push({ tipo: "unidade", insumo: c.insumo_nome, de: at.i.unidade_medida, para: c.unidade });
      difs.push({ produto: prod.nome, componente: c.insumo_nome, sistema: at.i.unidade_medida, planilha: c.unidade, acao: "Ajustar unidade" });
    }
  }

  const custoCanon = canonComps.reduce((s, c) => s + Number(c.custo_aplicado || 0), 0);
  const registro = { nome: prod.nome, id: prod.id, via: m.via, tipo_map: m.tipo, custo_atual: Number(prod.custo_cache ?? 0), custo_canonico: +custoCanon.toFixed(6), n_comp_atual: atual.length, n_comp_canonico: canonComps.length, problemas };

  if (!atual.length) { auditProd.semFicha.push(registro); planoCorrecao.push({ prod, comps: canonComps, motivo: "ficha vazia", inferido: m.tipo === "inferido" }); }
  else if (problemas.length) { auditProd.divergentes.push(registro); planoCorrecao.push({ prod, comps: canonComps, motivo: `${problemas.length} problema(s)`, inferido: m.tipo === "inferido" }); }
  else auditProd.corretos.push(registro);

  if (m.tipo === "inferido") auditProd.inferidos.push({ nome: prod.nome, via: m.via, custo_canonico: +custoCanon.toFixed(4) });
}

// ---------------------------------------------------------------- 4. RELATÓRIO
const cmv = (c, p) => (p > 0 ? (c / p) * 100 : null);
const fmt = (n) => (n == null ? "—" : Number(n).toFixed(4));
const R = [];
R.push(`# Relatório de auditoria — Insumos e Fichas Técnicas`);
R.push(`\n- Planilha: \`planilhasveryimportants/Ficha_Tecnica_-_Crescer_com_Delivery_.xlsx\``);
R.push(`- Unidade auditada: **${unidade.nome}** (\`${UNIT}\`) · Organização \`${ORG}\``);
R.push(`- Modo: **${APPLY ? "APLICAÇÃO" : "AUDITORIA (sem alterar dados)"}**${INFERIDOS ? " · inferidos incluídos" : ""}`);
R.push(`\n## Resumo numérico`);
R.push(`| Métrica | Valor |`); R.push(`|---|---|`);
R.push(`| Insumos na planilha | ${CANON.insumos.length} |`);
R.push(`| Insumos no sistema | ${dbIns.length} |`);
R.push(`| Insumos corretos | ${auditIns.corretos.length} |`);
R.push(`| Insumos divergentes | ${auditIns.divergentes.length} |`);
R.push(`| Insumos ausentes no sistema | ${auditIns.ausentes.length} |`);
R.push(`| Insumos extras (não estão na planilha) | ${auditIns.extras.length} |`);
R.push(`| Insumos duplicados | ${auditIns.duplicados.length} |`);
R.push(`| Produtos no sistema | ${dbProd.length} |`);
R.push(`| Fichas corretas | ${auditProd.corretos.length} |`);
R.push(`| Fichas divergentes | ${auditProd.divergentes.length} |`);
R.push(`| Produtos sem ficha | ${auditProd.semFicha.length} |`);
R.push(`| Produtos por inferência (rótulo) | ${auditProd.inferidos.length} |`);
R.push(`| Produtos não mapeados | ${auditProd.naoMapeados.length} |`);
R.push(`| Componentes a remover | ${difs.filter((d) => d.acao === "Remover").length} |`);
R.push(`| Componentes a adicionar | ${difs.filter((d) => d.acao === "Adicionar").length} |`);
R.push(`| Componentes a ajustar | ${difs.filter((d) => d.acao.startsWith("Ajustar")).length} |`);

R.push(`\n## Tabela de diferenças (ficha técnica)`);
R.push(`| Produto | Componente | Sistema | Planilha | Ação |`); R.push(`|---|---|---|---|---|`);
for (const d of difs) R.push(`| ${d.produto} | ${d.componente} | ${d.sistema} | ${d.planilha} | ${d.acao} |`);

R.push(`\n## Custo e CMV — antes x depois (produtos divergentes)`);
R.push(`| Produto | Custo atual | Custo canônico | Preço | CMV atual | CMV canônico |`); R.push(`|---|---|---|---|---|---|`);
for (const p of [...auditProd.divergentes, ...auditProd.semFicha]) {
  const preco = precoPorProd.get(p.id) ?? null;
  R.push(`| ${p.nome} | ${fmt(p.custo_atual)} | ${fmt(p.custo_canonico)} | ${preco ?? "—"} | ${preco ? fmt(cmv(p.custo_atual, preco)) + "%" : "—"} | ${preco ? fmt(cmv(p.custo_canonico, preco)) + "%" : "—"} |`);
}

if (auditIns.divergentes.length) {
  R.push(`\n## Insumos divergentes`);
  for (const d of auditIns.divergentes) R.push(`- **${d.nome}**: ${d.difs.join(" · ")}`);
}
if (auditIns.extras.length) { R.push(`\n## Insumos no sistema que não estão na planilha`); for (const e of auditIns.extras) R.push(`- [${e.codigo ?? "—"}] ${e.nome} (custo ${e.custo})`); }
if (auditIns.ausentes.length) { R.push(`\n## Insumos da planilha ausentes no sistema`); for (const a of auditIns.ausentes) R.push(`- [${a.codigo ?? "—"}] ${a.nome} (custo ${a.custo})`); }
if (auditIns.duplicados.length) { R.push(`\n## Insumos duplicados`); for (const d of auditIns.duplicados) R.push(`- ${d.nome} (${d.ids.join(", ")})`); }
if (auditProd.inferidos.length) {
  R.push(`\n## Produtos montados por INFERÊNCIA (não têm linha própria na planilha)`);
  R.push(`> Regra idêntica à dos demais: recheio de mesmo rótulo + base do tipo. ${INFERIDOS ? "**Serão aplicados.**" : "**NÃO aplicados** (use --incluir-inferidos)."}`);
  for (const i of auditProd.inferidos) R.push(`- ${i.nome} — ${i.via} — custo ${i.custo_canonico}`);
}
if (auditProd.naoMapeados.length) { R.push(`\n## Produtos sem correspondência na planilha (preservados, revisar)`); for (const p of auditProd.naoMapeados) R.push(`- ${p.nome} — ${p.motivo}`); }

fs.mkdirSync("backups", { recursive: true });
fs.writeFileSync(path.join("backups", "relatorio-auditoria.md"), R.join("\n"));
fs.writeFileSync(path.join("backups", "relatorio-auditoria.json"), JSON.stringify({ unidade: { id: UNIT, nome: unidade.nome, organizacao_id: ORG }, insumos: auditIns, produtos: auditProd, diferencas: difs }, null, 1));

console.log(`=== AUDITORIA ${APPLY ? "[APPLY]" : "[SOMENTE LEITURA]"} — ${unidade.nome} ===`);
console.log(`Insumos: ${dbIns.length} no sistema / ${CANON.insumos.length} na planilha | corretos=${auditIns.corretos.length} divergentes=${auditIns.divergentes.length} ausentes=${auditIns.ausentes.length} extras=${auditIns.extras.length} duplicados=${auditIns.duplicados.length}`);
console.log(`Fichas: corretas=${auditProd.corretos.length} divergentes=${auditProd.divergentes.length} semFicha=${auditProd.semFicha.length} inferidos=${auditProd.inferidos.length} naoMapeados=${auditProd.naoMapeados.length}`);
console.log(`Componentes: remover=${difs.filter((d) => d.acao === "Remover").length} adicionar=${difs.filter((d) => d.acao === "Adicionar").length} ajustar=${difs.filter((d) => d.acao.startsWith("Ajustar")).length}`);
console.log(`Relatórios: backups/relatorio-auditoria.md e .json`);

if (!APPLY) {
  console.log(`\n[SOMENTE LEITURA] Nada foi alterado.`);
  // --strict: falha (exit 1) se houver QUALQUER divergência. É o modo usado pelo
  // comando permanente `npm run validate:technical-sheets` em CI/rotina.
  if (STRICT) {
    const falhas = [];
    if (difs.length) falhas.push(`${difs.length} divergência(s) de componente`);
    if (auditProd.divergentes.length) falhas.push(`${auditProd.divergentes.length} ficha(s) divergente(s)`);
    if (auditProd.semFicha.length) falhas.push(`${auditProd.semFicha.length} produto(s) sem ficha`);
    if (auditIns.ausentes.length) falhas.push(`${auditIns.ausentes.length} insumo(s) ausente(s)`);
    if (auditIns.duplicados.length) falhas.push(`${auditIns.duplicados.length} insumo(s) duplicado(s)`);
    const insReais = auditIns.divergentes.filter((d) => !d.difs.every((s) => /custo_unitario 0 != null/.test(s)));
    if (insReais.length) falhas.push(`${insReais.length} insumo(s) divergente(s)`);
    if (falhas.length) { console.error(`\n✗ VALIDAÇÃO FALHOU: ${falhas.join(" · ")}`); process.exit(1); }
    console.log(`\n✓ VALIDAÇÃO OK — a base corresponde à ficha técnica oficial.`);
    process.exit(0);
  }
  console.log(`Para corrigir: node --env-file=.env scripts/auditar-fichas.mjs --unit-id=${UNIT} --apply${INFERIDOS ? " --incluir-inferidos" : ""}`);
  process.exit(0);
}

// ---------------------------------------------------------------- 5. CORREÇÃO
console.log(`\n## CORRIGINDO ${planoCorrecao.length} ficha(s)…`);
// backup antes de qualquer escrita
const { execFileSync } = await import("node:child_process");
try { execFileSync("node", ["--env-file=.env", "scripts/reconstruir-backup.mjs", `--org=${ORG}`], { stdio: "inherit" }); }
catch (e) { console.error("ERRO no backup — abortando.", e.message); process.exit(1); }

// 5.1 corrige os INSUMOS divergentes (preço da caixa / rendimento / custo / unidade / categoria)
let nIns = 0;
for (const d of auditIns.divergentes) {
  const c = d.canon;
  const patch = {
    preco_caixa: c.preco_caixa, rendimento: c.rendimento,
    preco_unitario: c.custo_unitario ?? 0, unidade_medida: c.unidade, tipo: c.categoria,
  };
  const { error } = await sb.from("insumos").update(patch).eq("id", d.id).eq("organizacao_id", ORG);
  if (error) console.log(`   ERRO insumo ${d.nome}: ${error.message}`);
  else nIns++;
}
console.log(`  insumos corrigidos: ${nIns}/${auditIns.divergentes.length}`);

let nProd = 0, nAdd = 0, nDel = 0, pulados = 0;
for (const item of planoCorrecao) {
  if (item.inferido && !INFERIDOS) { pulados++; continue; }
  const atual = fichaPorProd.get(item.prod.id) ?? [];
  // substitui a composição ativa inteira (correção controlada, não incremento)
  if (atual.length) {
    const { error } = await sb.from("ficha_tecnica").delete().eq("produto_id", item.prod.id);
    if (error) { console.log(`   ERRO ao limpar ${item.prod.nome}: ${error.message}`); continue; }
    nDel += atual.length;
  }
  const linhas = [];
  let ordem = 0;
  for (const c of item.comps) {
    const ins = insByNome.get(N(c.insumo_nome));
    if (!ins) { console.log(`   ! insumo não encontrado no banco: ${c.insumo_nome} (produto ${item.prod.nome})`); continue; }
    const uni = ins.unidade_medida;
    let qBase = Number(c.quantidade), uUso = uni, qInf = qBase;
    if (uni === "kg" && qBase < 1) { uUso = "g"; qInf = +(converterQuantidade(qBase, "kg", "g")).toFixed(3); }
    else if (uni === "l" && qBase < 1) { uUso = "ml"; qInf = +(converterQuantidade(qBase, "l", "ml")).toFixed(3); }
    linhas.push({ produto_id: item.prod.id, insumo_id: ins.id, quantidade: qBase, unidade_uso: uUso, quantidade_informada: qInf, ordem: ordem++, ativo: true, origem: ORIGEM });
  }
  if (!linhas.length) continue;
  let r = await sb.from("ficha_tecnica").insert(linhas);
  if (r.error && RE_COL.test(r.error.message)) r = await sb.from("ficha_tecnica").insert(linhas.map(({ origem, ...x }) => x));
  if (r.error) { console.log(`   ERRO ${item.prod.nome}: ${r.error.message}`); continue; }
  nAdd += linhas.length; nProd++;
}
console.log(`  fichas substituídas: ${nProd} | linhas removidas: ${nDel} | linhas inseridas: ${nAdd}${pulados ? ` | inferidos pulados: ${pulados}` : ""}`);

// 5.3 limpa custo_manual OBSOLETO: enquanto ele existe, fn_custo_produto o usa e
//     IGNORA a ficha — mascarando o custo real. Só limpa de quem tem ficha (quem
//     não tem ficha perderia a única fonte de custo).
const { data: fichaPos } = await sb.from("ficha_tecnica").select("produto_id").in("produto_id", prodIds);
const comFichaPos = new Set((fichaPos ?? []).map((f) => f.produto_id));
const paraLimpar = dbProd.filter((p) => p.custo_manual != null && comFichaPos.has(p.id));
if (paraLimpar.length) {
  const { error } = await sb.from("produtos").update({ custo_manual: null }).in("id", paraLimpar.map((p) => p.id)).eq("organizacao_id", ORG);
  console.log(error ? `   ERRO ao limpar custo_manual: ${error.message}`
    : `  custo_manual obsoleto removido de ${paraLimpar.length} produto(s) — custo passa a vir da ficha`);
}
const semFichaComManual = dbProd.filter((p) => p.custo_manual != null && !comFichaPos.has(p.id));
if (semFichaComManual.length) console.log(`  custo_manual PRESERVADO em ${semFichaComManual.length} produto(s) sem ficha: ${semFichaComManual.map((p) => p.nome).join(", ")}`);

// recalcula custo_cache
let okRe = 0; for (const p of dbProd) { const { error } = await sb.rpc("fn_recalc_custo", { p_produto_id: p.id }); if (!error) okRe++; }
console.log(`  custo_cache recalculado: ${okRe}/${dbProd.length}`);

// validação pós-correção
const { data: pos } = await sb.from("produtos").select("id, nome, custo_cache").eq("organizacao_id", ORG);
const custoPos = new Map(pos.map((p) => [p.id, Number(p.custo_cache ?? 0)]));
let ok = 0, div = 0;
for (const item of planoCorrecao) {
  if (item.inferido && !INFERIDOS) continue;
  const esperado = item.comps.reduce((s, c) => s + Number(c.custo_aplicado || 0), 0);
  const real = custoPos.get(item.prod.id) ?? 0;
  if (Math.abs(real - esperado) <= TOL_CUSTO) ok++;
  else { div++; console.log(`   !! ${item.prod.nome}: banco ${real} vs canônico ${esperado.toFixed(4)}`); }
}
console.log(`  validação de custo: ${ok} ok, ${div} divergentes`);
console.log(`\nRESUMO: fichas corrigidas=${nProd} componentes(+${nAdd}/-${nDel}) recalculados=${okRe} validados=${ok}`);
