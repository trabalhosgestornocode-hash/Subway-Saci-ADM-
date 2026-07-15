// Regras de negócio PURAS da aba Vendas (sem Supabase): classificação de itens,
// reconciliação entre os dois relatórios do SW e consolidação da Visão Geral.
// Puras de propósito — são as funções cobertas pelos testes automatizados.

// ---------- classificação de item (regra por código -> senão heurística) ----------
export const RE_ETAPA = /(^sem |^não quero|^nao quero|tomate|cebola|alface|pepino|azeitona|picles|piment|^molho|maionese|barbecue|chipotle|teriyaki|mostarda|parmes|or[ée]gano|^p[ãa]o|tempero|vegeta|sem queijo|sem vegetais|acompanhamento$|^n[ãa]o)/i;

export function classificar(linha, mapa) {
  const m = mapa.get(String(linha.codigoSw || "").trim());
  if (m) {
    return { tipoItem: m.tipo_item, produtoId: m.produto_id, ignorarCmv: m.ignorar_no_cmv, ignorarEstoque: m.ignorar_no_estoque, viaMapa: true };
  }
  const grupo = String(linha.grupo || "").toLowerCase();
  const nome = String(linha.nomeSw || "");
  if (grupo.includes("taxa") || grupo.includes("desconto"))
    return { tipoItem: "taxa_desconto", produtoId: null, ignorarCmv: true, ignorarEstoque: true };
  if (grupo.includes("combo"))
    return { tipoItem: "combo", produtoId: null, ignorarCmv: false, ignorarEstoque: false };
  // Grupos de montagem/insumo (ETAPAS, INSUMOS): valor 0 (escolha/condimento) ou nome
  // de etapa -> ignora. Valor > 0 é item comercial (combo/promo) que caiu no grupo -> produto.
  const grupoMontagem = grupo.includes("etapa") || grupo.includes("insumo");
  if (grupoMontagem) {
    const valor = Number(linha.valorTotal) || 0;
    if (valor <= 0 || RE_ETAPA.test(nome))
      return { tipoItem: "etapa", produtoId: null, ignorarCmv: true, ignorarEstoque: true };
    return { tipoItem: "produto", produtoId: null, ignorarCmv: false, ignorarEstoque: false };
  }
  return { tipoItem: "produto", produtoId: null, ignorarCmv: false, ignorarEstoque: false };
}

// ---------- reconciliação entre Análise de Faturamento x Venda de Produtos ----------
// Compara o que os dois relatórios dizem sobre o MESMO dia. Tolerância de
// R$ 1,00 ou 2% (arredondamentos do SW). Cada checagem reprovada vira divergência.
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const dentroDaTolerancia = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(a) * 0.02);

export function reconciliar(fat, linhas, { dataFat = null, dataProd = null } = {}) {
  const checks = [];
  const add = (campo, esperado, encontrado, ok, obs = "") =>
    checks.push({ campo, relatorioFaturamento: esperado, relatorioProdutos: encontrado, diferenca: r2((Number(encontrado) || 0) - (Number(esperado) || 0)), ok, obs });

  if (dataFat && dataProd) {
    checks.push({ campo: "Data do movimento", relatorioFaturamento: dataFat, relatorioProdutos: dataProd, diferenca: null, ok: dataFat === dataProd, obs: dataFat === dataProd ? "" : "Os relatórios parecem ser de dias diferentes." });
  }
  if (!fat || !linhas?.length) return checks;

  const soma = (arr) => r2(arr.reduce((s, l) => s + (Number(l.valor_total ?? l.valorTotal) || 0), 0));
  const tipo = (l) => l.tipo_item ?? l.tipoItem;
  const somaProdutos = soma(linhas.filter((l) => tipo(l) === "produto"));
  const somaCombos = soma(linhas.filter((l) => tipo(l) === "combo"));
  const fatProdutos = r2(fat.produtos), fatCombos = r2(fat.combos);

  if (fatProdutos > 0 || somaProdutos > 0)
    add("Produtos (R$)", fatProdutos, somaProdutos, dentroDaTolerancia(fatProdutos, somaProdutos),
      dentroDaTolerancia(fatProdutos, somaProdutos) ? "" : "Valor de produtos difere entre os relatórios.");
  if (fatCombos > 0 || somaCombos > 0)
    add("Combos (R$)", fatCombos, somaCombos, dentroDaTolerancia(fatCombos, somaCombos),
      dentroDaTolerancia(fatCombos, somaCombos) ? "" : "Valor de combos difere entre os relatórios.");
  const totFat = r2(fatProdutos + fatCombos), totProd = r2(somaProdutos + somaCombos);
  add("Produtos + Combos (R$)", totFat, totProd, dentroDaTolerancia(totFat, totProd),
    dentroDaTolerancia(totFat, totProd) ? "" : "Total de itens comerciais difere entre os relatórios.");
  return checks;
}

export function divergenciasDaReconciliacao(checks) {
  return checks.filter((c) => !c.ok).map((c) => ({
    tipo: c.campo === "Data do movimento" ? "datas_diferentes" : "valor_incompativel",
    nivel: c.campo === "Data do movimento" ? "critico" : "atencao",
    titulo: `Reconciliação: ${c.campo}`,
    descricao: c.diferenca != null
      ? `Faturamento informa ${fmt(c.relatorioFaturamento)}; o relatório de produtos soma ${fmt(c.relatorioProdutos)} (diferença de ${fmt(c.diferenca)}). ${c.obs}`.trim()
      : `Faturamento: ${c.relatorioFaturamento} · Produtos: ${c.relatorioProdutos}. ${c.obs}`.trim(),
  }));
}
const fmt = (v) => `R$ ${(Number(v) || 0).toFixed(2)}`;

