import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { classificar, reconciliar, divergenciasDaReconciliacao, consolidarVisao } from "./vendas.calc.js";
import { lerFaturamento, lerProdutos, decodificarArquivo } from "./sw-parser.js";

const BUCKET = "vendas-relatorios";
const n = (v) => Number(v) || 0;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// ---------- normalização da entrada ----------
// A API aceita o relatório de duas formas:
//   a) arquivo original em base64 ({ nomeArquivo, conteudoBase64 }) -> parse AQUI no backend
//   b) já interpretado (integrações: SWFast/iFood mandam campos/linhas prontos)
async function normalizarRelatorios(payload) {
  let fat = payload.faturamento || null;
  let prod = payload.produtos || null;
  let bufFat = null, bufProd = null;
  if (fat?.conteudoBase64) {
    bufFat = decodificarArquivo(fat, "Análise de Faturamento");
    fat = await lerFaturamento(bufFat, fat.nomeArquivo || "faturamento.csv");
  }
  if (prod?.conteudoBase64) {
    bufProd = decodificarArquivo(prod, "Venda de Produtos por Grupo");
    prod = await lerProdutos(bufProd, prod.nomeArquivo || "produtos.csv");
  }
  return { fat, prod, bufFat, bufProd };
}

// componentes de combo da organização: codigo_sw -> [{produto_id, quantidade}]
async function carregarComponentes(organizacaoId) {
  const { data } = await supabase.from("sw_combo_componentes")
    .select("codigo_sw, produto_id, quantidade").eq("organizacao_id", organizacaoId);
  const mapa = new Map();
  for (const c of data || []) {
    const k = String(c.codigo_sw).trim();
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(c);
  }
  return mapa;
}

async function custosPorProduto(organizacaoId, ids) {
  const custoById = {};
  const unicos = [...new Set(ids)].filter(Boolean);
  if (!unicos.length) return custoById;
  const { data } = await supabase.from("produtos")
    .select("id, custo_cache").eq("organizacao_id", organizacaoId).in("id", unicos);
  for (const p of data || []) custoById[p.id] = n(p.custo_cache);
  return custoById;
}

