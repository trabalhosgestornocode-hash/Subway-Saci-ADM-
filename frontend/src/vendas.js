// Aba VENDAS — consolida os dados vendidos (SWFast/PDV, iFood, importação manual).
// Não registra venda nem faz fechamento: recebe, processa, organiza e exibe.
// Reaproveita as fichas técnicas (fn_custo_produto/custo_cache) para o CMV teórico.
import { el, escapeHtml, toast, fmtMoeda } from "./utils.js";
import {
  vendasVisaoGeral, vendasFaturamento, vendasProdutos, vendasImportacoes, vendasDivergencias,
  vendasPreview, vendasImportar, vendasVincular, listarProdutosSistema, vendasExcluirImportacao,
  vendasVincularLote, vendasComponentesCombo, vendasArquivoOriginal, vendasResolverDivergencia,
} from "./api.js";

const SECOES = [
  { id: "visao",       icon: "📊", label: "Visão Geral" },
  { id: "faturamento", icon: "💰", label: "Faturamento" },
  { id: "produtos",    icon: "🧾", label: "Produtos Vendidos" },
  { id: "importacoes", icon: "⬆️", label: "Importações" },
  { id: "divergencias",icon: "⚠️", label: "Divergências" },
];
const PERIODOS = [
  ["tudo", "Tudo"], ["hoje", "Hoje"], ["ontem", "Ontem"],
  ["7d", "Últimos 7 dias"], ["mes", "Este mês"], ["custom", "Personalizado"],
];
const CANAIS = [["todos", "Todos"], ["balcao", "Balcão"], ["ifood", "iFood"]];
const ORIGENS = [["todos", "Todas"], ["manual", "Importação manual"], ["swfast", "SWFast"], ["ifood", "iFood"]];
const CANAL_LABEL = { balcao: "🏪 Balcão", ifood: "📱 iFood" };

const vs = {
  secao: "visao",
  filtros: { periodo: "tudo", de: "", ate: "", canal: "todos", origem: "todos" },
  produtos: [],
  contadores: {}, // { produtos, importacoes, divergencias } — badge só quando disponível
};

// ---------- helpers ----------
const plural = (n, um, varios) => `${Number(n).toLocaleString("pt-BR")} ${Number(n) === 1 ? um : varios}`;
const fmtPctBr = (v) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
const vazio = (emoji, titulo, msg, extra = "") =>
  `<div class="estado"><span class="emoji">${emoji}</span><h3>${escapeHtml(titulo)}</h3><p>${escapeHtml(msg)}</p>${extra}</div>`;
const vazioMini = (msg) => `<div class="vd-painel-vazio">${escapeHtml(msg)}</div>`;
const nivelPill = (n) => ({ critico: "bad", atencao: "warn", info: "info" }[n] || "muted");
const tipoLabel = { produto: "Produto", combo: "Combo", etapa: "Etapa", taxa_desconto: "Taxa/Desconto" };

const skeletonLinhas = (n = 4) => `<div class="vd-skels">${Array.from({ length: n }).map(() => '<div class="vd-skel"></div>').join("")}</div>`;
const skeletonVisao = () => `
  <div class="vd-skel vd-skel-linha"></div>
  <div class="vd-cards">${Array.from({ length: 6 }).map(() => '<div class="vd-skel vd-skel-card"></div>').join("")}</div>
  <div class="vd-cards-sub">${Array.from({ length: 6 }).map(() => '<div class="vd-skel vd-skel-scard"></div>').join("")}</div>
  <div class="vd-paineis">${Array.from({ length: 4 }).map(() => '<div class="vd-skel vd-skel-painel"></div>').join("")}</div>`;

function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function datasDoPeriodo(p) {
  const hoje = new Date();
  if (p === "hoje") return [isoLocal(hoje), isoLocal(hoje)];
  if (p === "ontem") { const d = new Date(hoje); d.setDate(d.getDate() - 1); return [isoLocal(d), isoLocal(d)]; }
  if (p === "7d") { const d = new Date(hoje); d.setDate(d.getDate() - 6); return [isoLocal(d), isoLocal(hoje)]; }
  if (p === "mes") return [isoLocal(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), isoLocal(hoje)];
  return ["", ""]; // tudo / custom (custom mantém o que o usuário digitar)
}
const paramsFiltros = () => ({ de: vs.filtros.de, ate: vs.filtros.ate, canal: vs.filtros.canal, origem: vs.filtros.origem });
function qtdFiltrosAtivos() {
  let n = 0;
  if (vs.filtros.periodo !== "tudo" && (vs.filtros.de || vs.filtros.ate)) n++;
  if (vs.filtros.canal !== "todos") n++;
  if (vs.filtros.origem !== "todos") n++;
  return n;
}

