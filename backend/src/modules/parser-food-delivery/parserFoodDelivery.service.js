// Serviço central do Parser Food Delivery — import preview/confirm SEM
// estado no servidor (mesmo padrão de bonificacaoMensal.service.js): o
// frontend reenvia o arquivo em base64 a cada chamada, nada fica "em
// rascunho" no backend entre a prévia e a confirmação.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { lerRelatorio, decodificarArquivo } from "./parserFoodDelivery.parser.js";
import { classificarPedido, resumoConciliacao, agruparPorEntregador, validarCodigo, temEntregador } from "./parserFoodDelivery.calc.js";
import { classificarOperacao, OPERACAO, rotuloOperacao } from "./parserFoodDelivery.operacao.js";

const TABELA_IMPORT = "parser_fd_importacoes";
const TABELA_PEDIDOS = "parser_fd_pedidos";
const TABELA_AUDIT = "parser_fd_auditoria";
const BUCKET = "parser-food-delivery";

// Colunas de fato usadas por paraApiPedido()/paraApiPedidoIgnorado() (+ as 3
// datas de entrega, guardadas de propósito pra uma futura métrica de tempo
// médio — ver migration 037). De propósito SEM `dados_brutos`: é a linha
// original completa do relatório (auditoria, nunca lida de volta pela API) —
// um pedido de food delivery real chega a alguns KB de JSON cada; um
// relatório com centenas/milhares de pedidos multiplicava isso à toa em
// TODA visualização de uma importação (era a causa do carregamento lento ao
// abrir o Parser Food Delivery). Continua gravada no insert, só não é mais
// buscada de volta nas leituras — quem precisar dela de verdade, consulta o
// banco diretamente.
const COLUNAS_PEDIDO_LEITURA = [
  "id", "importacao_id", "numero_pedido", "data_hora", "situacao", "entregador",
  "taxa_entregador", "valor_total_pedido", "forma_pagamento", "razao_cancelamento",
  "justificativa_cancelamento", "data_entregue", "data_finalizado", "data_cancelado",
  "origem", "sem_taxa_informado", "status_conciliacao", "operacao", "operacao_motivo",
  "detalhes_pedido", "criado_em",
].join(", ");

/** Number(x), mas preserva null/undefined — "não informado" nunca vira 0. */
const numOuNulo = (x) => (x == null ? null : Number(x));

// ---------------------------------------------------------------------------
// UNIDADE-ALVO — mesmo princípio do Dashboard iFood/Bonificação Mensal:
// nunca confia em unidadeId vindo do cliente sem checar contra a sessão.
// ---------------------------------------------------------------------------
async function resolverUnidade({ organizacaoId, unidadeId }) {
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para acessar o Parser Food Delivery.");
  const { data: unidade, error } = await supabase.from("unidades").select("id, nome, organizacao_id").eq("id", unidadeId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!unidade || unidade.organizacao_id !== organizacaoId) throw ApiError.forbidden("Você não tem acesso a esta unidade.");
  return unidade;
}

// ---------------------------------------------------------------------------
// MAPEAMENTO DB <-> API
// ---------------------------------------------------------------------------
function paraApiImportacao(row) {
  return {
    id: row.id, unidadeId: row.unidade_id,
    periodoInicio: row.periodo_inicio, periodoFim: row.periodo_fim,
    nomeArquivo: row.nome_arquivo,
    totalPedidos: row.total_pedidos,
    pedidosSubway: row.pedidos_subway, pedidosAcai: row.pedidos_acai, pedidosRevisao: row.pedidos_revisao,
    pedidosSemEntregador: row.pedidos_sem_entregador,
    colunaDetalhesEncontrada: row.coluna_detalhes_encontrada,
    entregues: row.entregues, cancelados: row.cancelados,
    canceladosComTaxa: row.cancelados_com_taxa, canceladosSemTaxa: row.cancelados_sem_taxa,
    taxasBrutas: numOuNulo(row.taxas_brutas), taxasDescartadas: numOuNulo(row.taxas_descartadas), taxasValidas: numOuNulo(row.taxas_validas),
    codigosSemTaxa: row.codigos_sem_taxa || [],
    status: row.status, mensagemErro: row.mensagem_erro,
    usuarioNome: row.usuario_nome, criadoEm: row.criado_em, atualizadoEm: row.atualizado_em,
  };
}