// ---------- SERVIÇO CENTRAL (mesma lógica p/ manual, API ou iFood) ----------
export async function processarImportacaoVendas({ organizacaoId, unidadeId, payload, confirmar = false }) {
  if (!payload || (!payload.faturamento && !payload.produtos))
    throw ApiError.badRequest("Envie pelo menos um dos relatórios.");

  const canal = payload.canal || "balcao";
  const origem = payload.origem || "manual";
  const divergencias = [];
  const erros = [];

  const { fat, prod, bufFat, bufProd } = await normalizarRelatorios(payload);

  // datas de cada relatório
  const dFat = fat?.dataMovimento || payload.dataMovimento || null;
  const dProd = prod?.dataMovimento || payload.dataMovimento || null;
  const dataMovimento = dFat || dProd || null;
  if (!dataMovimento) erros.push("Não foi possível identificar a data do movimento nos relatórios.");

  // dedup por hash
  const hashes = [fat?.hash, prod?.hash].filter(Boolean);
  let duplicados = [];
  if (hashes.length) {
    const { data } = await supabase.from("importacoes_vendas")
      .select("id, tipo_relatorio, hash_arquivo, data_movimento")
      .eq("unidade_id", unidadeId).in("hash_arquivo", hashes);
    duplicados = data || [];
    for (const d of duplicados)
      divergencias.push({ tipo: "duplicidade", nivel: "critico", titulo: "Relatório já importado",
        descricao: `Este arquivo (${d.tipo_relatorio}) já foi importado em ${d.data_movimento || "?"}.` });
  }

  // mapa código -> produto + componentes de combos
  const [{ data: mapaRows }, componentesPorCodigo] = await Promise.all([
    supabase.from("sw_mapeamento_produtos")
      .select("codigo_sw, tipo_item, produto_id, ignorar_no_cmv, ignorar_no_estoque")
      .eq("organizacao_id", organizacaoId).eq("ativo", true),
    carregarComponentes(organizacaoId),
  ]);
  const mapa = new Map((mapaRows || []).map((m) => [String(m.codigo_sw).trim(), m]));

  // classifica linhas de produtos
  const linhasIn = prod?.linhas || [];
  const linhas = linhasIn.map((l) => {
    const c = classificar(l, mapa);
    const q = n(l.quantidade), vt = n(l.valorTotal);
    return {
      grupo: l.grupo || null, codigo_sw: l.codigoSw || null, nome_sw: l.nomeSw || null,
      quantidade: q, valor_total: vt, preco_medio: q ? +(vt / q).toFixed(4) : 0,
      tipo_item: c.tipoItem, produto_id: c.produtoId, ignorar_no_cmv: c.ignorarCmv, ignorar_no_estoque: c.ignorarEstoque,
      custo_teorico: null,
    };
  });

  // custo teórico: produto vinculado usa a ficha (custo_cache);
  // combo sem produto próprio usa a soma dos componentes.
  const idsVinc = linhas.filter((l) => l.produto_id).map((l) => l.produto_id);
  const idsComp = [...componentesPorCodigo.values()].flat().map((c) => c.produto_id);
  const custoById = await custosPorProduto(organizacaoId, [...idsVinc, ...idsComp]);

  const custoUnitario = (l) => {
    if (l.produto_id) return custoById[l.produto_id] ?? 0;
    const comps = componentesPorCodigo.get(String(l.codigo_sw || "").trim());
    if (l.tipo_item === "combo" && comps?.length)
      return comps.reduce((s, c) => s + (custoById[c.produto_id] || 0) * n(c.quantidade), 0);
    return null; // sem vínculo nenhum
  };
  for (const l of linhas) {
    const cu = custoUnitario(l);
    if (cu == null) continue;
    l.custo_teorico = +(cu * l.quantidade).toFixed(4);
    if (l.tipo_item === "combo" && !l.produto_id) l.ignorar_no_cmv = false;
    if (!cu) divergencias.push({ tipo: "sem_ficha", nivel: "atencao", titulo: "Produto sem ficha técnica",
      descricao: `"${l.nome_sw}" está vinculado mas o custo é 0 (sem ficha técnica).` });
  }

  // não vinculados (produtos comerciais sem produto nem componentes)
  const comerciais = linhas.filter((l) => l.tipo_item === "produto" || l.tipo_item === "combo");
  const semVinculo = comerciais.filter((l) => custoUnitario(l) == null);
  const etapasIgnoradas = linhas.filter((l) => l.tipo_item === "etapa" || l.tipo_item === "taxa_desconto");
  for (const l of semVinculo)
    divergencias.push({ tipo: "sem_vinculo", nivel: "atencao", titulo: "Produto sem vínculo",
      descricao: `"${l.nome_sw}" (${l.codigo_sw || "sem código"}) ainda não está vinculado a um produto do sistema.` });

  // reconciliação entre os dois relatórios
  const reconciliacao = reconciliar(fat, linhas, { dataFat: fat && prod ? dFat : null, dataProd: fat && prod ? dProd : null });
  divergencias.push(...divergenciasDaReconciliacao(reconciliacao));

  // valores
  const somaProdutos = comerciais.reduce((s, l) => s + l.valor_total, 0);
  const custoTeoricoTotal = linhas.filter((l) => !l.ignorar_no_cmv).reduce((s, l) => s + (l.custo_teorico || 0), 0);
  const faturamentoDia = fat ? (n(fat.faturamento) || n(fat.total) || 0) : somaProdutos;
  const cmvTeorico = custoTeoricoTotal > 0 && faturamentoDia > 0 ? +(custoTeoricoTotal / faturamentoDia * 100).toFixed(2) : null;

  if (fat && n(fat.diferenca) < 0) {
    divergencias.push({ tipo: "diferenca_negativa", nivel: "info", titulo: "Diferença de fechamento negativa",
      descricao: `Diferença de R$ ${n(fat.diferenca).toFixed(2)} no fechamento.` });
  }

  const preview = {
    dataMovimento, canal, origem,
    faturamentoEncontrado: r2(faturamentoDia),
    totalItens: linhas.length,
    produtosComerciais: comerciais.length,
    etapasIgnoradas: etapasIgnoradas.length,
    semVinculo: semVinculo.length,
    duplicidades: duplicados.length,
    custoTeoricoTotal: r2(custoTeoricoTotal),
    cmvTeorico,
    reconciliacao,
    divergencias,
    erros,
    temFaturamento: !!fat,
    temProdutos: !!prod,
  };

  if (!confirmar) return { preview, persistido: false };
  if (duplicados.length) throw ApiError.badRequest("Este relatório já foi importado anteriormente.");
  if (erros.length) throw ApiError.badRequest(erros[0]);

  // ---------- PERSISTE ----------
  // guarda o arquivo original no Storage (falha de storage não bloqueia a importação)
  const [storageFat, storageProd] = await Promise.all([
    uploadOriginal({ buf: bufFat, unidadeId, dataMovimento, tipo: "faturamento", arq: fat }),
    uploadOriginal({ buf: bufProd, unidadeId, dataMovimento, tipo: "produtos_grupo", arq: prod }),
  ]);

  const importacoesCriadas = [];
  const gravarImportacao = async (tipo_relatorio, arq, storagePath) => {
    const { data, error } = await supabase.from("importacoes_vendas").insert({
      unidade_id: unidadeId, origem, canal, data_movimento: dataMovimento, tipo_relatorio,
      nome_arquivo: arq?.nomeArquivo || null, hash_arquivo: arq?.hash || null,
      arquivo_storage: storagePath || null, observacao: payload.observacao || null,
      status: "concluida", total_registros: tipo_relatorio === "produtos_grupo" ? linhas.length : 1,
      valor_total: tipo_relatorio === "produtos_grupo" ? r2(somaProdutos) : r2(faturamentoDia),
    }).select("id").single();
    if (error) throw ApiError.badRequest(error.message);
    importacoesCriadas.push({ tipo: tipo_relatorio, id: data.id });
    return data.id;
  };

  let impFatId = null, impProdId = null;
  if (fat) impFatId = await gravarImportacao("faturamento", fat, storageFat);
  if (prod) impProdId = await gravarImportacao("produtos_grupo", prod, storageProd);

  if (fat) {
    const { error } = await supabase.from("sw_faturamento_diario").upsert({
      unidade_id: unidadeId, importacao_id: impFatId, data_movimento: dataMovimento,
      produtos: n(fat.produtos), repiques: n(fat.repiques), servicos: n(fat.servicos),
      taxas_entrega: n(fat.taxasEntrega), creditos: n(fat.creditos), descontos: n(fat.descontos),
      combos: n(fat.combos), especiais: n(fat.especiais), cortesias: n(fat.cortesias),
      assinadas: n(fat.assinadas), total: n(fat.total), faturamento: n(fat.faturamento),
      diferenca: n(fat.diferenca), origem, canal,
    }, { onConflict: "unidade_id,data_movimento,canal,origem" });
    if (error) throw ApiError.badRequest(error.message);
  }

  if (prod && linhas.length) {
    const rows = linhas.map((l) => ({ ...l, unidade_id: unidadeId, importacao_id: impProdId, data_movimento: dataMovimento, origem, canal }));
    const { error } = await supabase.from("sw_produtos_vendidos").insert(rows);
    if (error) throw ApiError.badRequest(error.message);
  }

  const impRefId = impProdId || impFatId;
  if (divergencias.length && impRefId) {
    const rows = divergencias.map((d) => ({ unidade_id: unidadeId, importacao_id: impRefId, ...d }));
    await supabase.from("divergencias_vendas").insert(rows).then(({ error }) => { if (error) console.warn("[vendas] divergências:", error.message); });
  }

  return { preview, persistido: true, importacoes: importacoesCriadas };
}

