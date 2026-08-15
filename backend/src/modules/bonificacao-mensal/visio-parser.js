// Leitura dos relatórios "Relatório de Produtos" da Visio Analytics
// (Geral e Loja) usados na Bonificação Mensal.
//
// Mesmo espírito de vendas/sw-parser.js: o backend é quem interpreta o PDF,
// nunca o frontend — importação manual e futura automação usam a mesma
// lógica. Reaproveita daquele módulo o que é genérico (matriz de texto,
// parseBR, sha256, decodificação do base64); NADA em vendas/ foi alterado.
//
// O parser é agnóstico a "Geral" ou "Loja": os dois PDFs têm exatamente a
// mesma estrutura (só mudam os filtros aplicados na Visio antes de
// exportar — item 14 das instruções). Quem decide qual é qual é o usuário,
// no modal de importação; este módulo só extrai os campos e devolve uma
// estrutura padronizada — a validação cruzada (Geral >= Loja, mesma
// unidade) acontece na camada de serviço.
import { ApiError } from "../../shared/ApiError.js";
import { emProducao } from "../../config/seguranca.js";
import { sha256, norm, parseBR, textoParaMatriz, decodificarArquivo } from "../vendas/sw-parser.js";

// ---------------------------------------------------------------------
// LOG DE DESENVOLVIMENTO
// Ligado fora de produção, por padrão — é o que permite depurar "por que
// este PDF não leu" sem precisar mexer em código. Nunca imprime o texto cru
// do PDF inteiro (pode ter dado de faturamento) nem roda em produção.
// ---------------------------------------------------------------------
const DEBUG = !emProducao;
const logDebug = (...args) => { if (DEBUG) console.log("[visio-parser]", ...args); };

// pdf-parse padrão cola as colunas; este pagerender preserva a estrutura de
// tabela inserindo TAB entre itens da mesma linha (mesmo Y) — cópia local
// do helper de sw-parser.js (não exportado de lá) para não tocar em Vendas.
function renderPaginaComColunas(pageData) {
  return pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false }).then((tc) => {
    let ultimoY = null, texto = "";
    for (const item of tc.items) {
      if (!item.str) continue;
      const y = item.transform[5];
      if (ultimoY === null) texto = item.str;
      else if (Math.abs(y - ultimoY) < 2) texto += "\t" + item.str;
      else texto += "\n" + item.str;
      ultimoY = y;
    }
    return texto;
  });
}