export function renderVendas() {
  const view = el("#view");
  if (!view) return;
  const nAtivos = qtdFiltrosAtivos();
  view.innerHTML = `
    <div class="vd-head">
      <div class="vd-head-txt">
        <h2>Central de Vendas</h2>
        <p>Consolidação dos relatórios do SW, iFood e importações manuais — faturamento, mix de produtos e CMV teórico.</p>
      </div>
      <button class="btn btn-primary vd-import-btn" id="vd-import">⬆️ Importar relatórios do SW</button>
    </div>
    <nav class="vd-nav" aria-label="Seções de vendas">
      ${SECOES.map((s) => {
        const c = vs.contadores[s.id];
        return `<button class="vd-tab ${s.id === vs.secao ? "ativo" : ""}" data-sec="${s.id}">
          <span class="vd-tab-ico">${s.icon}</span><span class="vd-tab-lbl">${s.label}</span>${c != null ? `<span class="vd-tab-badge">${Number(c).toLocaleString("pt-BR")}</span>` : ""}
        </button>`;
      }).join("")}
    </nav>
    <div class="vd-filtros">
      <div class="vd-f-bloco">
        <span class="vd-f-lbl">📅 Período</span>
        <div class="vd-chips">
          ${PERIODOS.map(([v, l]) => `<button class="vd-chip ${v === vs.filtros.periodo ? "ativo" : ""}" data-per="${v}">${l}</button>`).join("")}
        </div>
        <div class="vd-f-datas" ${vs.filtros.periodo === "custom" ? "" : "hidden"}>
          <input type="date" id="vd-de" value="${vs.filtros.de}" aria-label="Data inicial">
          <span class="vd-ate">até</span>
          <input type="date" id="vd-ate" value="${vs.filtros.ate}" aria-label="Data final">
        </div>
      </div>
      <label class="vd-f-campo"><span class="vd-f-lbl">Canal</span>
        <select id="vd-canal">${CANAIS.map(([v, l]) => `<option value="${v}" ${v === vs.filtros.canal ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="vd-f-campo"><span class="vd-f-lbl">Origem</span>
        <select id="vd-origem">${ORIGENS.map(([v, l]) => `<option value="${v}" ${v === vs.filtros.origem ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <div class="vd-f-acoes">
        ${nAtivos ? `<span class="vd-f-ativos">${plural(nAtivos, "filtro ativo", "filtros ativos")}</span>` : ""}
        <button class="btn btn-ghost btn-sm" id="vd-limpar" ${nAtivos ? "" : "disabled"}>✕ Limpar</button>
      </div>
    </div>
    <div id="vd-conteudo" class="vd-conteudo"></div>`;

  view.querySelectorAll(".vd-tab").forEach((b) => b.addEventListener("click", () => { vs.secao = b.dataset.sec; renderVendas(); }));
  el("#vd-import").addEventListener("click", abrirImportModal);
  view.querySelectorAll(".vd-chip").forEach((b) => b.addEventListener("click", () => {
    const p = b.dataset.per;
    vs.filtros.periodo = p;
    if (p !== "custom") { const [de, ate] = datasDoPeriodo(p); vs.filtros.de = de; vs.filtros.ate = ate; }
    renderVendas();
  }));
  const updDatas = () => { vs.filtros.de = el("#vd-de").value; vs.filtros.ate = el("#vd-ate").value; carregarSecao(); };
  el("#vd-de").addEventListener("change", updDatas);
  el("#vd-ate").addEventListener("change", updDatas);
  el("#vd-canal").addEventListener("change", (e) => { vs.filtros.canal = e.target.value; renderVendas(); });
  el("#vd-origem").addEventListener("change", (e) => { vs.filtros.origem = e.target.value; renderVendas(); });
  el("#vd-limpar").addEventListener("click", () => { vs.filtros = { periodo: "tudo", de: "", ate: "", canal: "todos", origem: "todos" }; renderVendas(); });

  carregarSecao();
}

function setBadge(secao, valor) {
  vs.contadores[secao] = valor;
  const tab = el(`.vd-tab[data-sec="${secao}"]`);
  if (!tab) return;
  let b = tab.querySelector(".vd-tab-badge");
  if (valor == null) { b?.remove(); return; }
  if (!b) { b = document.createElement("span"); b.className = "vd-tab-badge"; tab.appendChild(b); }
  b.textContent = Number(valor).toLocaleString("pt-BR");
}

function carregarSecao() {
  const box = el("#vd-conteudo");
  if (!box) return;
  box.innerHTML = vs.secao === "visao" ? skeletonVisao() : skeletonLinhas(5);
  const fn = { visao: secVisao, faturamento: secFaturamento, produtos: secProdutos, importacoes: secImportacoes, divergencias: secDivergencias }[vs.secao];
  fn(box).catch((e) => {
    box.innerHTML = vazio("⚠️", "Erro ao carregar", e.message, `<button class="btn btn-ghost btn-sm" id="vd-retry">Tentar novamente</button>`);
    el("#vd-retry")?.addEventListener("click", carregarSecao);
  });
}

// navegação a partir de cards/pendências clicáveis (data-go / data-vinc)
function bindAtalhos(box) {
  box.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.vinc) pf.vinculo = b.dataset.vinc;
    vs.secao = b.dataset.go;
    renderVendas();
  }));
}

// ---------- 1. Visão Geral ----------
async function secVisao(box) {
  const { data: d } = await vendasVisaoGeral(paramsFiltros());
  setBadge("produtos", d.contadores?.itens ?? null);
  setBadge("importacoes", d.contadores?.importacoes ?? null);
  setBadge("divergencias", d.contadores?.divergencias ?? null);

  const temDados = d.temDados ?? (d.dias > 0 || d.qtdProdutos > 0);
  if (!temDados) {
    const filtrado = qtdFiltrosAtivos() > 0;
    box.innerHTML = filtrado
      ? vazio("🔍", "Nada encontrado com esses filtros", "Ajuste o período, canal ou origem — ou limpe os filtros para ver tudo.", `<button class="btn btn-ghost btn-sm" id="vd-v-limpar">✕ Limpar filtros</button>`)
      : vazio("📭", "Sem dados de vendas ainda", "Importe os relatórios do SW para consolidar o faturamento e o mix de produtos.", `<button class="btn btn-primary" id="vd-v-import">⬆️ Importar relatórios</button>`);
    el("#vd-v-import")?.addEventListener("click", abrirImportModal);
    el("#vd-v-limpar")?.addEventListener("click", () => { vs.filtros = { periodo: "tudo", de: "", ate: "", canal: "todos", origem: "todos" }; renderVendas(); });
    return;
  }

  box.innerHTML = `
    ${resumoPeriodo(d)}
    <div class="vd-cards">${cardsPrincipais(d)}</div>
    <div class="vd-cards-sub">${cardsStatus(d)}</div>
    <div class="vd-paineis">${paineis(d)}</div>`;
  bindAtalhos(box);
}

function resumoPeriodo(d) {
  const partes = [];
  if (d.fechamentos > 0) {
    const per = d.periodo;
    const faixa = per?.de ? (per.de === per.ate ? ` em ${fmtData(per.de)}` : ` entre ${fmtData(per.de)} e ${fmtData(per.ate)}`) : "";
    partes.push(`Dados consolidados de <b>${plural(d.fechamentos, "fechamento", "fechamentos")}</b>${faixa}.`);
  } else {
    partes.push("Somente produtos vendidos no período — nenhum fechamento de faturamento importado.");
  }
  if (d.ultimaImportacao?.criadoEm) partes.push(`Última importação em <b>${fmtDataHora(d.ultimaImportacao.criadoEm)}</b>.`);
  partes.push(d.cmvTeorico != null
    ? `CMV teórico calculado pelas fichas técnicas${d.coberturaCmv != null && d.coberturaCmv < 99 ? ` (cobre ${fmtPctBr(d.coberturaCmv)} das vendas)` : ""}.`
    : "CMV teórico ainda não calculado — vincule os produtos vendidos às fichas técnicas.");
  return `<div class="vd-resumo"><span class="vd-resumo-ico">📅</span><p>${partes.join(" · ")}</p></div>`;
}

const cardP = ({ icone, label, valor, sub = "", tip = "", cls = "" }) => `
  <div class="vd-card ${cls}">
    <div class="vd-card-topo"><span class="vd-card-ico">${icone}</span><span class="vd-card-lbl">${label}</span>${tip ? `<span class="vd-tip" data-tip="${escapeHtml(tip)}" tabindex="0" aria-label="${escapeHtml(tip)}">i</span>` : ""}</div>
    <span class="vd-card-val">${valor}</span>
    ${sub ? `<span class="vd-card-sub">${sub}</span>` : ""}
  </div>`;