async function uploadOriginal({ buf, unidadeId, dataMovimento, tipo, arq }) {
  if (!buf || !arq) return null;
  const nome = String(arq.nomeArquivo || "arquivo").replace(/[^\w.\-]+/g, "_").slice(-80);
  const path = `${unidadeId}/${dataMovimento || "sem-data"}/${tipo}-${String(arq.hash || "").slice(0, 10)}-${nome}`;
  const tipos = { pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel", csv: "text/csv" };
  const ext = nome.toLowerCase().split(".").pop();
  const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: tipos[ext] || "application/octet-stream", upsert: true });
  if (error) { console.warn(`[vendas] storage (${BUCKET}):`, error.message, "— importação segue sem o arquivo original."); return null; }
  return path;
}

// link temporário para baixar o arquivo original de uma importação
export async function arquivoOriginal({ unidadeId, importacaoId }) {
  const { data: imp } = await supabase.from("importacoes_vendas")
    .select("id, nome_arquivo, arquivo_storage").eq("unidade_id", unidadeId).eq("id", importacaoId).single();
  if (!imp) throw ApiError.notFound("Importação não encontrada.");
  if (!imp.arquivo_storage) throw ApiError.notFound("Esta importação não tem o arquivo original guardado.");
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(imp.arquivo_storage, 3600);
  if (error) throw ApiError.internal("Falha ao gerar o link do arquivo: " + error.message);
  return { url: data.signedUrl, nomeArquivo: imp.nome_arquivo };
}