/** Aceita tanto uma linha do banco (status_conciliacao) quanto um pedido recém-classificado (statusConciliacao). */
function paraApiPedido(row) {
  return {
    id: row.id ?? null, numeroPedido: row.numero_pedido ?? row.numeroPedido, dataHora: row.data_hora ?? row.dataHora,
    situacao: row.situacao, entregador: row.entregador,
    taxaEntregador: numOuNulo(row.taxa_entregador ?? row.taxaEntregador),
    valorTotalPedido: numOuNulo(row.valor_total_pedido ?? row.valorTotalPedido),
    formaPagamento: row.forma_pagamento ?? row.formaPagamento,
    razaoCancelamento: row.razao_cancelamento ?? row.razaoCancelamento,
    justificativaCancelamento: row.justificativa_cancelamento ?? row.justificativaCancelamento,
    origem: row.origem,
    detalhesPedido: row.detalhes_pedido ?? row.detalhesPedido ?? null,
    operacao: row.operacao ?? OPERACAO.SUBWAY,
    operacaoMotivo: row.operacao_motivo ?? row.operacaoMotivo ?? null,
    semTaxaInformado: row.semTaxaInformado ?? !!row.sem_taxa_informado,
    statusConciliacao: row.statusConciliacao ?? row.status_conciliacao ?? null,
  };
}

/** Só entra na conciliação/cálculos/entregadores: Subway E com entregador atribuído. */
const ehElegivelConciliacao = (p) => p.operacao === OPERACAO.SUBWAY && temEntregador(p.entregador);

/**
 * Pedido "ignorado" (fora da conciliação) sempre por UM de dois motivos:
 * outra operação, ou Subway sem entregador atribuído. Unifica os dois numa
 * única forma de exibição pra "Ver pedidos ignorados" — a razão de cada um
 * fica clara sem precisar duas telas diferentes.
 */
function paraApiPedidoIgnorado(p) {
  const base = paraApiPedido(p);
  if (base.operacao !== OPERACAO.SUBWAY) {
    return { ...base, classificacaoIgnorado: rotuloOperacao(base.operacao), motivoIgnorado: base.operacaoMotivo };
  }
  return {
    ...base, classificacaoIgnorado: "Sem entregador",
    motivoIgnorado: "Pedido sem nome de entregador atribuído — não entra na conciliação nem nos valores financeiros.",
  };
}

const fmtDataHoraBr = (iso) => { try { return new Date(iso).toLocaleString("pt-BR"); } catch { return iso; } };

function contarPorSituacao(pedidos) {
  const contagem = {};
  for (const p of pedidos) { const chave = p.situacao || "—"; contagem[chave] = (contagem[chave] || 0) + 1; }
  return contagem;
}

// ---------------------------------------------------------------------------
// IDENTIFICAÇÃO DA OPERAÇÃO — camada única (parserFoodDelivery.operacao.js).
// Roda logo depois do parsing e ANTES de qualquer cálculo — ordem obrigatória
// do pedido: Arquivo bruto -> Identificação da operação -> Remover Açaí ->
// Pedidos válidos Subway -> Conciliação -> Cálculos -> Entregadores. Nunca
// calcular primeiro e filtrar depois.
// ---------------------------------------------------------------------------
function classificarOperacoes(pedidos, colunaDetalhesEncontrada) {
  if (!colunaDetalhesEncontrada) {
    // Sem a coluna "Detalhes do pedido" não dá pra separar por operação —
    // melhor avisar (colunaDetalhesEncontrada=false na resposta) do que
    // fingir certeza jogando tudo em "revisão necessária".
    return pedidos.map((p) => ({ ...p, operacao: OPERACAO.SUBWAY, operacaoMotivo: null }));
  }
  return pedidos.map((p) => {
    const r = classificarOperacao(p);
    return { ...p, operacao: r.operacao, operacaoMotivo: r.motivo };
  });
}

