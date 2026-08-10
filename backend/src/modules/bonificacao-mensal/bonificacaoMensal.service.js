// Serviço central da Bonificação Mensal — lançamentos diários, importação
// dos 2 PDFs da Visio (preview + confirmação, mesmo padrão de
// vendas/vendas.service.js) e avaliação das metas do mês.
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { parseVisioProductReport, decodificarPdfVisio } from "./visio-parser.js";
import {
  hojeIsoBrasil, diasDoMes, STATUS_DIA_BONIFICACAO, statusDia, percentualDerivado, mixDoDia,
  validarPercentualCruzado, detectarInversaoRelatorios, faturamentoAcumulado, mixMensalPonderado,
  mediaDiaria, somaValida, projecaoFaturamento, ritmoNecessario, participacaoLoja, mesmaUnidadeVisio,
} from "./bonificacaoMensal.calc.js";
import { evaluateBonusMetric, resolverMetaVigente, totalBonificacao } from "./bonificacaoMensal.metas.js";

const TABELA = "bonificacao_lancamentos_diarios";
const TABELA_IMPORT = "bonificacao_importacoes";
const TABELA_METAS = "bonificacao_metas";
const TABELA_FAIXAS = "bonificacao_metas_faixas";
const BUCKET = "bonificacao-visio";

/** Number(x), mas preserva null/undefined — "não informado" nunca vira 0. */
const numOuNulo = (x) => (x == null ? null : Number(x));

/** Indicadores que a importação da Visio alimenta automaticamente (item 27). */
const CAMPOS_INDICADOR = {
  faturamento: (m) => faturamentoAcumulado(m.lancamentos),
  bebidas: (m) => m.mix.bebidas,
  adicionais: (m) => m.mix.adicionais,
  diversos: (m) => m.mix.diversos,
  cmv: (m) => mediaDiaria(m.lancamentos.map((l) => l.cmvPct)),
  ticket_medio: (m) => mediaDiaria(m.lancamentos.map((l) => l.ticketMedio)),
  avaliacao_ifood: (m) => mediaDiaria(m.lancamentos.map((l) => l.avaliacaoIfood)),
  cancelamentos: (m) => mediaDiaria(m.lancamentos.map((l) => l.cancelamentosPct)),
  pedidos_chamado: (m) => mediaDiaria(m.lancamentos.map((l) => l.pedidosChamadoPct)),
  rev: (m) => mediaDiaria(m.lancamentos.map((l) => l.revNota)),
  // Pesquisas é CONTAGEM acumulada no mês, não média (item 34) — cada dia
  // informa quantas pesquisas novas chegaram.
  pesquisas: (m) => somaValida(m.lancamentos.map((l) => l.pesquisasQtd)),
};

// ---------------------------------------------------------------------------
// MAPEAMENTO DB <-> API
// ---------------------------------------------------------------------------
function paraApiLancamento(row) {
  if (!row) return null;
  return {
    id: row.id,
    unidadeId: row.unidade_id,
    data: row.data,
    semOperacao: !!row.sem_operacao,
    motivoSemOperacao: row.motivo_sem_operacao ?? null,
    faturamentoGeral: numOuNulo(row.faturamento_geral),
    ppdGeral: numOuNulo(row.ppd_geral),
    estabelecimentoGeral: row.estabelecimento_geral ?? null,
    faturamentoLoja: numOuNulo(row.faturamento_loja),
    ppdLoja: numOuNulo(row.ppd_loja),
    qtdSanduichesLoja: numOuNulo(row.qtd_sanduiches_loja),
    qtdBebidasLoja: numOuNulo(row.qtd_bebidas_loja),
    qtdAdicionaisLoja: numOuNulo(row.qtd_adicionais_loja),
    qtdDiversosLoja: numOuNulo(row.qtd_diversos_loja),
    estabelecimentoLoja: row.estabelecimento_loja ?? null,
    percentualBebidasPdf: numOuNulo(row.percentual_bebidas_pdf),
    percentualAdicionaisPdf: numOuNulo(row.percentual_adicionais_pdf),
    percentualDiversosPdf: numOuNulo(row.percentual_diversos_pdf),
    cmvPct: numOuNulo(row.cmv_pct),
    ticketMedio: numOuNulo(row.ticket_medio),
    avaliacaoIfood: numOuNulo(row.avaliacao_ifood),
    cancelamentosPct: numOuNulo(row.cancelamentos_pct),
    pedidosChamadoPct: numOuNulo(row.pedidos_chamado_pct),
    revNota: numOuNulo(row.rev_nota),
    pesquisasQtd: row.pesquisas_qtd ?? null,
    origem: row.origem,
    manualOverride: row.manual_override || {},
    importacaoGeralId: row.importacao_geral_id ?? null,
    importacaoLojaId: row.importacao_loja_id ?? null,
    usuarioNome: row.usuario_nome ?? null,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
    mix: mixDoDia({
      qtdSanduichesLoja: numOuNulo(row.qtd_sanduiches_loja), qtdBebidasLoja: numOuNulo(row.qtd_bebidas_loja),
      qtdAdicionaisLoja: numOuNulo(row.qtd_adicionais_loja), qtdDiversosLoja: numOuNulo(row.qtd_diversos_loja),
    }),
    participacaoLoja: participacaoLoja(numOuNulo(row.faturamento_loja), numOuNulo(row.faturamento_geral)),
  };
}