function cardsPrincipais(d) {
  const cards = [
    cardP({ icone: "💵", label: "Faturamento bruto", valor: fmtMoeda(d.faturamentoBruto),
      sub: "Antes de descontos e ajustes", tip: "Soma do campo Total dos fechamentos importados, antes de descontos, cortesias e ajustes." }),
    cardP({ icone: "✅", label: "Faturamento líquido", valor: fmtMoeda(d.faturamentoLiquido), cls: "destaque",
      sub: "Após descontos, taxas e ajustes", tip: "Valor final de faturamento informado no fechamento do SW, já com descontos e ajustes aplicados." }),
    cardP({ icone: "🥪", label: "Venda de produtos", valor: fmtMoeda(d.totalVendido),
      sub: "Itens comerciais do relatório", tip: "Soma dos itens comerciais (produtos e combos) do relatório de Venda de Produtos por Grupo. Etapas de montagem e taxas ficam de fora." }),
    cardP({ icone: "📦", label: "Quantidade vendida", valor: Number(d.qtdProdutos).toLocaleString("pt-BR"), sub: "unidades no período" }),
  ];
  // CMV: nunca mostrar 0,0% como se fosse resultado real
  if (d.cmvTeorico != null) {
    cards.push(cardP({ icone: "🧮", label: "CMV teórico", valor: fmtPctBr(d.cmvTeorico),
      sub: d.coberturaCmv != null && d.coberturaCmv < 99 ? `Cobre ${fmtPctBr(d.coberturaCmv)} das vendas` : "Custo ÷ faturamento",
      tip: "Custo teórico das fichas técnicas dividido pelo faturamento do período." }));
    cards.push(cardP({ icone: "📈", label: "Margem estimada", valor: fmtPctBr(d.margem), sub: "Após o CMV teórico",
      tip: "Faturamento menos o custo teórico das fichas técnicas, em percentual." }));
  } else {
    const pend = d.semVinculo > 0 ? plural(d.semVinculo, "produto sem vínculo", "produtos sem vínculo")
      : d.semFicha > 0 ? plural(d.semFicha, "produto sem ficha técnica", "produtos sem ficha técnica")
      : "Nenhum custo processado ainda";
    cards.push(cardP({ icone: "🧮", label: "CMV teórico", valor: `<span class="vd-nocalc">Não calculado</span>`, sub: pend, cls: "aguarda",
      tip: "O CMV só é calculado quando os produtos vendidos estão vinculados a fichas técnicas com custo." }));
    cards.push(cardP({ icone: "📈", label: "Margem estimada", valor: `<span class="vd-nocalc">—</span>`, sub: "Aguardando cálculo do CMV", cls: "aguarda" }));
  }
  return cards.join("");
}

const cardS = ({ icone, label, valor, sub = "", cls = "", go = "", vinc = "" }) => `
  <div class="vd-scard ${cls} ${go ? "clicavel" : ""}" ${go ? `data-go="${go}" ${vinc ? `data-vinc="${vinc}"` : ""} role="button" tabindex="0"` : ""}>
    <span class="vd-scard-ico">${icone}</span>
    <div class="vd-scard-txt"><span class="vd-scard-lbl">${label}</span><b class="vd-scard-val">${valor}</b>${sub ? `<small>${sub}</small>` : ""}</div>
  </div>`;

function cardsStatus(d) {
  const dif = Number(d.diferenca) || 0;
  return [
    cardS({ icone: "🏷️", label: "Descontos", valor: fmtMoeda(d.descontos), sub: "no período" }),
    cardS({ icone: "🛵", label: "Taxas de entrega", valor: fmtMoeda(d.taxas), sub: "no período" }),
    cardS({ icone: "⚖️", label: "Diferença de fechamento", valor: fmtMoeda(dif),
      sub: dif < 0 ? "⚠ Atenção necessária" : dif > 0 ? "Sobra no fechamento" : "Fechamento sem diferença",
      cls: dif < 0 ? "alerta" : "" }),
    cardS({ icone: "🔗", label: "Produtos sem vínculo", valor: Number(d.semVinculo ?? 0).toLocaleString("pt-BR"),
      sub: d.semVinculo > 0 ? "Clique para vincular" : "Todos vinculados",
      cls: d.semVinculo > 0 ? "pendente" : "ok", go: d.semVinculo > 0 ? "produtos" : "", vinc: "nao" }),
    cardS({ icone: "⚠️", label: "Divergências abertas", valor: Number(d.contadores?.divergencias ?? 0).toLocaleString("pt-BR"),
      sub: d.contadores?.divergencias > 0 ? "Clique para revisar" : "Nenhuma pendente",
      cls: d.contadores?.divergencias > 0 ? "pendente" : "ok", go: d.contadores?.divergencias > 0 ? "divergencias" : "" }),
    cardS({ icone: "⏱️", label: "Última importação", valor: d.ultimaImportacao?.criadoEm ? fmtDataHora(d.ultimaImportacao.criadoEm) : "—",
      sub: d.ultimaImportacao ? (d.ultimaImportacao.status === "concluida" ? "Concluída" : d.ultimaImportacao.status) : "Nenhuma ainda",
      cls: "compacto", go: "importacoes" }),
  ].join("");
}

// ---------- painéis da Visão Geral ----------
const painel = (icone, titulo, corpo, cls = "") => `
  <section class="vd-painel ${cls}"><h3><span>${icone}</span> ${titulo}</h3>${corpo}</section>`;

function paineis(d) {
  return [
    painel("📈", "Faturamento por dia", chartBarras(d.porDia || [])),
    painel("🛒", "Distribuição por canal", listaCanais(d.porCanal || [])),
    painel("🏆", "Produtos mais vendidos", listaTop(d.topProdutos || [])),
    painel("🧺", "Faturamento por grupo", listaGrupos(d.porGrupo || [])),
    painel("📌", "Pendências da operação", listaPendencias(d), "largo"),
  ].join("");
}

function chartBarras(serie) {
  if (!serie.length) return vazioMini("Sem fechamentos no período selecionado.");
  const max = Math.max(...serie.map((s) => s.valor), 0.01);
  const denso = serie.length > 14;
  const passo = denso ? Math.ceil(serie.length / 10) : 1;
  return `<div class="vd-chart ${denso ? "denso" : ""}">
    ${serie.map((s, i) => {
      const h = Math.max(4, Math.round((s.valor / max) * 100));
      const dia = s.data ? `${s.data.slice(8, 10)}/${s.data.slice(5, 7)}` : "—";
      return `<div class="vd-chart-col" title="${dia} · ${fmtMoeda(s.valor)}">
        <div class="vd-chart-bar" style="height:${h}%"></div>
        <span class="vd-chart-lbl">${i % passo === 0 ? dia : ""}</span>
      </div>`;
    }).join("")}
  </div>`;
}

const hbar = (label, valor, max, direita) => `
  <div class="vd-hrow">
    <span class="vd-hlbl" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
    <div class="vd-hbar"><div style="width:${max > 0 ? Math.max(2, Math.round((valor / max) * 100)) : 0}%"></div></div>
    <b class="vd-hval">${direita}</b>
  </div>`;

function listaCanais(porCanal) {
  if (!porCanal.length) return vazioMini("Sem dados por canal no período.");
  const total = porCanal.reduce((s, c) => s + c.valor, 0);
  const max = Math.max(...porCanal.map((c) => c.valor), 0.01);
  return `<div class="vd-hlista">${porCanal.map((c) =>
    hbar(CANAL_LABEL[c.canal] || c.canal, c.valor, max, `${fmtMoeda(c.valor)} <small>${total > 0 ? fmtPctBr(c.valor / total * 100) : ""}</small>`)
  ).join("")}</div>`;
}

function listaTop(top) {
  if (!top.length) return vazioMini("Sem produtos vendidos no período.");
  const max = Math.max(...top.map((p) => p.quantidade), 0.01);
  return `<div class="vd-hlista">${top.map((p) =>
    hbar(p.nome, p.quantidade, max, `${Number(p.quantidade).toLocaleString("pt-BR")} <small>un</small>`)
  ).join("")}</div>`;
}