/**
 * `subway` aqui já é só quem REALMENTE entra na conciliação (Subway + com
 * entregador) — `semEntregador` é o contador à parte de quem é Subway mas
 * ficou de fora só por falta de entregador (item novo do pedido).
 */
function resumoFiltragem(pedidosComOperacao) {
  const subwayTodos = pedidosComOperacao.filter((p) => p.operacao === OPERACAO.SUBWAY);
  const semEntregador = subwayTodos.filter((p) => !temEntregador(p.entregador));
  return {
    subway: subwayTodos.length - semEntregador.length,
    semEntregador: semEntregador.length,
    acaiNoGrau: pedidosComOperacao.filter((p) => p.operacao === OPERACAO.ACAI_NO_GRAU).length,
    revisaoNecessaria: pedidosComOperacao.filter((p) => p.operacao === OPERACAO.REVISAO_NECESSARIA).length,
  };
}

// ---------------------------------------------------------------------------
// PASSO 1 — só lê e valida o arquivo (item 1 do pedido: formato/período/qtd).
// ---------------------------------------------------------------------------
export async function previewArquivo({ organizacaoId, unidadeId, arquivo }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const buf = decodificarArquivo(arquivo);
  const relatorio = await lerRelatorio(buf, arquivo?.nomeArquivo);
  const pedidosComOperacao = classificarOperacoes(relatorio.pedidos, relatorio.colunaDetalhesEncontrada);
  return {
    unidade: { id: unidade.id, nome: unidade.nome },
    nomeArquivo: relatorio.nomeArquivo, hash: relatorio.hash,
    periodoInicio: relatorio.periodoInicio, periodoFim: relatorio.periodoFim, periodoDetectado: relatorio.periodoDetectado,
    totalPedidos: relatorio.pedidos.length, porSituacao: contarPorSituacao(relatorio.pedidos),
    colunasEncontradas: relatorio.colunasEncontradas,
    colunaDetalhesEncontrada: relatorio.colunaDetalhesEncontrada,
    filtragem: resumoFiltragem(pedidosComOperacao),
  };
}

async function avisosDuplicidade({ unidadeId, hash, periodoInicio, periodoFim }) {
  const { data: porHash } = await supabase.from(TABELA_IMPORT).select("id, nome_arquivo, criado_em")
    .eq("unidade_id", unidadeId).eq("hash_arquivo", hash).eq("status", "concluida").maybeSingle();

  let periodosSobrepostos = [];
  if (periodoInicio && periodoFim) {
    const { data } = await supabase.from(TABELA_IMPORT).select("id, periodo_inicio, periodo_fim, nome_arquivo")
      .eq("unidade_id", unidadeId).eq("status", "concluida")
      .lte("periodo_inicio", periodoFim).gte("periodo_fim", periodoInicio);
    periodosSobrepostos = (data || []).map((r) => ({ id: r.id, periodoInicio: r.periodo_inicio, periodoFim: r.periodo_fim, nomeArquivo: r.nome_arquivo }));
  }
  return {
    hashDuplicado: porHash ? { id: porHash.id, nomeArquivo: porHash.nome_arquivo, criadoEm: porHash.criado_em } : null,
    periodosSobrepostos,
  };
}