function paraApiImportacao(row) {
  return {
    id: row.id, unidadeId: row.unidade_id, data: row.data_lancamento, tipoRelatorio: row.tipo_relatorio,
    nomeArquivo: row.nome_arquivo, estabelecimentoDetectado: row.estabelecimento_detectado,
    status: row.status, mensagemErro: row.mensagem_erro,
    usuarioNome: row.usuario_nome, criadoEm: row.criado_em,
  };
}

function paraApiMeta(meta) {
  return {
    id: meta.id, indicador: meta.indicador, direcao: meta.direcao,
    validFrom: meta.valid_from, validUntil: meta.valid_until, observacao: meta.observacao ?? null,
    faixas: (meta.bonificacao_metas_faixas || []).slice().sort((a, b) => a.ordem - b.ordem).map((f) => ({
      ordem: f.ordem, tipo: f.tipo, valorMin: numOuNulo(f.valor_min), valorMax: numOuNulo(f.valor_max), bonus: numOuNulo(f.bonus),
    })),
  };
}

// ---------------------------------------------------------------------------
// UNIDADE-ALVO — mesmo princípio do Dashboard iFood: nunca confia em
// unidadeId vindo do cliente sem checar contra a sessão/organização.
// ---------------------------------------------------------------------------
async function resolverUnidade({ organizacaoId, unidadeId }) {
  if (!unidadeId) throw ApiError.badRequest("Selecione uma unidade para acessar a Bonificação Mensal.");
  const { data: unidade, error } = await supabase.from("unidades").select("id, nome, organizacao_id").eq("id", unidadeId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!unidade || unidade.organizacao_id !== organizacaoId) throw ApiError.forbidden("Você não tem acesso a esta unidade.");
  return unidade;
}

// ---------------------------------------------------------------------------
// METAS
// ---------------------------------------------------------------------------
async function carregarMetas({ unidadeId }) {
  const { data, error } = await supabase.from(TABELA_METAS)
    .select("*, bonificacao_metas_faixas(*)").eq("unidade_id", unidadeId).order("valid_from", { ascending: true });
  if (error) throw ApiError.internal(error.message);
  return data || [];
}

/** Metas vigentes na data de referência, uma por indicador (a mais recente aplicável). */
function metasVigentesPorIndicador(metas, dataReferencia) {
  const porIndicador = {};
  for (const m of metas) {
    if (!porIndicador[m.indicador]) porIndicador[m.indicador] = [];
    porIndicador[m.indicador].push(m);
  }
  const vigentes = {};
  for (const [indicador, lista] of Object.entries(porIndicador)) {
    const candidatas = lista.map((m) => ({ ...m, validFrom: m.valid_from, validUntil: m.valid_until }));
    const escolhida = resolverMetaVigente(candidatas, dataReferencia);
    if (escolhida) {
      vigentes[indicador] = {
        indicador, direcao: escolhida.direcao,
        faixas: (escolhida.bonificacao_metas_faixas || []).map((f) => ({
          ordem: f.ordem, tipo: f.tipo, valorMin: numOuNulo(f.valor_min), valorMax: numOuNulo(f.valor_max), bonus: numOuNulo(f.bonus),
        })),
      };
    }
  }
  return vigentes;
}