async function matrizDePdf(buf) {
  let pdfParse;
  try {
    ({ default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js"));
  } catch {
    throw ApiError.badRequest("Leitor de PDF indisponível no servidor. Tente novamente em instantes.");
  }
  const { text } = await pdfParse(buf, { pagerender: renderPaginaComColunas });
  const matriz = textoParaMatriz(text);
  if (!matriz.length) throw ApiError.badRequest("Não consegui extrair texto deste PDF (pode ser digitalizado/imagem). Exporte novamente da Visio.");
  logDebug(`matriz extraída: ${matriz.length} linha(s) de texto.`);
  return matriz;
}

// ---------- reconhecimento de células ----------
const MONEY_RE = /^(?:r\$|\$)\s?-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?$/i;
const INT_RE = /^\d+$/;
// PPD ("Torque por estabelecimento") NÃO é sempre inteiro — o relatório
// Geral (soma de todos os canais) traz PPD fracionário (ex.: "180,5"),
// enquanto o relatório de uma unidade/canal isolado costuma dar um inteiro
// (ex.: "57"). INT_RE sozinho rejeitava a linha inteira no Geral e o parser
// "não encontrava" a tabela — não é que faltasse, era decimal demais pra ele.
// Reaproveitado também como "número puro" (sem % nem $) na leitura por nome
// do Mix de Vendas, abaixo — aceita inteiro OU decimal, do mesmo jeito.
const DECIMAL_RE = /^-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?$/;
const PCT_RE = /^-?\d{1,3}(?:[.,]\d+)?%$/;

const parsePct = (s) => (s == null ? null : parseBR(String(s).replace("%", "")));
/** Número "puro" (sem % — isso é quantidade, nunca percentual de faturamento). */
const numeroPuro = (s) => (DECIMAL_RE.test(String(s ?? "").trim()) ? parseBR(s) : null);

/**
 * Normaliza uma célula para COMPARAÇÃO semântica (nunca para exibição):
 * minúsculas, sem acento (via norm(), de sw-parser.js), sem caracteres
 * invisíveis que a extração de PDF às vezes deixa (zero-width, NBSP),
 * espaços/quebras colapsados, sem pontuação de borda ("Bebidas:", "- Bebidas").
 * Cobre os itens pedidos: trim, collapse de espaços, normalização Unicode,
 * comparação case-insensitive, tolerância a acentos e a pequenas variações.
 */
function normCel(s) {
  return norm(String(s ?? "").replace(/[​‌‍﻿ ]/g, " "))
    .replace(/\s+/g, " ")
    .replace(/^[:\-–—.\s]+|[:\-–—.\s]+$/g, "")
    .trim();
}

// Rótulos aceitos por categoria do Mix de Vendas — comparados via normCel().
// Cada categoria é buscada PELO NOME, nunca pela posição da linha: um
// relatório pode listar Bebidas/Adicionais/Diversos em qualquer ordem.
const ALIASES_CATEGORIA = {
  sanduiches: ["sanduiches/saladas", "sanduiches / saladas", "sanduiche/salada", "sanduiches e saladas", "sanduiches", "saladas"],
  bebidas: ["bebidas", "bebida"],
  adicionais: ["adicionais", "adicional"],
  diversos: ["diversos", "diverso"],
  total: ["total"],
};
const CATEGORIAS_MIX = ["sanduiches", "bebidas", "adicionais", "diversos"];
const ROTULO_CATEGORIA = { sanduiches: "Sanduíches/Saladas", bebidas: "Bebidas", adicionais: "Adicionais", diversos: "Diversos" };
const ANCORA_SECAO = normCel("% de acompanhamentos em vendas principais");

/** A célula (já normalizada) É o rótulo desta categoria? */
function ehRotuloDe(categoria, normalizado) {
  return ALIASES_CATEGORIA[categoria].some((a) => normalizado === a || normalizado.replace(/[\s/]/g, "") === a.replace(/[\s/]/g, ""));
}

/**
 * Corrige rótulos que a extração do PDF quebrou em duas linhas de 1 célula
 * (ex.: "Sanduíches/" numa linha e "Saladas" na seguinte — item pedido
 * explicitamente: "Sanduíches/Saladas eventualmente separado por quebra de
 * linha"). Só funde quando a linha isolada NÃO é, sozinha, um rótulo válido
 * — nunca mexe em conteúdo que já faz sentido como está.
 * @param {string[][]} matriz
 * @returns {string[][]}
 */
function fundirRotulosQuebrados(matriz) {
  const out = [];
  for (let i = 0; i < matriz.length; i++) {
    const atual = matriz[i];
    const prox = matriz[i + 1];
    const jaEhRotulo = atual?.length === 1 && CATEGORIAS_MIX.some((c) => ehRotuloDe(c, normCel(atual[0])));
    const juntoVira = atual?.length === 1 && prox?.length === 1
      && CATEGORIAS_MIX.some((c) => ehRotuloDe(c, normCel(`${atual[0]} ${prox[0]}`)) || ehRotuloDe(c, normCel(`${atual[0]}${prox[0]}`)));
    if (!jaEhRotulo && juntoVira) {
      out.push([`${atual[0]} ${prox[0]}`.trim()]);
      i++; // linha seguinte já foi consumida na fusão
      continue;
    }
    out.push(atual);
  }
  return out;
}

/**
 * Busca, dentro de uma faixa [de, ate) da matriz, a QUANTIDADE de cada
 * categoria do Mix de Vendas — sempre pelo NOME da categoria, nunca por
 * posição fixa de linha. Cobre os formatos reais observados:
 *   1. ["Bebidas", "34"]                — rótulo e valor na mesma linha
 *   2. ["Bebidas"] seguido de ["34"]     — rótulo e valor em linhas separadas
 * Se um rótulo bater mas nenhum número "puro" (sem %) for encontrado perto
 * dele, a busca NÃO desiste da categoria — continua procurando outra
 * ocorrência do mesmo nome mais adiante (existe uma tabela de REFERÊNCIA de
 * mercado, mais acima no relatório, que também usa "Bebidas" como rótulo
 * mas só tem percentuais — nunca é confundida com a quantidade real porque
 * seus valores têm "%" e por isso nunca batem em numeroPuro()).
 * @param {string[][]} matriz já com fundirRotulosQuebrados aplicado
 * @param {number} de @param {number} ate
 */
function buscarCategoriasPorNome(matriz, de, ate) {
  const valores = {};
  const log = [];
  const fim = Math.min(ate, matriz.length);

  for (const categoria of CATEGORIAS_MIX) {
    for (let i = Math.max(de, 0); i < fim; i++) {
      const row = matriz[i] || [];
      if (!row.length || !ehRotuloDe(categoria, normCel(row[0]))) continue;

      let valor = row.length >= 2 ? numeroPuro(row[1]) : null;
      for (let j = i + 1; valor == null && j < Math.min(i + 4, fim); j++) {
        const r2 = matriz[j] || [];
        if (r2.length === 1) valor = numeroPuro(r2[0]);
        else break; // linha com mais de 1 célula não é "só o número" — não é isto
      }

      if (valor != null) {
        valores[categoria] = valor;
        log.push(`${ROTULO_CATEGORIA[categoria]} -> linha ${i} ("${row.join(" | ")}") = ${valor}`);
        break;
      }
      // rótulo bateu mas sem valor perto — provavelmente outra tabela
      // (ex.: o quadro de referência "Como deve ser meu Mix de vendas?",
      // que também tem uma linha "Bebidas" mas só com percentuais). Segue
      // procurando outra ocorrência do mesmo nome.
    }
  }
  return { valores, log };
}

/**
 * Percentuais que o PRÓPRIO PDF calculou (linhas soltas de 1 célula logo
 * após "Total") — só para a validação cruzada do item 11; o cálculo de
 * negócio NUNCA usa este valor, só as quantidades. Por isso é best-effort:
 * se a ordem das 3 categorias aqui não bater com a das quantidades acima,
 * o pior caso é um aviso de divergência impreciso — nunca um dado errado
 * gravado (ver bonificacaoMensal.service.js#processarImportacaoVisio).
 * @param {string[][]} matriz @param {number} de @param {number} ate
 */
function buscarPercentuaisDoTotal(matriz, de, ate) {
  const fim = Math.min(ate, matriz.length);
  let idxTotal = -1;
  for (let i = Math.max(de, 0); i < fim; i++) {
    const row = matriz[i] || [];
    if (row.length && ehRotuloDe("total", normCel(row[0]))) { idxTotal = i; break; }
  }
  if (idxTotal < 0) return {};

  const pcts = [];
  for (let j = idxTotal + 1; j < Math.min(idxTotal + 6, fim) && pcts.length < 4; j++) {
    const r = matriz[j];
    if (r && r.length === 1 && PCT_RE.test(r[0])) pcts.push(parsePct(r[0]));
    else if (pcts.length) break; // sequência já começou e quebrou — para
  }
  // A 1ª é sempre 100% (Sanduíches/Saladas é a base do mix) — as 3
  // seguintes, na ordem em que aparecem no PDF, são bebidas/adicionais/diversos.
  const [, percentualBebidasPdf = null, percentualAdicionaisPdf = null, percentualDiversosPdf = null] = pcts;
  return { percentualBebidasPdf, percentualAdicionaisPdf, percentualDiversosPdf };
}

/** pt-BR: ["Adicionais"] -> "Adicionais"; ["Adicionais","Diversos"] -> "Adicionais e Diversos". */
function listarPt(itens) {
  if (itens.length <= 1) return itens[0] ?? "";
  return `${itens.slice(0, -1).join(", ")} e ${itens[itens.length - 1]}`;
}

/**
 * Localiza a tabela "Torque por estabelecimento" (única fonte confiável de
 * Faturamento + PPD do relatório): 7 células numéricas na ordem fixa
 * [Fat. bruto, Torque bruto, Faturamento, PPD, Torque, Perdas, Produtos func.],
 * seguida (não necessariamente na linha imediatamente ao lado — o PDF
 * repete a tabela e o nome vem numa linha própria) pelo nome do
 * estabelecimento. A ordem das COLUNAS aqui é fixa pelo próprio layout da
 * Visio (é uma tabela real, não rótulos soltos que podem trocar de posição
 * como no Mix de Vendas) — não há o mesmo risco de reordenação.
 * @param {string[][]} matriz
 */
function extrairTorquePorEstabelecimento(matriz) {
  for (let i = 0; i < matriz.length; i++) {
    const row = matriz[i] || [];
    if (row.length !== 7) continue;
    if (!(MONEY_RE.test(row[0]) && MONEY_RE.test(row[1]) && MONEY_RE.test(row[2])
      && DECIMAL_RE.test(row[3]) && MONEY_RE.test(row[4]) && MONEY_RE.test(row[5]) && INT_RE.test(row[6]))) continue;

    // nome do estabelecimento: primeira linha de 1 célula, depois desta,
    // que não seja "Total" (a tabela costuma se repetir logo abaixo).
    let estabelecimento = null;
    for (let j = i + 1; j < Math.min(i + 8, matriz.length); j++) {
      const r = matriz[j];
      if (r && r.length === 1 && r[0].trim() && norm(r[0]) !== "total") { estabelecimento = r[0].trim(); break; }
    }
    return {
      fatBruto: parseBR(row[0]), torqueBruto: parseBR(row[1]), faturamento: parseBR(row[2]),
      ppd: parseBR(row[3]), torque: parseBR(row[4]), perdas: parseBR(row[5]), produtosFuncionais: parseBR(row[6]),
      estabelecimento,
    };
  }
  return null;
}

/**
 * Localiza as quantidades do Mix de Vendas — Sanduíches/Saladas, Bebidas,
 * Adicionais, Diversos — SEMPRE pelo nome de cada categoria, nunca pela
 * posição da linha (uma categoria pode vir em qualquer ordem entre
 * relatórios diferentes).
 *
 * Estratégia em 2 passos:
 *   1. Escopado à seção "% de acompanhamentos em vendas principais" — é
 *      onde a Visio sempre publica a quantidade de verdade, e escopar evita
 *      confundir com a tabela de REFERÊNCIA de mercado ("Como deve ser meu
 *      Mix de vendas?"), que aparece antes e também usa os mesmos rótulos,
 *      mas só com percentuais de benchmark (nunca quantidade).
 *   2. Fallback: documento inteiro, só para as categorias que a seção não
 *      resolveu. Seguro mesmo assim porque o valor buscado nunca tem "%"
 *      (ver numeroPuro) — a tabela de referência não pode ser confundida
 *      com a quantidade real mesmo sendo revarrida.
 *
 * Exportada (só ela, entre as funções internas deste arquivo) para dar pra
 * testar a resiliência — ordem trocada, rótulo quebrado, etc. — direto
 * contra uma matriz sintética, sem precisar de um PDF de verdade pra cada
 * variação de layout (ver bonificacao-mensal-visio-parser.test.js).
 *
 * @param {string[][]} matrizOriginal
 * @param {string} rotulo "Geral" | "Loja" | outro — só para os logs/erros
 */
export function extrairMixVendas(matrizOriginal, rotulo) {
  const matriz = fundirRotulosQuebrados(matrizOriginal);

  const idxSecao = matriz.findIndex((r) => r.some((c) => normCel(c) === ANCORA_SECAO || normCel(c).includes(ANCORA_SECAO)));
  logDebug(`[${rotulo}] seção "% de acompanhamentos em vendas principais": ${idxSecao >= 0 ? `encontrada na linha ${idxSecao}` : "NÃO encontrada — indo direto para o fallback no documento inteiro"}.`);

  let valores = {};
  if (idxSecao >= 0) {
    const r1 = buscarCategoriasPorNome(matriz, idxSecao, idxSecao + 15);
    valores = r1.valores;
    r1.log.forEach((l) => logDebug(`[${rotulo}] (seção)`, l));
  }

  const faltandoNaSecao = CATEGORIAS_MIX.filter((c) => valores[c] == null);
  if (faltandoNaSecao.length) {
    logDebug(`[${rotulo}] fallback (documento inteiro) para: ${faltandoNaSecao.map((c) => ROTULO_CATEGORIA[c]).join(", ")}.`);
    const r2 = buscarCategoriasPorNome(matriz, 0, matriz.length);
    r2.log.forEach((l) => logDebug(`[${rotulo}] (documento inteiro)`, l));
    valores = { ...r2.valores, ...valores }; // o que já foi achado na seção principal tem prioridade
  }

  const faltando = CATEGORIAS_MIX.filter((c) => valores[c] == null);
  if (faltando.length) logDebug(`[${rotulo}] categorias não localizadas: ${faltando.map((c) => ROTULO_CATEGORIA[c]).join(", ")}.`);

  const percentuais = idxSecao >= 0 ? buscarPercentuaisDoTotal(matriz, idxSecao, idxSecao + 15) : {};

  return {
    sanduichesSaladas: valores.sanduiches ?? null,
    bebidas: valores.bebidas ?? null,
    adicionais: valores.adicionais ?? null,
    diversos: valores.diversos ?? null,
    ...percentuais,
    faltando: faltando.map((c) => ROTULO_CATEGORIA[c]),
  };
}

/**
 * Parser central do relatório "Relatório de Produtos" da Visio.
 * @param {Buffer} buf
 * @param {{rotulo?: string}} [opts] rotulo = "Geral"/"Loja" — só enriquece as
 *   mensagens de erro (qual dos dois relatórios falhou); nunca muda a lógica.
 * @returns {Promise<{
 *   estabelecimento: string|null, faturamento: number, ppd: number,
 *   sandwichesSalads: number, beverages: number, additions: number, miscellaneous: number,
 *   percentualBebidasPdf: number|null, percentualAdicionaisPdf: number|null, percentualDiversosPdf: number|null,
 *   hash: string
 * }>}
 */
export async function parseVisioProductReport(buf, opts = {}) {
  const rotulo = opts.rotulo || null;
  const alvo = rotulo ? `no Relatório ${rotulo}` : "neste relatório";
  const matriz = await matrizDePdf(buf);

  const torque = extrairTorquePorEstabelecimento(matriz);
  if (!torque) {
    logDebug(`[${rotulo ?? "?"}] tabela "Torque por estabelecimento" não localizada — motivo mais comum: layout não é um Relatório de Produtos.`);
    throw ApiError.badRequest(`Não foi possível localizar o faturamento e o PPD ${alvo}. Confira se é um "Relatório de Produtos" exportado da Visio.`);
  }

  const mix = extrairMixVendas(matriz, rotulo ?? "?");
  if (mix.faltando.length) {
    const plural = mix.faltando.length > 1 ? "as quantidades de" : "a quantidade de";
    throw ApiError.badRequest(`Não foi possível localizar ${plural} ${listarPt(mix.faltando)} ${alvo}.`);
  }

  return {
    estabelecimento: torque.estabelecimento,
    faturamento: torque.faturamento,
    ppd: torque.ppd,
    sandwichesSalads: mix.sanduichesSaladas,
    beverages: mix.bebidas,
    additions: mix.adicionais,
    miscellaneous: mix.diversos,
    percentualBebidasPdf: mix.percentualBebidasPdf,
    percentualAdicionaisPdf: mix.percentualAdicionaisPdf,
    percentualDiversosPdf: mix.percentualDiversosPdf,
    hash: sha256(buf),
  };
}

// ---------------------------------------------------------------------
// "RELATÓRIO DE VENDAS" — novo formato do relatório Geral da Visio
// (substituiu o antigo "Relatório de Produtos" nesse slot; o Loja continua
// no formato antigo, parseVisioProductReport acima). Layout bem diferente:
// cards nomeados ("Faturamento"/"Cupons válidos"/"Cupons de vendas"/"Ticket
// médio") em vez da tabela "Torque por estabelecimento" — não tem PPD, mas
// tem Ticket Médio pela 1ª vez.
//
// Busca SEMPRE pelo nome do campo (normCel — já tolera espaço/acento/quebra
// de linha), nunca por posição — mesmo espírito de extrairMixVendas acima.
// ---------------------------------------------------------------------
const ROTULOS_VENDAS = {
  faturamento: [normCel("Faturamento")],
  cuponsValidos: [normCel("Cupons válidos")],
  cuponsVendas: [normCel("Cupons de vendas")],
  ticketMedio: [normCel("Ticket médio")],
};
const ANCORA_ESTABELECIMENTO_VENDAS = normCel("Detalhe de vendas por estabelecimento");
const ROTULOS_TABELA_ESTABELECIMENTO = new Set(["estabelecimento", "total", "vendas por estabelecimento"]);

/**
 * Testa se `s` (células já concatenadas, sem espaços) é um valor do tipo
 * pedido — devolve o número (parseBR) ou null.
 */
function valorDoTipo(s, tipo) {
  const j = String(s ?? "").replace(/\s+/g, "");
  if (tipo === "moeda") return MONEY_RE.test(j) ? parseBR(j) : null;
  return INT_RE.test(j) ? parseBR(j) : null;
}

/**
 * Acha o valor logo após um rótulo EXATO (linha de 1 célula, como nos cards
 * de resumo) — tolera o valor estar na mesma linha (rótulo + valor juntos)
 * OU na(s) linha(s) seguinte(s), item pedido explicitamente (12): não
 * depender da ordem dos elementos nem de quebras de linha.
 * @param {string[][]} matriz @param {string[]} aliasesNormalizados @param {'moeda'|'inteiro'} tipo
 */
function buscarValorAposRotulo(matriz, aliasesNormalizados, tipo) {
  for (let i = 0; i < matriz.length; i++) {
    const row = matriz[i] || [];
    if (!row.length) continue;
    if (!aliasesNormalizados.includes(normCel(row[0]))) continue;

    if (row.length > 1) {
      const v = valorDoTipo(row.slice(1).join(""), tipo);
      if (v != null) return v;
    }
    const prox = matriz[i + 1] || [];
    if (prox.length) {
      const v = valorDoTipo(prox.join(""), tipo);
      if (v != null) return v;
    }
  }
  return null;
}

/** Nome do estabelecimento na tabela "Detalhe de vendas por estabelecimento" — mesmo princípio de extrairTorquePorEstabelecimento. */
function extrairEstabelecimentoVendas(matriz) {
  const idxAncora = matriz.findIndex((r) => r.some((c) => {
    const n = normCel(c);
    return n === ANCORA_ESTABELECIMENTO_VENDAS || n.includes(ANCORA_ESTABELECIMENTO_VENDAS);
  }));
  const inicio = idxAncora >= 0 ? idxAncora + 1 : 0;
  for (let i = inicio; i < Math.min(inicio + 25, matriz.length); i++) {
    const row = matriz[i] || [];
    if (row.length !== 1) continue;
    const norm = normCel(row[0]);
    if (!norm || ROTULOS_TABELA_ESTABELECIMENTO.has(norm) || /^\d/.test(norm)) continue;
    return row[0].trim();
  }
  return null;
}

/**
 * Parser do "Relatório de Vendas" da Visio — novo formato do relatório
 * GERAL (item 3-4 e 12 das instruções). Fonte oficial de Faturamento e
 * Ticket Médio; Cupons válidos/de vendas ficam disponíveis pra auditoria
 * (item 3), sem entrar em nenhum cálculo de bonificação hoje.
 * @param {Buffer} buf
 * @param {{rotulo?: string}} [opts]
 * @returns {Promise<{estabelecimento: string|null, faturamento: number, ticketMedio: number, cuponsValidos: number|null, cuponsVendas: number|null, hash: string}>}
 */
export async function parseVisioSalesReport(buf, opts = {}) {
  const rotulo = opts.rotulo || null;
  const alvo = rotulo ? `no Relatório ${rotulo}` : "neste relatório";
  const matriz = await matrizDePdf(buf);

  const faturamento = buscarValorAposRotulo(matriz, ROTULOS_VENDAS.faturamento, "moeda");
  const ticketMedio = buscarValorAposRotulo(matriz, ROTULOS_VENDAS.ticketMedio, "moeda");
  const cuponsValidos = buscarValorAposRotulo(matriz, ROTULOS_VENDAS.cuponsValidos, "inteiro");
  const cuponsVendas = buscarValorAposRotulo(matriz, ROTULOS_VENDAS.cuponsVendas, "inteiro");
  const estabelecimento = extrairEstabelecimentoVendas(matriz);

  const faltando = [];
  if (faturamento == null) faltando.push("o Faturamento");
  if (ticketMedio == null) faltando.push("o Ticket Médio");
  if (faltando.length) {
    logDebug(`[${rotulo ?? "?"}] Relatório de Vendas — campos não localizados: ${faltando.join(", ")}.`);
    throw ApiError.badRequest(`Não foi possível localizar ${listarPt(faltando)} ${alvo}. Confira se é um "Relatório de Vendas" exportado da Visio.`);
  }

  return { estabelecimento, faturamento, ticketMedio, cuponsValidos, cuponsVendas, hash: sha256(buf) };
}

const MAX_ARQUIVO = 15 * 1024 * 1024; // 15 MB — mesmo limite de vendas/sw-parser.js
/** Decodifica e valida o PDF em base64 vindo do modal de importação. */
export function decodificarPdfVisio(arq, rotulo) {
  if (!/\.pdf$/i.test(arq?.nomeArquivo || "")) throw ApiError.badRequest(`O arquivo do Relatório ${rotulo} precisa ser um PDF.`);
  const buf = decodificarArquivo(arq, `Relatório ${rotulo}`);
  if (buf.length > MAX_ARQUIVO) throw ApiError.badRequest(`Arquivo do Relatório ${rotulo} acima de 15 MB.`);
  // assinatura mínima de PDF ("%PDF-") — nunca confiar só na extensão do nome.
  if (buf.slice(0, 5).toString("latin1") !== "%PDF-") throw ApiError.badRequest(`O arquivo do Relatório ${rotulo} não parece ser um PDF válido.`);
  return buf;
}