function listaGrupos(grupos) {
  if (!grupos.length) return vazioMini("Sem faturamento por grupo no período.");
  const max = Math.max(...grupos.map((g) => g.valor), 0.01);
  return `<div class="vd-hlista">${grupos.slice(0, 6).map((g) => hbar(g.grupo, g.valor, max, fmtMoeda(g.valor))).join("")}</div>`;
}

function listaPendencias(d) {
  const itens = [];
  if (d.semVinculo > 0) itens.push({ icone: "🔗", nivel: "warn", txt: `<b>${plural(d.semVinculo, "produto sem vínculo", "produtos sem vínculo")}</b> — o CMV não considera esses itens.`, go: "produtos", vinc: "nao", acao: "Vincular" });
  if (d.semFicha > 0) itens.push({ icone: "📋", nivel: "warn", txt: `<b>${plural(d.semFicha, "produto vinculado sem ficha técnica", "produtos vinculados sem ficha técnica")}</b> — custo zerado no cálculo.`, go: "produtos", acao: "Ver produtos" });
  if (d.contadores?.divergencias > 0) itens.push({ icone: "⚠️", nivel: "bad", txt: `<b>${plural(d.contadores.divergencias, "divergência aberta", "divergências abertas")}</b> nas importações.`, go: "divergencias", acao: "Revisar" });
  if (!d.fechamentos && d.temDados) itens.push({ icone: "💰", nivel: "info", txt: "<b>Nenhum fechamento de faturamento</b> no período — importe a Análise de Faturamento.", go: "importacoes", acao: "Importações" });
  if (!itens.length) return `<div class="vd-pend-ok">✅ Nenhuma pendência — vínculos, fichas e importações em dia.</div>`;
  return `<ul class="vd-pends">${itens.map((i) => `
    <li class="vd-pend ${i.nivel}">
      <span class="vd-pend-ico">${i.icone}</span>
      <span class="vd-pend-txt">${i.txt}</span>
      <button class="btn btn-ghost btn-sm" data-go="${i.go}" ${i.vinc ? `data-vinc="${i.vinc}"` : ""}>${i.acao}</button>
    </li>`).join("")}</ul>`;
}

// ---------- 2. Faturamento ----------
async function secFaturamento(box) {
  const { data } = await vendasFaturamento(paramsFiltros());
  if (!data.length) { box.innerHTML = vazio("💰", "Nenhum fechamento importado", "O relatório de Análise de Faturamento aparecerá aqui após a importação."); return; }
  const soma = (f) => data.reduce((s, r) => s + (Number(f(r)) || 0), 0);
  const linha = (r) => `<tr>
    <td>${fmtData(r.data_movimento)}</td>
    <td class="num">${fmtMoeda(r.produtos)}</td>
    <td class="num">${fmtMoeda(r.taxas_entrega)}</td>
    <td class="num">${fmtMoeda(r.descontos)}</td>
    <td class="num">${fmtMoeda(r.combos)}</td>
    <td class="num">${fmtMoeda(r.total)}</td>
    <td class="num"><b>${fmtMoeda(r.faturamento)}</b></td>
    <td class="num ${Number(r.diferenca) < 0 ? "vd-neg" : ""}">${fmtMoeda(r.diferenca)}</td>
    <td>${origemBadge(r.origem)}</td>
    <td><span class="pill ok">Importado</span></td>
  </tr>`;
  box.innerHTML = `<div class="tabela-wrap"><table class="grid vd-grid">
    <thead><tr><th>Data</th><th class="num">Produtos</th><th class="num">Taxas</th><th class="num">Descontos</th><th class="num">Combos</th><th class="num">Total</th><th class="num">Faturamento</th><th class="num">Diferença</th><th>Origem</th><th>Status</th></tr></thead>
    <tbody>${data.map(linha).join("")}</tbody>
    <tfoot><tr><td><b>Total (${plural(data.length, "fechamento", "fechamentos")})</b></td>
      <td class="num"><b>${fmtMoeda(soma((r) => r.produtos))}</b></td>
      <td class="num"><b>${fmtMoeda(soma((r) => r.taxas_entrega))}</b></td>
      <td class="num"><b>${fmtMoeda(soma((r) => r.descontos))}</b></td>
      <td class="num"><b>${fmtMoeda(soma((r) => r.combos))}</b></td>
      <td class="num"><b>${fmtMoeda(soma((r) => r.total))}</b></td>
      <td class="num"><b>${fmtMoeda(soma((r) => r.faturamento))}</b></td>
      <td class="num ${soma((r) => r.diferenca) < 0 ? "vd-neg" : ""}"><b>${fmtMoeda(soma((r) => r.diferenca))}</b></td>
      <td></td><td></td></tr></tfoot>
  </table></div>`;
}

// ---------- 3. Produtos Vendidos ----------
const pf = { busca: "", grupo: "todos", tipo: "todos", vinculo: "todos", ord: "valor" };
async function secProdutos(box) {
  const { data } = await vendasProdutos({ ...paramsFiltros(), grupo: pf.grupo, tipo: pf.tipo, vinculo: pf.vinculo });
  vs.produtos = data;
  setBadge("produtos", data.length);
  const grupos = [...new Set(data.map((r) => r.grupo).filter(Boolean))].sort();
  box.innerHTML = `
    <div class="toolbar vd-prod-toolbar">
      <div class="busca"><input id="vd-busca" type="search" placeholder="Buscar por nome ou código..." value="${escapeHtml(pf.busca)}"></div>
      <select id="vd-grupo"><option value="todos">Todos os grupos</option>${grupos.map((g) => `<option value="${escapeHtml(g)}" ${g === pf.grupo ? "selected" : ""}>${escapeHtml(g)}</option>`).join("")}</select>
      <select id="vd-tipo">${[["todos", "Todos os tipos"], ["produto", "Produto"], ["combo", "Combo"], ["etapa", "Etapa"], ["taxa_desconto", "Taxa/Desconto"]].map(([v, l]) => `<option value="${v}" ${v === pf.tipo ? "selected" : ""}>${l}</option>`).join("")}</select>
      <select id="vd-vinc">${[["todos", "Vínculo: todos"], ["vinculados", "Vinculados"], ["nao", "Não vinculados"]].map(([v, l]) => `<option value="${v}" ${v === pf.vinculo ? "selected" : ""}>${l}</option>`).join("")}</select>
      <select id="vd-ord">${[["valor", "Ordenar: faturamento"], ["qtd", "Ordenar: quantidade"]].map(([v, l]) => `<option value="${v}" ${v === pf.ord ? "selected" : ""}>${l}</option>`).join("")}</select>
      <button class="btn btn-ghost btn-sm" id="vd-massa" title="Vincular vários produtos de uma vez">🔗 Vincular em massa</button>
    </div>
    <div id="vd-prod-tabela"></div>`;
  el("#vd-massa")?.addEventListener("click", abrirMassaModal);
  // busca/ordenação filtram localmente sem recriar a toolbar (mantém o foco no input)
  el("#vd-busca")?.addEventListener("input", (e) => { pf.busca = e.target.value; renderTabelaProdutos(); });
  el("#vd-ord")?.addEventListener("change", (e) => { pf.ord = e.target.value; renderTabelaProdutos(); });
  el("#vd-grupo")?.addEventListener("change", (e) => { pf.grupo = e.target.value; carregarSecao(); });
  el("#vd-tipo")?.addEventListener("change", (e) => { pf.tipo = e.target.value; carregarSecao(); });
  el("#vd-vinc")?.addEventListener("change", (e) => { pf.vinculo = e.target.value; carregarSecao(); });
  renderTabelaProdutos();
}