export async function listarMetas({ organizacaoId, unidadeId }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const metas = await carregarMetas({ unidadeId });
  return metas.map(paraApiMeta);
}

// ---------------------------------------------------------------------------
// MÊS — calendário, resumo, avaliação de cada indicador
// ---------------------------------------------------------------------------
export async function obterMes({ organizacaoId, unidadeId, ano, mes }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });
  const anoNum = Number(ano), mesNum = Number(mes);
  if (!Number.isInteger(anoNum) || !Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12) {
    throw ApiError.badRequest("Informe ano e mês válidos.");
  }
  const hojeIso = hojeIsoBrasil();
  const dias = diasDoMes(anoNum, mesNum);
  const primeiroDia = dias[0], ultimoDia = dias[dias.length - 1];

  const [{ data: rows, error }, metasRaw] = await Promise.all([
    supabase.from(TABELA).select("*").eq("unidade_id", unidadeId).gte("data", primeiroDia).lte("data", ultimoDia).order("data"),
    carregarMetas({ unidadeId }),
  ]);
  if (error) throw ApiError.internal(error.message);

  const lancamentosPorData = new Map((rows || []).map((r) => [r.data, paraApiLancamento(r)]));
  const calendario = dias.map((d) => {
    const lancamento = lancamentosPorData.get(d) || null;
    return { data: d, status: statusDia({ lancamento, dataIso: d, hojeIso }), lancamento };
  });

  const lancamentos = [...lancamentosPorData.values()];
  const mix = mixMensalPonderado(lancamentos);
  const projecao = projecaoFaturamento({ lancamentos, ano: anoNum, mes: mesNum, hojeIso });

  const metasVigentes = metasVigentesPorIndicador(metasRaw, primeiroDia);
  const valorMensal = { mix, lancamentos };
  const indicadores = {};
  for (const [indicador, calcular] of Object.entries(CAMPOS_INDICADOR)) {
    const valor = indicador === "faturamento" ? projecao.acumulado : calcular(valorMensal);
    indicadores[indicador] = { ...evaluateBonusMetric(valor, metasVigentes[indicador]), valorAtual: valor, indicador };
  }
  const bonificacao = totalBonificacao(indicadores);

  const mesAtualIso = hojeIso.slice(0, 7);
  const consultaIso = `${anoNum}-${String(mesNum).padStart(2, "0")}`;
  const mesFechado = consultaIso < mesAtualIso;

  // próxima faixa de faturamento + ritmo necessário (itens 42-43)
  const fatIndicador = indicadores.faturamento;
  const ritmoFaturamento = fatIndicador?.proximaFaixa
    ? ritmoNecessario(
      fatIndicador.proximaFaixa.valorMin != null ? fatIndicador.proximaFaixa.valorMin - (projecao.projecao ?? projecao.acumulado ?? 0) : null,
      projecao.diasRestantes,
    )
    : null;

  const diasPendentes = calendario.filter((d) => d.status === STATUS_DIA_BONIFICACAO.PENDENTE).map((d) => d.data);
  const indicadoresAtencao = Object.values(indicadores).filter((i) => i.status === "meta_nao_atingida" && i.temBonusDefinido);

  return {
    unidade: { id: unidade.id, nome: unidade.nome },
    ano: anoNum, mes: mesNum, mesFechado,
    calendario,
    resumo: {
      bonificacaoAtual: bonificacao.atual,
      bonificacaoMaxima: bonificacao.maximo,
      metasAtingidas: bonificacao.metasAtingidas,
      metasComRegra: bonificacao.metasComRegra,
      progressoPct: bonificacao.maximo > 0 ? (bonificacao.atual / bonificacao.maximo) * 100 : null,
    },
    faturamento: { ...projecao, ritmoNecessarioProximaFaixa: ritmoFaturamento },
    mix,
    indicadores,
    diasPendentes,
    indicadoresAtencao: indicadoresAtencao.map((i) => i.indicador),
  };
}