// ---------- CONSULTAS ----------
function aplicarFiltros(q, filtros = {}) {
  if (filtros.de) q = q.gte("data_movimento", filtros.de);
  if (filtros.ate) q = q.lte("data_movimento", filtros.ate);
  if (filtros.canal && filtros.canal !== "todos") q = q.eq("canal", filtros.canal);
  if (filtros.origem && filtros.origem !== "todos") q = q.eq("origem", filtros.origem);
  return q;
}

export async function visaoGeral({ unidadeId, filtros }) {
  let qf = supabase.from("sw_faturamento_diario")
    .select("data_movimento, canal, origem, total, faturamento, descontos, taxas_entrega, diferenca")
    .eq("unidade_id", unidadeId);
  qf = aplicarFiltros(qf, filtros);

  let qp = supabase.from("sw_produtos_vendidos")
    .select("data_movimento, canal, grupo, codigo_sw, nome_sw, quantidade, valor_total, custo_teorico, ignorar_no_cmv, tipo_item, produto_id")
    .eq("unidade_id", unidadeId);
  qp = aplicarFiltros(qp, filtros);

  const [rf, rp, rUlt, rImp, rDiv] = await Promise.all([
    qf, qp,
    supabase.from("importacoes_vendas").select("criado_em, status, tipo_relatorio, data_movimento")
      .eq("unidade_id", unidadeId).order("criado_em", { ascending: false }).limit(1),
    supabase.from("importacoes_vendas").select("id", { count: "exact", head: true }).eq("unidade_id", unidadeId),
    supabase.from("divergencias_vendas").select("id", { count: "exact", head: true }).eq("unidade_id", unidadeId).eq("resolvida", false),
  ]);
  if (rf.error) throw ApiError.internal(rf.error.message);
  if (rp.error) throw ApiError.internal(rp.error.message);

  const base = consolidarVisao(rf.data || [], rp.data || []);
  const ultima = rUlt.data?.[0] || null;
  return {
    ...base,
    ultimaImportacao: ultima ? { criadoEm: ultima.criado_em, status: ultima.status, tipo: ultima.tipo_relatorio, dataMovimento: ultima.data_movimento } : null,
    contadores: { itens: (rp.data || []).length, importacoes: rImp.count ?? null, divergencias: rDiv.count ?? null },
  };
}

export async function listarFaturamento({ unidadeId, filtros }) {
  let q = supabase.from("sw_faturamento_diario").select("*").eq("unidade_id", unidadeId).order("data_movimento", { ascending: false }).limit(400);
  q = aplicarFiltros(q, filtros);
  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);
  return data;
}