function renderTabelaProdutos() {
  const alvo = el("#vd-prod-tabela");
  if (!alvo) return;
  const data = vs.produtos || [];
  const termo = pf.busca.trim().toLowerCase();
  const rows = data.filter((r) => !termo || (r.nome_sw || "").toLowerCase().includes(termo) || String(r.codigo_sw || "").includes(termo));
  rows.sort((a, b) => pf.ord === "qtd" ? b.quantidade - a.quantidade : b.valor_total - a.valor_total);
  const linha = (r) => `<tr>
    <td>${escapeHtml(r.codigo_sw || "—")}</td>
    <td class="prod-nome">${escapeHtml(r.nome_sw || "—")}</td>
    <td>${escapeHtml(r.grupo || "—")}</td>
    <td class="num">${Number(r.quantidade).toLocaleString("pt-BR")}</td>
    <td class="num">${fmtMoeda(r.valor_total)}</td>
    <td class="num">${fmtMoeda(r.preco_medio)}</td>
    <td><span class="pill ${r.tipo_item === "produto" || r.tipo_item === "combo" ? "info" : "muted"}">${tipoLabel[r.tipo_item] || r.tipo_item}</span></td>
    <td>${r.produto_nome ? escapeHtml(r.produto_nome) : (r.tipo_item === "produto" || r.tipo_item === "combo" ? `<button class="btn btn-ghost btn-sm vd-link" data-cod="${escapeHtml(r.codigo_sw || "")}" data-nome="${escapeHtml(r.nome_sw || "")}">🔗 Vincular</button>` : '<span class="cinza">—</span>')}</td>
    <td class="num">${r.custo_teorico != null ? fmtMoeda(r.custo_teorico) : "—"}</td>
    <td class="num">${r.cmv_pct != null ? fmtPctBr(r.cmv_pct) : "—"}</td>
    <td>${origemBadge(r.origem)}</td>
  </tr>`;
  alvo.innerHTML = rows.length
    ? `<div class="tabela-wrap"><table class="grid vd-grid">
        <thead><tr><th>Código</th><th>Produto</th><th>Grupo</th><th class="num">Qtd</th><th class="num">Valor total</th><th class="num">Preço médio</th><th>Tipo</th><th>Vínculo</th><th class="num">Custo teórico</th><th class="num">CMV</th><th>Origem</th></tr></thead>
        <tbody>${rows.map(linha).join("")}</tbody></table></div>`
    : vazio("🧾", "Nenhum produto", data.length ? "Ajuste a busca ou os filtros." : "Importe o relatório de Venda de Produtos por Grupo.");
  alvo.querySelectorAll(".vd-link").forEach((b) => b.addEventListener("click", () => abrirVinculoModal(b.dataset.cod, b.dataset.nome)));
}

// ---------- 4. Importações ----------
async function secImportacoes(box) {
  const { data } = await vendasImportacoes();
  setBadge("importacoes", data.length);
  const cabec = `<div class="vd-imp-head"><p>Histórico de importações. Cada relatório é protegido contra reimportação (hash do arquivo).</p><button class="btn btn-primary btn-sm" id="vd-imp-novo">⬆️ Importar relatórios do SW</button></div>`;
  if (!data.length) { box.innerHTML = cabec + vazio("⬆️", "Nenhuma importação ainda", "Clique em “Importar relatórios do SW” para enviar a Análise de Faturamento e a Venda de Produtos por Grupo."); el("#vd-imp-novo")?.addEventListener("click", abrirImportModal); return; }
  const rel = { faturamento: "Análise de Faturamento", produtos_grupo: "Venda de Produtos por Grupo" };
  const linha = (r) => `<tr>
    <td>${fmtDataHora(r.criado_em)}</td>
    <td>${fmtData(r.data_movimento)}</td>
    <td>${rel[r.tipo_relatorio] || r.tipo_relatorio}</td>
    <td>${origemBadge(r.origem)}</td>
    <td>${escapeHtml(r.canal)}</td>
    <td class="num">${r.total_registros}</td>
    <td class="num">${fmtMoeda(r.valor_total)}</td>
    <td><span class="pill ${r.status === "concluida" ? "ok" : r.status === "erro" ? "bad" : "warn"}">${r.status}</span></td>
    <td class="vd-arq" title="${escapeHtml(r.nome_arquivo || "")}">${escapeHtml(r.nome_arquivo || "—")}</td>
    <td class="vd-acoes-td">
      ${r.arquivo_storage ? `<button class="acao-btn vd-dl-imp" data-id="${r.id}" title="Baixar arquivo original" aria-label="Baixar arquivo original">📄</button>` : ""}
      <button class="acao-btn vd-del-imp" data-id="${r.id}" title="Excluir importação" aria-label="Excluir importação">🗑️</button>
    </td>
  </tr>`;
  box.innerHTML = cabec + `<div class="tabela-wrap"><table class="grid vd-grid">
    <thead><tr><th>Importado em</th><th>Movimento</th><th>Relatório</th><th>Origem</th><th>Canal</th><th class="num">Registros</th><th class="num">Valor</th><th>Status</th><th>Arquivo</th><th>Ações</th></tr></thead>
    <tbody>${data.map(linha).join("")}</tbody></table></div>`;
  el("#vd-imp-novo")?.addEventListener("click", abrirImportModal);
  box.querySelectorAll(".vd-del-imp").forEach((b) => b.addEventListener("click", () => excluirImportacao(b.dataset.id, data)));
  box.querySelectorAll(".vd-dl-imp").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try { const { data: arq } = await vendasArquivoOriginal(b.dataset.id); window.open(arq.url, "_blank"); }
    catch (e) { toast("Erro: " + e.message); }
    finally { b.disabled = false; }
  }));
}

async function excluirImportacao(id, lista) {
  const imp = (lista || []).find((x) => x.id === id);
  const rel = imp?.tipo_relatorio === "produtos_grupo" ? "Venda de Produtos por Grupo" : "Análise de Faturamento";
  if (!confirm(`Excluir esta importação (${rel} · ${imp?.data_movimento || ""})? Os dados de faturamento/produtos desse relatório serão removidos.`)) return;
  try { await vendasExcluirImportacao(id); toast("Importação excluída."); carregarSecao(); }
  catch (e) { toast("Erro: " + e.message); }
}