// ---------- consolidação da Visão Geral (fat rows + prod rows -> indicadores) ----------
export function consolidarVisao(fat, prod) {
  fat = fat || []; prod = prod || [];
  const sum = (arr, f) => arr.reduce((s, r) => s + (Number(f(r)) || 0), 0);
  const faturamentoBruto = sum(fat, (r) => r.total);
  const faturamento = sum(fat, (r) => r.faturamento);
  const descontos = sum(fat, (r) => r.descontos);
  const taxas = sum(fat, (r) => r.taxas_entrega);
  const diferenca = sum(fat, (r) => r.diferenca);
  const comerciais = prod.filter((r) => r.tipo_item === "produto" || r.tipo_item === "combo");
  const totalVendido = sum(comerciais, (r) => r.valor_total);
  const qtdProdutos = sum(comerciais, (r) => r.quantidade);
  const custoTeorico = sum(prod.filter((r) => !r.ignorar_no_cmv), (r) => r.custo_teorico);
  const base = faturamento || totalVendido;

  // CMV/margem só quando existe custo de ficha técnica processado — 0 de custo
  // significa "não calculado", não "custo zero" (evita margem falsa de 100%).
  const temCusto = custoTeorico > 0;
  const cmvTeorico = temCusto && base > 0 ? +(custoTeorico / base * 100).toFixed(2) : null;
  const margem = temCusto && base > 0 ? +((base - custoTeorico) / base * 100).toFixed(2) : null;

  // pendências (códigos distintos, para o número bater com a lista de vínculos)
  // combo resolvido por componentes não tem produto_id, mas tem custo > 0 — não é pendência
  const chave = (r) => String(r.codigo_sw || r.nome_sw || "").trim();
  const semVinculo = new Set(comerciais
    .filter((r) => !r.produto_id && !(r.tipo_item === "combo" && Number(r.custo_teorico) > 0))
    .map(chave)).size;
  const semFicha = new Set(comerciais.filter((r) => r.produto_id && !(Number(r.custo_teorico) > 0)).map(chave)).size;
  const vendasComCusto = sum(comerciais.filter((r) => Number(r.custo_teorico) > 0), (r) => r.valor_total);
  const coberturaCmv = totalVendido > 0 ? +(vendasComCusto / totalVendido * 100).toFixed(1) : null;

  // séries para os painéis da Visão Geral (sem dados fictícios: vazio = vazio)
  const porDiaMap = new Map();
  if (fat.length) for (const r of fat) porDiaMap.set(r.data_movimento, (porDiaMap.get(r.data_movimento) || 0) + (Number(r.faturamento) || Number(r.total) || 0));
  else for (const r of comerciais) porDiaMap.set(r.data_movimento, (porDiaMap.get(r.data_movimento) || 0) + (Number(r.valor_total) || 0));
  const porDia = [...porDiaMap.entries()].filter(([d]) => d).sort(([a], [b]) => a.localeCompare(b)).map(([data, valor]) => ({ data, valor: r2(valor) }));

  const canalMap = new Map();
  const fonteCanal = fat.length ? fat : comerciais;
  for (const r of fonteCanal) {
    const v = fat.length ? (Number(r.faturamento) || Number(r.total) || 0) : (Number(r.valor_total) || 0);
    canalMap.set(r.canal || "balcao", (canalMap.get(r.canal || "balcao") || 0) + v);
  }
  const porCanal = [...canalMap.entries()].map(([canal, valor]) => ({ canal, valor: r2(valor) })).sort((a, b) => b.valor - a.valor);

  const topMap = new Map();
  for (const r of comerciais) {
    const k = chave(r);
    const cur = topMap.get(k) || { nome: r.nome_sw || r.codigo_sw || "—", quantidade: 0, valor: 0 };
    cur.quantidade += Number(r.quantidade) || 0; cur.valor += Number(r.valor_total) || 0;
    topMap.set(k, cur);
  }
  const topProdutos = [...topMap.values()].sort((a, b) => b.quantidade - a.quantidade).slice(0, 5)
    .map((p) => ({ ...p, quantidade: Math.round(p.quantidade), valor: r2(p.valor) }));

  const grupoMap = new Map();
  for (const r of comerciais) { const g = r.grupo || "Sem grupo"; grupoMap.set(g, (grupoMap.get(g) || 0) + (Number(r.valor_total) || 0)); }
  const porGrupo = [...grupoMap.entries()].map(([grupo, valor]) => ({ grupo, valor: r2(valor) })).sort((a, b) => b.valor - a.valor);

  const datas = [...fat, ...prod].map((r) => r.data_movimento).filter(Boolean).sort();

  return {
    faturamentoBruto: r2(faturamentoBruto), faturamentoLiquido: r2(faturamento), totalVendido: r2(totalVendido),
    qtdProdutos: Math.round(qtdProdutos), descontos: r2(descontos), taxas: r2(taxas), diferenca: r2(diferenca),
    custoTeorico: r2(custoTeorico), cmvTeorico, margem, coberturaCmv,
    dias: fat.length, fechamentos: fat.length,
    temDados: fat.length > 0 || prod.length > 0,
    periodo: datas.length ? { de: datas[0], ate: datas[datas.length - 1] } : null,
    semVinculo, semFicha,
    porDia, porCanal, topProdutos, porGrupo,
  };
}