export async function listarProdutosVendidos({ unidadeId, filtros }) {
  let q = supabase.from("sw_produtos_vendidos")
    .select("id, data_movimento, grupo, codigo_sw, nome_sw, quantidade, valor_total, preco_medio, tipo_item, produto_id, custo_teorico, ignorar_no_cmv, origem, canal, produtos(nome)")
    .eq("unidade_id", unidadeId).order("valor_total", { ascending: false }).limit(1000);
  q = aplicarFiltros(q, filtros);
  if (filtros?.grupo && filtros.grupo !== "todos") q = q.eq("grupo", filtros.grupo);
  if (filtros?.tipo && filtros.tipo !== "todos") q = q.eq("tipo_item", filtros.tipo);
  if (filtros?.vinculo === "vinculados") q = q.not("produto_id", "is", null);
  if (filtros?.vinculo === "nao") q = q.is("produto_id", null);
  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);
  return (data || []).map((r) => ({ ...r, produto_nome: r.produtos?.nome || null, cmv_pct: r.valor_total > 0 && r.custo_teorico != null ? +(r.custo_teorico / r.valor_total * 100).toFixed(1) : null }));
}

export async function listarImportacoes({ unidadeId }) {
  const { data, error } = await supabase.from("importacoes_vendas").select("*").eq("unidade_id", unidadeId).order("criado_em", { ascending: false }).limit(200);
  if (error) throw ApiError.internal(error.message);
  return data;
}

// Exclui uma importação. As linhas de faturamento/produtos/divergências dela
// caem por ON DELETE CASCADE (importacao_id). O arquivo no Storage também é removido.
export async function excluirImportacao({ unidadeId, importacaoId }) {
  const { data: imp } = await supabase.from("importacoes_vendas")
    .select("id, arquivo_storage").eq("unidade_id", unidadeId).eq("id", importacaoId).single();
  if (!imp) throw ApiError.notFound("Importação não encontrada.");
  const { error } = await supabase.from("importacoes_vendas").delete()
    .eq("id", importacaoId).eq("unidade_id", unidadeId);
  if (error) throw ApiError.badRequest(error.message);
  if (imp.arquivo_storage) {
    await supabase.storage.from(BUCKET).remove([imp.arquivo_storage])
      .then(({ error: e }) => { if (e) console.warn("[vendas] storage remove:", e.message); });
  }
  return { id: importacaoId };
}

export async function listarDivergencias({ unidadeId }) {
  const { data, error } = await supabase.from("divergencias_vendas").select("*").eq("unidade_id", unidadeId).order("criado_em", { ascending: false }).limit(300);
  if (error) throw ApiError.internal(error.message);
  return data;
}

// marca/desmarca uma divergência como resolvida
export async function resolverDivergencia({ unidadeId, divergenciaId, resolvida = true }) {
  const { data, error } = await supabase.from("divergencias_vendas")
    .update({ resolvida: !!resolvida, resolvida_em: resolvida ? new Date().toISOString() : null })
    .eq("unidade_id", unidadeId).eq("id", divergenciaId).select("id, resolvida").single();
  if (error || !data) throw ApiError.notFound("Divergência não encontrada.");
  return data;
}