export async function obterLancamentoPorData({ organizacaoId, unidadeId, data }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const dataIso = v.dataOpcional(data, "Data");
  if (!dataIso) throw ApiError.badRequest("Data inválida.");
  const { data: row, error } = await supabase.from(TABELA).select("*").eq("unidade_id", unidadeId).eq("data", dataIso).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!row) return null;
  const lancamento = paraApiLancamento(row);
  const validacaoCruzada = {
    bebidas: validarPercentualCruzado(lancamento.percentualBebidasPdf, lancamento.mix.bebidas),
    adicionais: validarPercentualCruzado(lancamento.percentualAdicionaisPdf, lancamento.mix.adicionais),
    diversos: validarPercentualCruzado(lancamento.percentualDiversosPdf, lancamento.mix.diversos),
  };
  return { ...lancamento, validacaoCruzada };
}

// ---------------------------------------------------------------------------
// LANÇAMENTO MANUAL (criação direta ou correção pós-importação — item 73)
// ---------------------------------------------------------------------------
const CAMPOS_EDITAVEIS = [
  "faturamentoGeral", "ppdGeral", "faturamentoLoja", "ppdLoja", "qtdSanduichesLoja", "qtdBebidasLoja",
  "qtdAdicionaisLoja", "qtdDiversosLoja", "cmvPct", "ticketMedio", "avaliacaoIfood", "cancelamentosPct",
  "pedidosChamadoPct", "revNota", "pesquisasQtd",
];
const CAMPO_DB = {
  faturamentoGeral: "faturamento_geral", ppdGeral: "ppd_geral", faturamentoLoja: "faturamento_loja", ppdLoja: "ppd_loja",
  qtdSanduichesLoja: "qtd_sanduiches_loja", qtdBebidasLoja: "qtd_bebidas_loja", qtdAdicionaisLoja: "qtd_adicionais_loja",
  qtdDiversosLoja: "qtd_diversos_loja", cmvPct: "cmv_pct", ticketMedio: "ticket_medio", avaliacaoIfood: "avaliacao_ifood",
  cancelamentosPct: "cancelamentos_pct", pedidosChamadoPct: "pedidos_chamado_pct", revNota: "rev_nota", pesquisasQtd: "pesquisas_qtd",
};

export async function upsertLancamentoManual({ organizacaoId, unidadeId, usuario, dados }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const dataIso = v.dataOpcional(dados?.data, "Data do lançamento");
  if (!dataIso) throw ApiError.badRequest("Informe a data do lançamento.");
  const semOperacao = v.booleano(dados?.semOperacao, false);
  if (semOperacao && !v.textoOpcional(dados?.motivoSemOperacao, "Motivo")) {
    throw ApiError.badRequest("Informe o motivo de a unidade não ter operado neste dia.");
  }

  const { data: existente } = await supabase.from(TABELA).select("*").eq("unidade_id", unidadeId).eq("data", dataIso).maybeSingle();

  const manualOverrideAnterior = existente?.manual_override || {};
  const manualOverride = { ...manualOverrideAnterior };
  const linha = { organizacao_id: organizacaoId, unidade_id: unidadeId, data: dataIso };

  if (semOperacao) {
    linha.sem_operacao = true;
    linha.motivo_sem_operacao = v.texto(dados.motivoSemOperacao, "Motivo");
    for (const campo of CAMPOS_EDITAVEIS) linha[CAMPO_DB[campo]] = null;
  } else {
    linha.sem_operacao = false;
    linha.motivo_sem_operacao = null;
    for (const campo of CAMPOS_EDITAVEIS) {
      if (!(campo in (dados || {}))) continue; // campo não enviado -> mantém o que já existia
      const valorNovo = dados[campo] === "" ? null : v.numeroOpcionalNulo(dados[campo], campo);
      const dbKey = CAMPO_DB[campo];
      linha[dbKey] = valorNovo;
      const valorAnterior = existente ? numOuNulo(existente[dbKey]) : null;
      if (valorNovo !== valorAnterior) manualOverride[campo] = true; // item 19 — nunca silencioso
    }
  }

  const tinhaOrigemVisio = existente && (existente.origem === "visio" || existente.origem === "misto");
  linha.origem = tinhaOrigemVisio ? "misto" : "manual";
  linha.manual_override = manualOverride;
  linha.usuario_id = usuario?.id || null;
  linha.usuario_nome = usuario?.nome || null;
  // preserva o que não foi tocado (ex.: campos de importação e ids de importação)
  if (existente) {
    for (const [campo, dbKey] of Object.entries(CAMPO_DB)) if (!(dbKey in linha)) linha[dbKey] = existente[dbKey];
    linha.importacao_geral_id = existente.importacao_geral_id;
    linha.importacao_loja_id = existente.importacao_loja_id;
    linha.estabelecimento_geral = existente.estabelecimento_geral;
    linha.estabelecimento_loja = existente.estabelecimento_loja;
    linha.percentual_bebidas_pdf = existente.percentual_bebidas_pdf;
    linha.percentual_adicionais_pdf = existente.percentual_adicionais_pdf;
    linha.percentual_diversos_pdf = existente.percentual_diversos_pdf;
  }

  const { data: salvo, error } = await supabase.from(TABELA).upsert(linha, { onConflict: "unidade_id,data" }).select("*").single();
  if (error) throw ApiError.badRequest(error.message);
  return paraApiLancamento(salvo);
}