// ---------------------------------------------------------------------------
// PASSO 2/3 — reparseia + classifica com os códigos "sem taxa" informados.
// Chamado a cada mudança na lista de códigos (idempotente, nunca salva).
// ---------------------------------------------------------------------------
export async function conciliarPreview({ organizacaoId, unidadeId, arquivo, codigosSemTaxa = [], periodoInicioManual, periodoFimManual }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const buf = decodificarArquivo(arquivo);
  const relatorio = await lerRelatorio(buf, arquivo?.nomeArquivo);

  const periodoInicio = relatorio.periodoInicio || v.dataOpcional(periodoInicioManual, "Período inicial");
  const periodoFim = relatorio.periodoFim || v.dataOpcional(periodoFimManual, "Período final");

  // Identificação da operação -> remoção do que não é Subway -> remoção de
  // quem não tem entregador atribuído -> só então "pedidos válidos" entram
  // na conciliação/cálculo/entregadores (ordem obrigatória do pedido).
  const todosPedidos = classificarOperacoes(relatorio.pedidos, relatorio.colunaDetalhesEncontrada);
  const pedidosElegiveis = todosPedidos.filter(ehElegivelConciliacao);
  const pedidosIgnorados = todosPedidos.filter((p) => !ehElegivelConciliacao(p));

  const codigosSet = new Set((codigosSemTaxa || []).map((c) => String(c).trim()).filter(Boolean));
  // Validação do código contra TODOS os pedidos (não só os elegíveis) — só
  // assim dá pra avisar "este código é de outra operação"/"sem entregador"
  // em vez de "não encontrado".
  const pedidosPorNumero = new Map(todosPedidos.map((p) => [p.numeroPedido, p]));
  const validacaoCodigos = [...codigosSet].map((c) => validarCodigo(c, pedidosPorNumero));

  // Conciliação + cálculos de taxas + desempenho dos entregadores: só nos
  // pedidos elegíveis (Subway + com entregador).
  const classificados = pedidosElegiveis.map((p) => ({
    ...p, statusConciliacao: classificarPedido(p, codigosSet), semTaxaInformado: codigosSet.has(p.numeroPedido),
  }));
  const resumo = resumoConciliacao(classificados);
  const entregadores = agruparPorEntregador(classificados).sort((a, b) => b.taxasValidas - a.taxasValidas);
  const avisos = await avisosDuplicidade({ unidadeId, hash: relatorio.hash, periodoInicio, periodoFim });

  return {
    unidade: { id: unidade.id, nome: unidade.nome },
    nomeArquivo: relatorio.nomeArquivo, hash: relatorio.hash,
    periodoInicio, periodoFim, periodoDetectado: relatorio.periodoDetectado,
    colunaDetalhesEncontrada: relatorio.colunaDetalhesEncontrada,
    filtragem: resumoFiltragem(todosPedidos),
    codigosSemTaxa: [...codigosSet], validacaoCodigos,
    resumo, entregadores,
    pedidos: classificados.map(paraApiPedido),
    pedidosIgnorados: pedidosIgnorados.map(paraApiPedidoIgnorado),
    avisos,
  };
}