// ---------- 5. Divergências ----------
async function secDivergencias(box) {
  const { data } = await vendasDivergencias();
  const abertas = data.filter((d) => !d.resolvida);
  setBadge("divergencias", abertas.length);
  if (!data.length) { box.innerHTML = vazio("✅", "Nenhuma divergência", "As importações não geraram divergências pendentes."); return; }
  const ordem = { critico: 0, atencao: 1, info: 2 };
  data.sort((a, b) => (a.resolvida - b.resolvida) || (ordem[a.nivel] ?? 3) - (ordem[b.nivel] ?? 3));
  box.innerHTML = `<div class="vd-divs">${data.map((d) => `
    <div class="vd-div ${d.nivel} ${d.resolvida ? "resolvida" : ""}">
      <span class="pill ${d.resolvida ? "muted" : nivelPill(d.nivel)}">${d.resolvida ? "resolvida" : d.nivel}</span>
      <div class="vd-div-txt"><b>${escapeHtml(d.titulo)}</b><small>${escapeHtml(d.descricao || "")}</small></div>
      <span class="vd-div-data">${fmtDataHora(d.criado_em)}</span>
      <button class="btn btn-ghost btn-sm vd-div-res" data-id="${d.id}" data-res="${d.resolvida ? "0" : "1"}">${d.resolvida ? "↩ Reabrir" : "✓ Resolver"}</button>
    </div>`).join("")}</div>`;
  box.querySelectorAll(".vd-div-res").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await vendasResolverDivergencia(b.dataset.id, b.dataset.res === "1");
      toast(b.dataset.res === "1" ? "Divergência resolvida." : "Divergência reaberta.");
      carregarSecao();
    } catch (e) { toast("Erro: " + e.message); b.disabled = false; }
  }));
}