// ---------------------------------------------------------------------------
// IMPORTAÇÃO VISIO — preview (dry-run) + confirmação (mesmo padrão de
// vendas/vendas.service.js processarImportacaoVendas).
// ---------------------------------------------------------------------------
async function uploadOriginal({ buf, unidadeId, data, tipo, hash, nomeArquivo }) {
  if (!buf) return null;
  const nome = String(nomeArquivo || "relatorio.pdf").replace(/[^\w.\-]+/g, "_").slice(-80);
  const path = `${unidadeId}/${data}/${tipo}-${String(hash || "").slice(0, 10)}-${nome}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: "application/pdf", upsert: true });
  if (error) { console.warn("[bonificacao-mensal] storage:", error.message, "— importação segue sem o arquivo original."); return null; }
  return path;
}

async function gravarImportacao({ organizacaoId, unidadeId, tipo, data, parsed, storage, nomeArquivo, usuario, permitirReuso = false }) {
  const { data: row, error } = await supabase.from(TABELA_IMPORT).insert({
    organizacao_id: organizacaoId, unidade_id: unidadeId, data_lancamento: data, tipo_relatorio: tipo,
    nome_arquivo: nomeArquivo || null, hash_arquivo: parsed.hash, arquivo_storage: storage,
    estabelecimento_detectado: parsed.estabelecimento, status: "concluida",
    usuario_id: usuario?.id || null, usuario_nome: usuario?.nome || null,
  }).select("id").single();
  if (!error) return row.id;

  if (String(error.message).toLowerCase().includes("uq_bimp_hash")) {
    // Mesmo arquivo (mesmo hash) já registrado para esta unidade+relatório.
    // Numa SUBSTITUIÇÃO do mesmo dia isso é esperado (o usuário reenviou o
    // mesmo PDF) — reaproveita o registro de importação já existente em vez
    // de bloquear. Fora de uma substituição, continua bloqueando (item 20).
    if (permitirReuso) {
      const { data: existente, error: e2 } = await supabase.from(TABELA_IMPORT)
        .select("id").eq("unidade_id", unidadeId).eq("tipo_relatorio", tipo).eq("hash_arquivo", parsed.hash)
        .eq("status", "concluida").order("criado_em", { ascending: false }).limit(1).maybeSingle();
      if (!e2 && existente) return existente.id;
    }
    throw ApiError.badRequest(`Este arquivo (Relatório ${tipo === "geral" ? "Geral" : "Loja"}) já foi importado anteriormente.`);
  }
  throw ApiError.badRequest(error.message);
}

/**
 * @param {{organizacaoId:string, unidadeId:string, usuario:object, payload:{data:string, geral?:object, loja?:object, substituir?:boolean}, confirmar:boolean}} p
 */
export async function processarImportacaoVisio({ organizacaoId, unidadeId, usuario, payload, confirmar = false }) {
  const unidade = await resolverUnidade({ organizacaoId, unidadeId });

  const dataLancamento = v.dataOpcional(payload?.data, "Data do lançamento");
  if (!dataLancamento) throw ApiError.badRequest("Informe a data do lançamento — a Visio não traz uma data diária confiável no relatório.");
  if (!payload?.geral && !payload?.loja) throw ApiError.badRequest("Envie pelo menos um dos dois relatórios (Geral ou Loja).");

  let bufGeral = null, bufLoja = null, parsedGeral = null, parsedLoja = null;
  if (payload.geral) { bufGeral = decodificarPdfVisio(payload.geral, "Geral"); parsedGeral = await parseVisioProductReport(bufGeral); }
  if (payload.loja) { bufLoja = decodificarPdfVisio(payload.loja, "Loja"); parsedLoja = await parseVisioProductReport(bufLoja); }

  // item 19 — correção manual ANTES de salvar (a leitura do PDF pode ter
  // interpretado algum número errado). Cada campo corrigido entra no
  // manual_override — nunca silencioso, e sempre em cima do valor já
  // validado pelo parser (a correção passa pelas MESMAS validações abaixo:
  // inversão, unidade etc.).
  const camposCorrigidosGeral = [], camposCorrigidosLoja = [];
  if (parsedGeral && payload.correcoes?.geral) {
    for (const [campo, valor] of Object.entries(payload.correcoes.geral)) {
      if (!(campo in parsedGeral) || valor === undefined || valor === "") continue;
      const num = Number(valor);
      if (!Number.isFinite(num) || num < 0) continue;
      if (num !== parsedGeral[campo]) { parsedGeral[campo] = num; camposCorrigidosGeral.push(campo); }
    }
  }
  if (parsedLoja && payload.correcoes?.loja) {
    for (const [campo, valor] of Object.entries(payload.correcoes.loja)) {
      if (!(campo in parsedLoja) || valor === undefined || valor === "") continue;
      const num = Number(valor);
      if (!Number.isFinite(num) || num < 0) continue;
      if (num !== parsedLoja[campo]) { parsedLoja[campo] = num; camposCorrigidosLoja.push(campo); }
    }
  }

  // item 16 — CRÍTICA: unidade do relatório precisa bater com a selecionada
  for (const [rotulo, parsed] of [["Geral", parsedGeral], ["Loja", parsedLoja]]) {
    if (!parsed) continue;
    if (mesmaUnidadeVisio(unidade.nome, parsed.estabelecimento) === false) {
      throw ApiError.badRequest(`O relatório ${rotulo} pertence a uma unidade diferente da unidade atualmente selecionada (relatório de "${parsed.estabelecimento}").`);
    }
  }

  // itens 14-15 — possível inversão dos relatórios
  let inversao = null;
  if (parsedGeral && parsedLoja) {
    inversao = detectarInversaoRelatorios(parsedGeral, parsedLoja);
    if (inversao.invertido) {
      throw ApiError.badRequest("Os relatórios parecem estar invertidos: o relatório informado como Loja possui valores superiores ao relatório Geral. Verifique os arquivos antes de continuar (troque os relatórios de campo e tente novamente).");
    }
  }

  // item 20 — duplicidade por unidade+data. Continua montando a prévia
  // mesmo assim (não retorna cedo): o frontend precisa mostrar VALORES
  // ATUAIS (existente) e NOVOS (preview) lado a lado antes de substituir.
  const { data: existente } = await supabase.from(TABELA).select("*").eq("unidade_id", unidadeId).eq("data", dataLancamento).maybeSingle();
  const duplicado = !!existente && !payload.substituir;

  // mix calculado + validação cruzada (item 11)
  let mixCalculado = null, validacaoCruzada = null, avisos = [];
  if (parsedLoja) {
    mixCalculado = {
      bebidas: percentualDerivado(parsedLoja.beverages, parsedLoja.sandwichesSalads),
      adicionais: percentualDerivado(parsedLoja.additions, parsedLoja.sandwichesSalads),
      diversos: percentualDerivado(parsedLoja.miscellaneous, parsedLoja.sandwichesSalads),
    };
    validacaoCruzada = {
      bebidas: validarPercentualCruzado(parsedLoja.percentualBebidasPdf, mixCalculado.bebidas),
      adicionais: validarPercentualCruzado(parsedLoja.percentualAdicionaisPdf, mixCalculado.adicionais),
      diversos: validarPercentualCruzado(parsedLoja.percentualDiversosPdf, mixCalculado.diversos),
    };
    for (const [chave, r] of Object.entries(validacaoCruzada)) {
      if (r.divergente) avisos.push(`Divergência no percentual de ${chave}: a Visio informou um valor e o sistema calculou outro (diferença de ${r.diferenca.toFixed(1)} p.p.). Confira antes de confirmar.`);
    }
  }

  const preview = {
    data: dataLancamento,
    unidade: { id: unidade.id, nome: unidade.nome },
    geral: parsedGeral && { faturamento: parsedGeral.faturamento, ppd: parsedGeral.ppd, estabelecimento: parsedGeral.estabelecimento },
    loja: parsedLoja && {
      faturamento: parsedLoja.faturamento, ppd: parsedLoja.ppd, estabelecimento: parsedLoja.estabelecimento,
      sanduichesSaladas: parsedLoja.sandwichesSalads, bebidas: parsedLoja.beverages, adicionais: parsedLoja.additions, diversos: parsedLoja.miscellaneous,
      mixCalculado, percentuaisPdf: { bebidas: parsedLoja.percentualBebidasPdf, adicionais: parsedLoja.percentualAdicionaisPdf, diversos: parsedLoja.percentualDiversosPdf },
    },
    validacaoCruzada, avisos,
    camposCorrigidos: { geral: camposCorrigidosGeral, loja: camposCorrigidosLoja },
  };

  if (duplicado) return { duplicado: true, existente: paraApiLancamento(existente), persistido: false, preview };
  if (!confirmar) return { duplicado: false, existente: existente ? paraApiLancamento(existente) : null, persistido: false, preview };

  // ---------- PERSISTE ----------
  const [storageGeral, storageLoja] = await Promise.all([
    parsedGeral ? uploadOriginal({ buf: bufGeral, unidadeId, data: dataLancamento, tipo: "geral", hash: parsedGeral.hash, nomeArquivo: payload.geral.nomeArquivo }) : null,
    parsedLoja ? uploadOriginal({ buf: bufLoja, unidadeId, data: dataLancamento, tipo: "loja", hash: parsedLoja.hash, nomeArquivo: payload.loja.nomeArquivo }) : null,
  ]);

  const permitirReuso = !!payload.substituir;
  const importacaoGeralId = parsedGeral ? await gravarImportacao({ organizacaoId, unidadeId, tipo: "geral", data: dataLancamento, parsed: parsedGeral, storage: storageGeral, nomeArquivo: payload.geral.nomeArquivo, usuario, permitirReuso }) : null;
  const importacaoLojaId = parsedLoja ? await gravarImportacao({ organizacaoId, unidadeId, tipo: "loja", data: dataLancamento, parsed: parsedLoja, storage: storageLoja, nomeArquivo: payload.loja.nomeArquivo, usuario, permitirReuso }) : null;

  const camposVisio = {};
  if (parsedGeral) { camposVisio.faturamento_geral = parsedGeral.faturamento; camposVisio.ppd_geral = parsedGeral.ppd; camposVisio.estabelecimento_geral = parsedGeral.estabelecimento; }
  if (parsedLoja) {
    camposVisio.faturamento_loja = parsedLoja.faturamento; camposVisio.ppd_loja = parsedLoja.ppd; camposVisio.estabelecimento_loja = parsedLoja.estabelecimento;
    camposVisio.qtd_sanduiches_loja = parsedLoja.sandwichesSalads; camposVisio.qtd_bebidas_loja = parsedLoja.beverages;
    camposVisio.qtd_adicionais_loja = parsedLoja.additions; camposVisio.qtd_diversos_loja = parsedLoja.miscellaneous;
    camposVisio.percentual_bebidas_pdf = parsedLoja.percentualBebidasPdf; camposVisio.percentual_adicionais_pdf = parsedLoja.percentualAdicionaisPdf; camposVisio.percentual_diversos_pdf = parsedLoja.percentualDiversosPdf;
  }

  const manualOverrideAnterior = existente?.manual_override || {};
  const manualOverride = { ...manualOverrideAnterior };
  for (const campo of Object.keys(camposVisio)) delete manualOverride[campo]; // acabou de vir fresco da Visio

  // item 19 — campos corrigidos manualmente na prévia ficam marcados mesmo
  // vindo desta importação (não são mais 100% "extração automática").
  const DB_POR_CAMPO_GERAL = { faturamento: "faturamento_geral", ppd: "ppd_geral" };
  const DB_POR_CAMPO_LOJA = {
    faturamento: "faturamento_loja", ppd: "ppd_loja", sandwichesSalads: "qtd_sanduiches_loja",
    beverages: "qtd_bebidas_loja", additions: "qtd_adicionais_loja", miscellaneous: "qtd_diversos_loja",
  };
  for (const campo of camposCorrigidosGeral) if (DB_POR_CAMPO_GERAL[campo]) manualOverride[DB_POR_CAMPO_GERAL[campo]] = true;
  for (const campo of camposCorrigidosLoja) if (DB_POR_CAMPO_LOJA[campo]) manualOverride[DB_POR_CAMPO_LOJA[campo]] = true;
  const houveCorrecaoManual = camposCorrigidosGeral.length > 0 || camposCorrigidosLoja.length > 0;

  const sobramCamposManuais = houveCorrecaoManual || (existente && Object.keys(manualOverrideAnterior).some((k) => !(k in camposVisio)));

  const linha = {
    organizacao_id: organizacaoId, unidade_id: unidadeId, data: dataLancamento,
    sem_operacao: false, motivo_sem_operacao: null,
    ...camposVisio,
    origem: sobramCamposManuais ? "misto" : "visio",
    manual_override: manualOverride,
    importacao_geral_id: importacaoGeralId ?? existente?.importacao_geral_id ?? null,
    importacao_loja_id: importacaoLojaId ?? existente?.importacao_loja_id ?? null,
    usuario_id: usuario?.id || null, usuario_nome: usuario?.nome || null,
  };
  // preserva indicadores manuais (CMV/Ticket médio/...) que não vieram da Visio
  if (existente) for (const dbKey of ["cmv_pct", "ticket_medio", "avaliacao_ifood", "cancelamentos_pct", "pedidos_chamado_pct", "rev_nota", "pesquisas_qtd"]) linha[dbKey] = existente[dbKey];

  const { data: salvo, error } = await supabase.from(TABELA).upsert(linha, { onConflict: "unidade_id,data" }).select("*").single();
  if (error) throw ApiError.badRequest(error.message);

  return { duplicado: false, persistido: true, preview, lancamento: paraApiLancamento(salvo) };
}

// ---------------------------------------------------------------------------
// HISTÓRICO DE IMPORTAÇÕES E ARQUIVO ORIGINAL (item 47)
// ---------------------------------------------------------------------------
export async function listarImportacoes({ organizacaoId, unidadeId }) {
  await resolverUnidade({ organizacaoId, unidadeId });
  const { data, error } = await supabase.from(TABELA_IMPORT).select("*").eq("unidade_id", unidadeId).order("criado_em", { ascending: false }).limit(200);
  if (error) throw ApiError.internal(error.message);
  return (data || []).map(paraApiImportacao);
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
// HISTÓRICO DE MESES (aba Histórico — item 50)
// ---------------------------------------------------------------------------
export async function listarHistoricoMeses({ organizacaoId, unidadeId, ano }) {
  const anoNum = Number(ano) || Number(hojeIsoBrasil().slice(0, 4));
  const meses = [];
  for (let mes = 1; mes <= 12; mes++) {
    const hoje = hojeIsoBrasil();
    const consultaIso = `${anoNum}-${String(mes).padStart(2, "0")}`;
    if (consultaIso > hoje.slice(0, 7)) continue; // não lista meses futuros
    const r = await obterMes({ organizacaoId, unidadeId, ano: anoNum, mes });
    meses.push({
      ano: anoNum, mes, mesFechado: r.mesFechado,
      bonificacaoAtual: r.resumo.bonificacaoAtual, bonificacaoMaxima: r.resumo.bonificacaoMaxima,
      metasAtingidas: r.resumo.metasAtingidas, metasComRegra: r.resumo.metasComRegra,
      faturamentoAcumulado: r.faturamento.acumulado,
    });
  }
  return meses.reverse();
}