async function uploadOriginal({ buf, unidadeId, hash, nomeArquivo }) {
  const nome = String(nomeArquivo || "relatorio.xlsx").replace(/[^\w.\-]+/g, "_").slice(-80);
  const path = `${unidadeId}/${String(hash || "").slice(0, 10)}-${nome}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: "application/octet-stream", upsert: true });
  if (error) { console.warn("[parser-food-delivery] storage:", error.message, "— importação segue sem o arquivo original."); return null; }
  return path;
}

async function registrarAuditoria({ importacaoId, organizacaoId, unidadeId, acao, codigosAntes = null, codigosDepois = null, taxasValidasAntes = null, taxasValidasDepois = null, motivo = null, snapshot = null, usuario }) {
  const { error } = await supabase.from(TABELA_AUDIT).insert({
    importacao_id: importacaoId, organizacao_id: organizacaoId, unidade_id: unidadeId, acao,
    codigos_antes: codigosAntes, codigos_depois: codigosDepois,
    taxas_validas_antes: taxasValidasAntes, taxas_validas_depois: taxasValidasDepois,
    motivo, snapshot,
    usuario_id: usuario?.id || null, usuario_nome: usuario?.nome || null, usuario_email: usuario?.email || null,
  });
  if (error) console.error("[parser-food-delivery] falha ao registrar auditoria:", error.message);
}

async function inserirPedidosEmLotes(linhas) {
  const TAM = 500;
  for (let i = 0; i < linhas.length; i += TAM) {
    const { error } = await supabase.from(TABELA_PEDIDOS).insert(linhas.slice(i, i + TAM));
    if (error) {
      // "N Pedido" pode se repetir dentro do mesmo relatório (visto em produção) —
      // a unicidade errada foi removida na migration 040. Se este erro ainda
      // aparecer, é porque a migration não foi aplicada nesta base.
      if (String(error.message).toLowerCase().includes("uq_pfdped_importacao_pedido")) {
        throw ApiError.badRequest("Este relatório tem códigos de pedido repetidos, e o banco ainda não está atualizado pra aceitar isso — aplique a migration 040_parser_fd_remove_unique_pedido.sql no Supabase e tente novamente.");
      }
      throw ApiError.internal(`Falha ao gravar pedidos: ${error.message}`);
    }
  }
}

function paraLinhaPedido(p, { importacaoId, organizacaoId, unidadeId }) {
  return {
    importacao_id: importacaoId, organizacao_id: organizacaoId, unidade_id: unidadeId,
    numero_pedido: p.numeroPedido, data_hora: p.dataHora, situacao: p.situacao, entregador: p.entregador,
    taxa_entregador: p.taxaEntregador, valor_total_pedido: p.valorTotalPedido, forma_pagamento: p.formaPagamento,
    razao_cancelamento: p.razaoCancelamento, justificativa_cancelamento: p.justificativaCancelamento,
    data_entregue: p.dataEntregue, data_finalizado: p.dataFinalizado, data_cancelado: p.dataCancelado,
    origem: p.origem, sem_taxa_informado: p.semTaxaInformado, status_conciliacao: p.statusConciliacao ?? null,
    operacao: p.operacao, operacao_motivo: p.operacaoMotivo, detalhes_pedido: p.detalhesPedido,
    dados_brutos: p.dadosBrutos,
  };
}

// ---------------------------------------------------------------------------
// CONFIRMAÇÃO — persiste importação + pedidos + arquivo original + auditoria.
// Bloqueia reimportar o MESMO arquivo (mesmo hash) para a mesma unidade.
// ---------------------------------------------------------------------------
export async function confirmarImportacao({ organizacaoId, unidadeId, usuario, arquivo, codigosSemTaxa = [], periodoInicioManual, periodoFimManual }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const buf = decodificarArquivo(arquivo);
  const relatorio = await lerRelatorio(buf, arquivo?.nomeArquivo);

  const periodoInicio = relatorio.periodoInicio || v.dataOpcional(periodoInicioManual, "Período inicial");
  const periodoFim = relatorio.periodoFim || v.dataOpcional(periodoFimManual, "Período final");
  if (!periodoInicio || !periodoFim) {
    throw ApiError.badRequest("Não consegui determinar o período deste relatório automaticamente. Informe o período inicial e final antes de confirmar.");
  }

  const { data: existente } = await supabase.from(TABELA_IMPORT).select("id, nome_arquivo, criado_em")
    .eq("unidade_id", unidadeId).eq("hash_arquivo", relatorio.hash).eq("status", "concluida").maybeSingle();
  if (existente) {
    throw ApiError.badRequest(`Este arquivo já foi importado (${existente.nome_arquivo || "importação"}, em ${fmtDataHoraBr(existente.criado_em)}). Para corrigir os códigos "cancelado sem taxa", edite a importação já salva em vez de reenviar o arquivo.`);
  }

  // Identificação da operação -> remoção do que não é Subway -> remoção de
  // quem não tem entregador atribuído -> só então conciliar/calcular/persistir
  // (ordem obrigatória do pedido).
  const todosPedidos = classificarOperacoes(relatorio.pedidos, relatorio.colunaDetalhesEncontrada);
  const codigosSet = new Set((codigosSemTaxa || []).map((c) => String(c).trim()).filter(Boolean));
  const pedidosProcessados = todosPedidos.map((p) => (ehElegivelConciliacao(p)
    ? { ...p, statusConciliacao: classificarPedido(p, codigosSet), semTaxaInformado: codigosSet.has(p.numeroPedido) }
    : { ...p, statusConciliacao: null, semTaxaInformado: false }));
  const pedidosElegiveis = pedidosProcessados.filter(ehElegivelConciliacao);
  const filtragem = resumoFiltragem(pedidosProcessados);
  const resumo = resumoConciliacao(pedidosElegiveis);

  const storage = await uploadOriginal({ buf, unidadeId, hash: relatorio.hash, nomeArquivo: arquivo?.nomeArquivo });

  const { data: importacao, error } = await supabase.from(TABELA_IMPORT).insert({
    organizacao_id: organizacaoId, unidade_id: unidadeId,
    periodo_inicio: periodoInicio, periodo_fim: periodoFim,
    nome_arquivo: arquivo?.nomeArquivo || null, hash_arquivo: relatorio.hash, arquivo_storage: storage,
    total_pedidos: pedidosProcessados.length,
    pedidos_subway: filtragem.subway, pedidos_acai: filtragem.acaiNoGrau, pedidos_revisao: filtragem.revisaoNecessaria,
    pedidos_sem_entregador: filtragem.semEntregador,
    coluna_detalhes_encontrada: relatorio.colunaDetalhesEncontrada,
    entregues: resumo.entregues, cancelados: resumo.cancelados,
    cancelados_com_taxa: resumo.canceladosComTaxa, cancelados_sem_taxa: resumo.canceladosSemTaxa,
    taxas_brutas: resumo.taxasBrutas, taxas_descartadas: resumo.taxasDescartadas, taxas_validas: resumo.taxasValidas,
    codigos_sem_taxa: [...codigosSet], status: "concluida",
    usuario_id: usuario?.id || null, usuario_nome: usuario?.nome || null, usuario_email: usuario?.email || null,
  }).select("*").single();
  if (error) {
    if (String(error.message).toLowerCase().includes("uq_pfdimp_hash")) {
      throw ApiError.badRequest("Este arquivo já foi importado anteriormente para esta unidade.");
    }
    throw ApiError.badRequest(error.message);
  }

  await inserirPedidosEmLotes(pedidosProcessados.map((p) => paraLinhaPedido(p, { importacaoId: importacao.id, organizacaoId, unidadeId })));
  await registrarAuditoria({
    importacaoId: importacao.id, organizacaoId, unidadeId, acao: "importacao_criada",
    codigosDepois: [...codigosSet], taxasValidasDepois: resumo.taxasValidas, usuario,
  });

  const entregadores = agruparPorEntregador(pedidosElegiveis).sort((a, b) => b.taxasValidas - a.taxasValidas);
  return {
    importacao: paraApiImportacao(importacao), resumo, entregadores,
    pedidos: pedidosElegiveis.map(paraApiPedido),
    pedidosIgnorados: pedidosProcessados.filter((p) => !ehElegivelConciliacao(p)).map(paraApiPedidoIgnorado),
  };
}

// ---------------------------------------------------------------------------
// HISTÓRICO
// ---------------------------------------------------------------------------
export async function listarImportacoes({ organizacaoId, unidadeId }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { data, error } = await supabase.from(TABELA_IMPORT).select("*").eq("unidade_id", unidadeId).order("criado_em", { ascending: false }).limit(200);
  if (error) throw ApiError.internal(error.message);
  return (data || []).map(paraApiImportacao);
}

export async function obterImportacao({ organizacaoId, unidadeId, importacaoId }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { data: importacao, error } = await supabase.from(TABELA_IMPORT).select("*").eq("unidade_id", unidadeId).eq("id", importacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!importacao) throw ApiError.notFound("Importação não encontrada.");

  const { data: pedidosRows, error: e2 } = await supabase.from(TABELA_PEDIDOS)
    .select(COLUNAS_PEDIDO_LEITURA).eq("importacao_id", importacaoId).order("data_hora", { ascending: true });
  if (e2) throw ApiError.internal(e2.message);

  const todosPedidos = (pedidosRows || []).map(paraApiPedido);
  const pedidos = todosPedidos.filter(ehElegivelConciliacao);
  const pedidosIgnorados = todosPedidos.filter((p) => !ehElegivelConciliacao(p)).map(paraApiPedidoIgnorado);
  const resumo = resumoConciliacao(pedidos);
  const entregadores = agruparPorEntregador(pedidos).sort((a, b) => b.taxasValidas - a.taxasValidas);
  return { importacao: paraApiImportacao(importacao), resumo, pedidos, pedidosIgnorados, entregadores };
}

export async function arquivoOriginal({ organizacaoId, unidadeId, importacaoId }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { data: imp } = await supabase.from(TABELA_IMPORT).select("id, nome_arquivo, arquivo_storage").eq("unidade_id", unidadeId).eq("id", importacaoId).maybeSingle();
  if (!imp) throw ApiError.notFound("Importação não encontrada.");
  if (!imp.arquivo_storage) throw ApiError.notFound("Esta importação não tem o arquivo original guardado.");
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(imp.arquivo_storage, 3600);
  if (error) throw ApiError.internal("Falha ao gerar o link do arquivo: " + error.message);
  return { url: data.signedUrl, nomeArquivo: imp.nome_arquivo };
}

// ---------------------------------------------------------------------------
// EDIÇÃO DOS CÓDIGOS "SEM TAXA" DE UMA IMPORTAÇÃO JÁ SALVA (item 13 —
// alteração posterior sempre registrada em auditoria, antes/depois).
// ---------------------------------------------------------------------------
export async function editarCodigosSemTaxa({ organizacaoId, unidadeId, importacaoId, novosCodigos, usuario }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const { data: importacao, error } = await supabase.from(TABELA_IMPORT).select("*").eq("unidade_id", unidade.id).eq("id", importacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!importacao) throw ApiError.notFound("Importação não encontrada.");

  const { data: pedidosRows, error: e2 } = await supabase.from(TABELA_PEDIDOS).select(COLUNAS_PEDIDO_LEITURA).eq("importacao_id", importacaoId);
  if (e2) throw ApiError.internal(e2.message);

  const codigosAntes = importacao.codigos_sem_taxa || [];
  const codigosDepois = [...new Set((novosCodigos || []).map((c) => String(c).trim()).filter(Boolean))];
  const codigosSet = new Set(codigosDepois);

  // Só recalcula pedidos elegíveis (Subway + com entregador) — os demais
  // (outra operação, ou sem entregador) nunca entraram na conciliação e
  // continuam de fora dela (status_conciliacao permanece null, mesmo
  // espírito do pipeline de import).
  const classificados = (pedidosRows || []).map((row) => {
    if (!ehElegivelConciliacao(row)) return { ...row, statusConciliacao: null, semTaxaInformado: false };
    const statusConciliacao = classificarPedido({ numeroPedido: row.numero_pedido, situacao: row.situacao }, codigosSet);
    return { ...row, statusConciliacao, semTaxaInformado: codigosSet.has(row.numero_pedido) };
  });

  const alterados = classificados.filter((p) => ehElegivelConciliacao(p)
    && (p.statusConciliacao !== p.status_conciliacao || p.semTaxaInformado !== p.sem_taxa_informado));
  for (const p of alterados) {
    const { error: eUp } = await supabase.from(TABELA_PEDIDOS)
      .update({ status_conciliacao: p.statusConciliacao, sem_taxa_informado: p.semTaxaInformado }).eq("id", p.id);
    if (eUp) throw ApiError.internal(`Falha ao atualizar pedido ${p.numero_pedido}: ${eUp.message}`);
  }

  const resumo = resumoConciliacao(classificados.filter(ehElegivelConciliacao).map((p) => ({
    situacao: p.situacao, taxaEntregador: numOuNulo(p.taxa_entregador), statusConciliacao: p.statusConciliacao,
  })));

  const { data: salvo, error: eImp } = await supabase.from(TABELA_IMPORT).update({
    codigos_sem_taxa: codigosDepois,
    entregues: resumo.entregues, cancelados: resumo.cancelados,
    cancelados_com_taxa: resumo.canceladosComTaxa, cancelados_sem_taxa: resumo.canceladosSemTaxa,
    taxas_brutas: resumo.taxasBrutas, taxas_descartadas: resumo.taxasDescartadas, taxas_validas: resumo.taxasValidas,
  }).eq("id", importacaoId).select("*").single();
  if (eImp) throw ApiError.badRequest(eImp.message);

  await registrarAuditoria({
    importacaoId, organizacaoId, unidadeId: unidade.id, acao: "codigos_alterados",
    codigosAntes, codigosDepois, taxasValidasAntes: numOuNulo(importacao.taxas_validas), taxasValidasDepois: resumo.taxasValidas, usuario,
  });

  // `classificados` ainda tem o formato bruto do banco (taxa_entregador, não
  // taxaEntregador) — agruparPorEntregador precisa do formato da API, senão
  // soma sempre 0 de taxa (bug real já visto em produção). Mapeia uma vez e
  // reaproveita tanto no agrupamento quanto no retorno de pedidos.
  const pedidosApi = classificados.map(paraApiPedido);
  const pedidosElegiveisApi = pedidosApi.filter(ehElegivelConciliacao);
  const pedidosIgnoradosApi = pedidosApi.filter((p) => !ehElegivelConciliacao(p)).map(paraApiPedidoIgnorado);
  const entregadores = agruparPorEntregador(pedidosElegiveisApi).sort((a, b) => b.taxasValidas - a.taxasValidas);
  return { importacao: paraApiImportacao(salvo), resumo, entregadores, pedidos: pedidosElegiveisApi, pedidosIgnorados: pedidosIgnoradosApi };
}

// ---------------------------------------------------------------------------
// EXCLUSÃO — sempre com motivo + snapshot ANTES de apagar (mesmo padrão de
// bonificacaoMensal.service.js#excluirLancamento). Libera o hash para
// reimportação (o arquivo apagado deixa de "existir" para efeito de duplicidade).
// ---------------------------------------------------------------------------
export async function excluirImportacao({ organizacaoId, unidadeId, importacaoId, motivo: motivoRaw, usuario }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const motivo = v.texto(motivoRaw, "Motivo da exclusão", { min: 3, max: 500 });

  const { data: importacao, error } = await supabase.from(TABELA_IMPORT).select("*").eq("unidade_id", unidade.id).eq("id", importacaoId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!importacao) throw ApiError.notFound("Importação não encontrada.");

  const { data: pedidosRows } = await supabase.from(TABELA_PEDIDOS)
    .select("numero_pedido, situacao, entregador, taxa_entregador, status_conciliacao, operacao").eq("importacao_id", importacaoId);

  await registrarAuditoria({
    importacaoId, organizacaoId, unidadeId: unidade.id, acao: "excluida", motivo,
    codigosAntes: importacao.codigos_sem_taxa, taxasValidasAntes: numOuNulo(importacao.taxas_validas),
    snapshot: { importacao, pedidos: pedidosRows || [] }, usuario,
  });

  if (importacao.arquivo_storage) {
    const { error: eStorage } = await supabase.storage.from(BUCKET).remove([importacao.arquivo_storage]);
    if (eStorage) console.error("[parser-food-delivery] falha ao remover arquivo do storage:", eStorage.message);
  }

  // parser_fd_pedidos cai em cascata (FK on delete cascade) — sem passo manual.
  const { error: eDel } = await supabase.from(TABELA_IMPORT).delete().eq("id", importacaoId);
  if (eDel) throw ApiError.badRequest(eDel.message);

  return { excluido: true, importacaoId };
}