// ---------- VÍNCULOS ----------
// aplica um vínculo (produto direto e/ou componentes de combo) e recalcula
// o custo teórico dos registros já importados desse código.
async function aplicarVinculo({ organizacaoId, unidadeId, item }) {
  const codigoSw = String(item.codigoSw || "").trim();
  if (!codigoSw) throw ApiError.badRequest("Código do SW é obrigatório.");
  const tipoItem = item.tipoItem || "produto";
  const produtoId = item.produtoId || null;
  const componentes = (item.componentes || []).filter((c) => c.produtoId && n(c.quantidade) > 0);
  const temVinculo = !!produtoId || (tipoItem === "combo" && componentes.length > 0);

  const { error: e1 } = await supabase.from("sw_mapeamento_produtos").upsert({
    organizacao_id: organizacaoId, codigo_sw: codigoSw, nome_sw: item.nomeSw || null,
    tipo_item: tipoItem, produto_id: produtoId,
    ignorar_no_cmv: !temVinculo,
    ignorar_no_estoque: !temVinculo,
    ativo: true, updated_at: new Date().toISOString(),
  }, { onConflict: "organizacao_id,codigo_sw" });
  if (e1) throw ApiError.badRequest(e1.message);

  // componentes do combo: substitui o conjunto anterior
  await supabase.from("sw_combo_componentes").delete()
    .eq("organizacao_id", organizacaoId).eq("codigo_sw", codigoSw);
  if (tipoItem === "combo" && componentes.length) {
    const { error: e2 } = await supabase.from("sw_combo_componentes").insert(
      componentes.map((c) => ({ organizacao_id: organizacaoId, codigo_sw: codigoSw, produto_id: c.produtoId, quantidade: n(c.quantidade) || 1 })));
    if (e2) throw ApiError.badRequest(e2.message);
  }

  // custo unitário do vínculo
  const custoById = await custosPorProduto(organizacaoId, [produtoId, ...componentes.map((c) => c.produtoId)]);
  const custoUnit = produtoId
    ? (custoById[produtoId] || 0)
    : componentes.reduce((s, c) => s + (custoById[c.produtoId] || 0) * n(c.quantidade), 0);

  const { data: regs } = await supabase.from("sw_produtos_vendidos")
    .select("id, quantidade").eq("unidade_id", unidadeId).eq("codigo_sw", codigoSw);
  await Promise.all((regs || []).map((r) =>
    supabase.from("sw_produtos_vendidos").update({
      produto_id: produtoId, tipo_item: tipoItem,
      custo_teorico: temVinculo ? +(custoUnit * n(r.quantidade)).toFixed(4) : null,
      ignorar_no_cmv: tipoItem === "etapa" || tipoItem === "taxa_desconto" ? true : !temVinculo,
      ignorar_no_estoque: !temVinculo,
    }).eq("id", r.id)));
  return { codigoSw, atualizados: (regs || []).length };
}

export async function vincularProduto({ organizacaoId, unidadeId, codigoSw, produtoId, tipoItem, nomeSw, componentes }) {
  const r = await aplicarVinculo({ organizacaoId, unidadeId, item: { codigoSw, produtoId, tipoItem, nomeSw, componentes } });
  return { ok: true, atualizados: r.atualizados };
}

// vínculo em massa: vários códigos de uma vez (modal "Vincular em massa")
export async function vincularLote({ organizacaoId, unidadeId, itens }) {
  if (!Array.isArray(itens) || !itens.length) throw ApiError.badRequest("Envie a lista de vínculos.");
  if (itens.length > 200) throw ApiError.badRequest("Máximo de 200 vínculos por lote.");
  const resultados = [];
  for (const item of itens) {
    try {
      const r = await aplicarVinculo({ organizacaoId, unidadeId, item });
      resultados.push({ codigoSw: r.codigoSw, ok: true, atualizados: r.atualizados });
    } catch (e) {
      resultados.push({ codigoSw: item.codigoSw, ok: false, erro: e.message });
    }
  }
  return { total: itens.length, sucesso: resultados.filter((r) => r.ok).length, resultados };
}

// componentes atuais de um combo (para editar no modal de vínculo)
export async function listarComponentes({ organizacaoId, codigoSw }) {
  const { data, error } = await supabase.from("sw_combo_componentes")
    .select("produto_id, quantidade, produtos(nome, tamanho)")
    .eq("organizacao_id", organizacaoId).eq("codigo_sw", String(codigoSw).trim());
  if (error) throw ApiError.internal(error.message);
  return (data || []).map((c) => ({ produtoId: c.produto_id, quantidade: Number(c.quantidade), nome: c.produtos?.nome || null, tamanho: c.produtos?.tamanho || null }));
}