// ===================== IMPORTAÇÃO =====================
let ov = null;
function fecharOverlay() { ov?.remove(); ov = null; document.removeEventListener("keydown", onEsc); }
function onEsc(e) { if (e.key === "Escape") fecharOverlay(); }
function overlay(html) {
  fecharOverlay();
  ov = document.createElement("div"); ov.className = "modal-overlay";
  ov.innerHTML = `<div class="modal vd-modal">${html}</div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) fecharOverlay(); });
  document.body.appendChild(ov); document.addEventListener("keydown", onEsc);
  return ov.querySelector(".modal");
}

function abrirImportModal() {
  ultimoPayload = null; // nunca reaproveitar payload de um modal anterior
  const hoje = new Date().toISOString().slice(0, 10);
  const m = overlay(`
    <button class="modal-close" aria-label="Fechar">×</button>
    <div class="modal-head"><h2>⬆️ Importar relatórios do SW</h2></div>
    <div class="vd-imp-form">
      <label class="vd-file"><span>Relatório 1 — Análise de Faturamento <b>*</b></span>
        <input type="file" id="imp-fat" accept=".csv,.xlsx,.xls,.pdf"><em id="imp-fat-nome">Nenhum arquivo · aceita PDF, Excel ou CSV do SW</em></label>
      <label class="vd-file"><span>Relatório 2 — Venda de Produtos por Grupo <b>*</b></span>
        <input type="file" id="imp-prod" accept=".csv,.xlsx,.xls,.pdf"><em id="imp-prod-nome">Nenhum arquivo · aceita PDF, Excel ou CSV do SW</em></label>
      <div class="cfg-form-grid">
        <label class="cfg-campo"><span>Data do movimento *</span><input type="date" id="imp-data" value="${hoje}"></label>
        <label class="cfg-campo"><span>Canal</span><select id="imp-canal"><option value="balcao">Balcão</option><option value="ifood">iFood</option></select></label>
        <label class="cfg-campo"><span>Origem</span><select id="imp-origem"><option value="manual">Importação manual</option><option value="swfast">SWFast</option><option value="ifood">iFood</option></select></label>
        <label class="cfg-campo"><span>Observação (opcional)</span><input type="text" id="imp-obs" placeholder="ex.: fechamento de sábado"></label>
      </div>
      <div class="vd-imp-msg" id="imp-msg" hidden></div>
      <div id="imp-preview"></div>
    </div>
    <div class="ed-acoes">
      <button class="btn btn-ghost" id="imp-cancelar">Cancelar</button>
      <button class="btn btn-ghost" id="imp-preview-btn">Pré-visualizar</button>
      <button class="btn btn-primary" id="imp-confirmar" disabled>Confirmar importação</button>
    </div>`);
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  m.querySelector("#imp-cancelar").addEventListener("click", fecharOverlay);
  const nome = (id, alvo) => m.querySelector(id).addEventListener("change", (e) => { m.querySelector(alvo).textContent = e.target.files?.[0]?.name || "Nenhum arquivo"; });
  nome("#imp-fat", "#imp-fat-nome"); nome("#imp-prod", "#imp-prod-nome");
  // qualquer mudança invalida a prévia: obriga novo preview antes de confirmar
  const invalidar = () => {
    ultimoPayload = null;
    m.querySelector("#imp-confirmar").disabled = true;
    m.querySelector("#imp-preview").innerHTML = "";
    m.querySelector("#imp-msg").hidden = true;
  };
  ["#imp-fat", "#imp-prod", "#imp-data", "#imp-canal", "#imp-origem"].forEach((s) => m.querySelector(s).addEventListener("change", invalidar));
  m.querySelector("#imp-preview-btn").addEventListener("click", () => processar(m, false));
  m.querySelector("#imp-confirmar").addEventListener("click", () => processar(m, true));
}

let ultimoPayload = null;
async function processar(m, confirmar) {
  const msg = m.querySelector("#imp-msg");
  const setMsg = (t, cls = "erro") => { msg.hidden = false; msg.className = "vd-imp-msg " + cls; msg.textContent = t; };
  const fFat = m.querySelector("#imp-fat").files?.[0];
  const fProd = m.querySelector("#imp-prod").files?.[0];
  const dataMov = m.querySelector("#imp-data").value;
  if (!fFat && !fProd) return setMsg("Envie ao menos um dos dois relatórios.");
  if (!dataMov) return setMsg("Informe a data do movimento.");
  const canal = m.querySelector("#imp-canal").value, origem = m.querySelector("#imp-origem").value;
  const btn = m.querySelector(confirmar ? "#imp-confirmar" : "#imp-preview-btn");
  const txt = btn.textContent; btn.disabled = true; btn.textContent = confirmar ? "Importando…" : "Lendo…";
  try {
    let payload = ultimoPayload;
    if (!confirmar || !payload) {
      const [faturamento, produtos] = await Promise.all([arquivoPayload(fFat), arquivoPayload(fProd)]);
      payload = { dataMovimento: dataMov, canal, origem, observacao: m.querySelector("#imp-obs").value, faturamento, produtos };
      ultimoPayload = payload;
    }
    if (confirmar) {
      await vendasImportar(payload);
      toast("Importação concluída ✅"); fecharOverlay(); ultimoPayload = null; carregarSecao();
    } else {
      const { data } = await vendasPreview(payload);
      renderPreview(m, data.preview);
    }
  } catch (e) {
    setMsg("Erro: " + e.message);
    if (confirmar) { m.querySelector("#imp-confirmar").disabled = false; }
  } finally { btn.disabled = false; btn.textContent = txt; }
}

function renderPreview(m, p) {
  const box = m.querySelector("#imp-preview");
  const item = (lbl, val) => `<div class="vd-pv-item"><span>${lbl}</span><b>${val}</b></div>`;
  const bloqueado = p.duplicidades > 0 || p.erros.length > 0;
  box.innerHTML = `
    <div class="vd-preview">
      <div class="vd-pv-titulo">Prévia da importação</div>
      <div class="vd-pv-grid">
        ${item("Data encontrada", p.dataMovimento ? fmtData(p.dataMovimento) : "—")}
        ${item("Faturamento", fmtMoeda(p.faturamentoEncontrado))}
        ${item("Itens no arquivo", p.totalItens)}
        ${item("Produtos comerciais", p.produtosComerciais)}
        ${item("Etapas ignoradas", p.etapasIgnoradas)}
        ${item("Sem vínculo", p.semVinculo)}
        ${item("CMV teórico", p.cmvTeorico != null ? fmtPctBr(p.cmvTeorico) : "não calculado")}
        ${item("Duplicidades", p.duplicidades)}
      </div>
      ${renderReconciliacao(p.reconciliacao)}
      ${p.divergencias.length ? `<div class="vd-pv-divs">${p.divergencias.slice(0, 12).map((d) => `<div class="vd-pv-div"><span class="pill ${nivelPill(d.nivel)}">${d.nivel}</span> ${escapeHtml(d.titulo)}${d.descricao ? ` — <small>${escapeHtml(d.descricao)}</small>` : ""}</div>`).join("")}${p.divergencias.length > 12 ? `<div class="vd-pv-div cinza">+${p.divergencias.length - 12} outras…</div>` : ""}</div>` : `<div class="vd-pv-ok">✅ Nenhuma divergência encontrada.</div>`}
    </div>`;
  const conf = m.querySelector("#imp-confirmar");
  conf.disabled = bloqueado;
  if (bloqueado) { const msg = m.querySelector("#imp-msg"); msg.hidden = false; msg.className = "vd-imp-msg erro"; msg.textContent = p.duplicidades ? "Este relatório já foi importado anteriormente." : p.erros[0]; }
}

// checagem cruzada entre a Análise de Faturamento e a Venda de Produtos
function renderReconciliacao(checks) {
  if (!checks?.length) return "";
  const linha = (c) => {
    const detalhe = c.diferenca == null
      ? `${escapeHtml(String(c.relatorioFaturamento))} · ${escapeHtml(String(c.relatorioProdutos))}`
      : `Faturamento ${fmtMoeda(c.relatorioFaturamento)} · Produtos ${fmtMoeda(c.relatorioProdutos)}${c.ok ? "" : ` · diferença ${fmtMoeda(c.diferenca)}`}`;
    return `<div class="vd-rec-row ${c.ok ? "ok" : "falha"}"><span>${c.ok ? "✅" : "❌"} ${escapeHtml(c.campo)}</span><small>${detalhe}</small></div>`;
  };
  return `<div class="vd-rec"><div class="vd-pv-titulo">Reconciliação entre os relatórios</div>${checks.map(linha).join("")}</div>`;
}

// ---------- envio do arquivo original ----------
// A leitura/interpretação dos relatórios (CSV, Excel e PDF) acontece no BACKEND.
// O frontend só embala o arquivo original em base64 e envia.
async function arquivoPayload(file) {
  if (!file) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  const BLOCO = 0x8000;
  for (let i = 0; i < bytes.length; i += BLOCO) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + BLOCO));
  return { nomeArquivo: file.name, conteudoBase64: btoa(bin) };
}

// ---------- vínculo de produto ----------
let listaProdutosCache = null;
async function garantirProdutos() {
  if (!listaProdutosCache) {
    const { data } = await listarProdutosSistema();
    listaProdutosCache = (data || []).sort((a, b) => a.nome.localeCompare(b.nome));
  }
  return listaProdutosCache;
}
const optionsProdutos = (selecionado = "") =>
  `<option value="">— selecione —</option>` + (listaProdutosCache || []).map((p) =>
    `<option value="${p.id}" ${p.id === selecionado ? "selected" : ""}>${escapeHtml(p.nome)}${p.tamanho ? " · " + p.tamanho : ""}</option>`).join("");

// sugestão simples por nome (para o vínculo em massa)
const normTxt = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
function melhorSugestao(nomeSw, lista) {
  const alvo = normTxt(nomeSw);
  const tokens = alvo.split(" ").filter((t) => t.length > 2);
  let melhor = null, melhorPts = 0;
  for (const p of lista) {
    const nome = normTxt(`${p.nome} ${p.tamanho || ""}`);
    let pts = 0;
    for (const t of tokens) if (nome.includes(t)) pts++;
    if (nome && alvo.includes(nome)) pts += 2;
    if (pts > melhorPts) { melhorPts = pts; melhor = p; }
  }
  return melhorPts >= Math.max(1, Math.ceil(tokens.length / 2)) ? melhor : null;
}

async function abrirVinculoModal(codigo, nomeSw) {
  const m = overlay(`<button class="modal-close">×</button><div class="modal-head"><h2>🔗 Vincular produto</h2><div class="modal-tags"><span class="chip">${escapeHtml(nomeSw || codigo)}</span></div></div>
    <div class="estado"><div class="spinner"></div>Carregando produtos…</div>`);
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  try {
    const [, componentesExistentes] = await Promise.all([
      garantirProdutos(),
      vendasComponentesCombo(codigo).then((r) => r.data || []).catch(() => []),
    ]);
    let comps = componentesExistentes.map((c) => ({ produtoId: c.produtoId, quantidade: c.quantidade || 1 }));
    m.innerHTML = `<button class="modal-close">×</button>
      <div class="modal-head"><h2>🔗 Vincular produto</h2><div class="modal-tags"><span class="chip">${escapeHtml(nomeSw || "")}</span><span class="chip">cód. ${escapeHtml(codigo || "—")}</span></div></div>
      <p class="vd-vinc-p">Escolha o produto do sistema correspondente. O vínculo é salvo para as próximas importações e o custo teórico é recalculado pela ficha técnica.</p>
      <label class="cfg-campo"><span>Tipo</span><select id="vinc-tipo">
        <option value="produto">Produto</option><option value="combo" ${comps.length ? "selected" : ""}>Combo</option>
        <option value="etapa">Etapa (ignorar no CMV)</option><option value="taxa_desconto">Taxa/Desconto</option></select></label>
      <label class="cfg-campo"><span>Produto do sistema</span>
        <select id="vinc-prod">${optionsProdutos()}</select></label>
      <div id="vinc-combo" ${comps.length ? "" : "hidden"}>
        <p class="vd-vinc-p">Combo sem produto próprio? Monte a composição — o custo do combo passa a ser a soma dos componentes.</p>
        <div id="vinc-comps"></div>
        <button class="btn btn-ghost btn-sm" id="vinc-add-comp">+ Adicionar componente</button>
      </div>
      <div class="ed-acoes"><button class="btn btn-ghost" id="vinc-cancelar">Cancelar</button><button class="btn btn-primary" id="vinc-salvar">Salvar vínculo</button></div>`;
    m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
    m.querySelector("#vinc-cancelar").addEventListener("click", fecharOverlay);

    const renderComps = () => {
      const box = m.querySelector("#vinc-comps");
      box.innerHTML = comps.map((c, i) => `
        <div class="vd-comp-row" data-i="${i}">
          <select class="vd-comp-prod">${optionsProdutos(c.produtoId)}</select>
          <input class="vd-comp-qtd" type="number" min="0.1" step="0.1" value="${c.quantidade}" aria-label="Quantidade">
          <button class="acao-btn vd-comp-del" title="Remover componente">✕</button>
        </div>`).join("") || `<p class="vd-vinc-p cinza">Nenhum componente ainda.</p>`;
      box.querySelectorAll(".vd-comp-row").forEach((row) => {
        const i = Number(row.dataset.i);
        row.querySelector(".vd-comp-prod").addEventListener("change", (e) => { comps[i].produtoId = e.target.value; });
        row.querySelector(".vd-comp-qtd").addEventListener("change", (e) => { comps[i].quantidade = Number(e.target.value) || 1; });
        row.querySelector(".vd-comp-del").addEventListener("click", () => { comps.splice(i, 1); renderComps(); });
      });
    };
    renderComps();
    m.querySelector("#vinc-add-comp").addEventListener("click", () => { comps.push({ produtoId: "", quantidade: 1 }); renderComps(); });
    m.querySelector("#vinc-tipo").addEventListener("change", (e) => { m.querySelector("#vinc-combo").hidden = e.target.value !== "combo"; });

    m.querySelector("#vinc-salvar").addEventListener("click", async () => {
      const produtoId = m.querySelector("#vinc-prod").value || null;
      const tipoItem = m.querySelector("#vinc-tipo").value;
      const componentes = tipoItem === "combo" ? comps.filter((c) => c.produtoId && c.quantidade > 0) : [];
      const btn = m.querySelector("#vinc-salvar"); btn.disabled = true; btn.textContent = "Salvando…";
      try { await vendasVincular({ codigoSw: codigo, produtoId, tipoItem, nomeSw, componentes }); toast("Vínculo salvo."); fecharOverlay(); carregarSecao(); }
      catch (e) { toast("Erro: " + e.message); btn.disabled = false; btn.textContent = "Salvar vínculo"; }
    });
  } catch (e) {
    m.innerHTML = `<button class="modal-close">×</button><div class="estado erro"><span class="emoji">⚠️</span><h3>Erro</h3><p>${escapeHtml(e.message)}</p></div>`;
    m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  }
}

// ---------- vínculo em massa ----------
async function abrirMassaModal() {
  const pendentes = [];
  const vistos = new Set();
  for (const r of vs.produtos || []) {
    const comercial = r.tipo_item === "produto" || r.tipo_item === "combo";
    const chave = String(r.codigo_sw || r.nome_sw || "").trim();
    if (!comercial || r.produto_nome || !chave || vistos.has(chave)) continue;
    vistos.add(chave);
    pendentes.push({ codigo: r.codigo_sw, nome: r.nome_sw, tipo: r.tipo_item, qtd: Number(r.quantidade) || 0 });
  }
  if (!pendentes.length) { toast("Nenhum produto sem vínculo na lista atual."); return; }

  const m = overlay(`<button class="modal-close">×</button>
    <div class="modal-head"><h2>🔗 Vincular em massa</h2><div class="modal-tags"><span class="chip">${plural(pendentes.length, "produto sem vínculo", "produtos sem vínculo")}</span></div></div>
    <div class="estado"><div class="spinner"></div>Carregando produtos…</div>`);
  m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  try {
    const lista = await garantirProdutos();
    const linhas = pendentes.map((p, i) => {
      const sug = melhorSugestao(p.nome, lista);
      return `<tr data-i="${i}">
        <td><input type="checkbox" class="vm-check" ${sug ? "checked" : ""} aria-label="Incluir ${escapeHtml(p.nome || p.codigo)}"></td>
        <td class="vm-nome" title="${escapeHtml(p.nome || "")}">${escapeHtml(p.nome || "—")}<small>cód. ${escapeHtml(p.codigo || "—")}</small></td>
        <td><select class="vm-prod">${optionsProdutos(sug?.id || "")}</select></td>
        <td><select class="vm-tipo">
          <option value="produto" ${p.tipo === "produto" ? "selected" : ""}>Produto</option>
          <option value="combo" ${p.tipo === "combo" ? "selected" : ""}>Combo</option>
          <option value="etapa">Etapa (ignorar)</option>
          <option value="taxa_desconto">Taxa/Desconto</option></select></td>
      </tr>`;
    }).join("");
    m.innerHTML = `<button class="modal-close">×</button>
      <div class="modal-head"><h2>🔗 Vincular em massa</h2><div class="modal-tags"><span class="chip">${plural(pendentes.length, "produto sem vínculo", "produtos sem vínculo")}</span></div></div>
      <p class="vd-vinc-p">Sugestões pré-selecionadas pelo nome — revise antes de salvar. Itens marcados como Etapa ou Taxa/Desconto ficam fora do CMV, sem precisar de produto.</p>
      <div class="tabela-wrap vd-massa-wrap"><table class="grid grid-modal vd-massa">
        <thead><tr><th></th><th>Produto no SW</th><th>Produto do sistema</th><th>Tipo</th></tr></thead>
        <tbody>${linhas}</tbody></table></div>
      <div class="ed-acoes"><button class="btn btn-ghost" id="vm-cancelar">Cancelar</button><button class="btn btn-primary" id="vm-salvar">Salvar vínculos</button></div>`;
    m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
    m.querySelector("#vm-cancelar").addEventListener("click", fecharOverlay);
    m.querySelector("#vm-salvar").addEventListener("click", async () => {
      const itens = [];
      m.querySelectorAll("tbody tr").forEach((tr) => {
        if (!tr.querySelector(".vm-check").checked) return;
        const p = pendentes[Number(tr.dataset.i)];
        const produtoId = tr.querySelector(".vm-prod").value || null;
        const tipoItem = tr.querySelector(".vm-tipo").value;
        if (!produtoId && tipoItem !== "etapa" && tipoItem !== "taxa_desconto") return; // sem produto só faz sentido p/ ignorar
        itens.push({ codigoSw: p.codigo, nomeSw: p.nome, produtoId, tipoItem });
      });
      if (!itens.length) { toast("Marque ao menos um item com produto (ou como etapa/taxa)."); return; }
      const btn = m.querySelector("#vm-salvar"); btn.disabled = true; btn.textContent = "Salvando…";
      try {
        const { data } = await vendasVincularLote(itens);
        const falhas = data.total - data.sucesso;
        toast(`${plural(data.sucesso, "vínculo salvo", "vínculos salvos")}${falhas ? ` · ${falhas} com erro` : ""}.`);
        fecharOverlay(); carregarSecao();
      } catch (e) { toast("Erro: " + e.message); btn.disabled = false; btn.textContent = "Salvar vínculos"; }
    });
  } catch (e) {
    m.innerHTML = `<button class="modal-close">×</button><div class="estado erro"><span class="emoji">⚠️</span><h3>Erro</h3><p>${escapeHtml(e.message)}</p></div>`;
    m.querySelector(".modal-close").addEventListener("click", fecharOverlay);
  }
}

// ---------- datas ----------
const fmtData = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("pt-BR") : "—";
const fmtDataHora = (iso) => iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const origemBadge = (o) => `<span class="pill ${o === "swfast" ? "info" : o === "ifood" ? "warn" : "muted"}">${({ manual: "Manual", swfast: "SWFast", ifood: "iFood" }[o] || o)}</span>`;
