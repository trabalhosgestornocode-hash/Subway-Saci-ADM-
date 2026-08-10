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
import { sha256, norm, parseBR, textoParaMatriz, decodificarArquivo } from "../vendas/sw-parser.js";

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
  return matriz;
}

// ---------- reconhecimento de células ----------
const MONEY_RE = /^(?:r\$|\$)\s?-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?$/i;
const INT_RE = /^\d+$/;
const PCT_RE = /^-?\d{1,3}(?:[.,]\d+)?%$/;

const parsePct = (s) => (s == null ? null : parseBR(String(s).replace("%", "")));

// Rótulos aceitos por campo — tolerante a maiúsculas/acentos (comparados via norm()).
const ROTULO = {
  sanduiches: "sanduiches/saladas",
  bebidas: "bebidas",
  adicionais: "adicionais",
  diversos: "diversos",
  total: "total",
};

/**
 * Localiza a tabela "Torque por estabelecimento" (única fonte confiável de
 * Faturamento + PPD do relatório): 7 células numéricas na ordem fixa
 * [Fat. bruto, Torque bruto, Faturamento, PPD, Torque, Perdas, Produtos func.],
 * seguida (não necessariamente na linha imediatamente ao lado — o PDF
 * repete a tabela e o nome vem numa linha própria) pelo nome do
 * estabelecimento.
 * @param {string[][]} matriz
 */
function extrairTorquePorEstabelecimento(matriz) {
  for (let i = 0; i < matriz.length; i++) {
    const row = matriz[i] || [];
    if (row.length !== 7) continue;
    if (!(MONEY_RE.test(row[0]) && MONEY_RE.test(row[1]) && MONEY_RE.test(row[2])
      && INT_RE.test(row[3]) && MONEY_RE.test(row[4]) && MONEY_RE.test(row[5]) && INT_RE.test(row[6]))) continue;

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
 * Localiza a tabela "% de acompanhamentos em vendas principais":
 *   Sanduíches/Saladas | qtd
 *   Bebidas             | qtd
 *   Adicionais          | qtd
 *   Diversos            | qtd
 *   Total               | qtd | pct%
 *   <4 linhas de 1 célula, na mesma ordem: %sanduíches, %bebidas, %adicionais, %diversos>
 * As 4 últimas são o percentual que O PRÓPRIO PDF calculou — guardadas só
 * para a validação cruzada do item 11; o cálculo de negócio nunca as usa.
 * @param {string[][]} matriz
 */
function extrairMixVendas(matriz) {
  const idx = matriz.findIndex((r) => r?.length >= 2 && norm(r[0]) === ROTULO.sanduiches && INT_RE.test(String(r[1]).trim()));
  if (idx < 0) return null;

  const linhaCategoria = (offset, chave) => {
    const r = matriz[idx + offset];
    if (!r || r.length < 2 || norm(r[0]) !== chave || !INT_RE.test(String(r[1]).trim())) return null;
    return parseBR(r[1]);
  };
  const sanduichesSaladas = parseBR(matriz[idx][1]);
  const bebidas = linhaCategoria(1, ROTULO.bebidas);
  const adicionais = linhaCategoria(2, ROTULO.adicionais);
  const diversos = linhaCategoria(3, ROTULO.diversos);
  if (bebidas == null || adicionais == null || diversos == null) return null;

  // percentuais do próprio PDF (linhas de 1 célula logo após "Total")
  const totalRow = matriz[idx + 4];
  let cursor = idx + 5;
  if (totalRow && totalRow.length === 1 && PCT_RE.test(totalRow[0])) cursor = idx + 4; // layout sem linha "Total" separada
  const pcts = [];
  for (let j = cursor; j < Math.min(cursor + 4, matriz.length); j++) {
    const r = matriz[j];
    if (r && r.length === 1 && PCT_RE.test(r[0])) pcts.push(parsePct(r[0]));
    else break;
  }
  const [, percentualBebidasPdf = null, percentualAdicionaisPdf = null, percentualDiversosPdf = null] = pcts.length === 4 ? pcts : [];

  return { sanduichesSaladas, bebidas, adicionais, diversos, percentualBebidasPdf, percentualAdicionaisPdf, percentualDiversosPdf };
}

/**
 * Parser central do relatório "Relatório de Produtos" da Visio.
 * @param {Buffer} buf
 * @returns {Promise<{
 *   estabelecimento: string|null, faturamento: number, ppd: number,
 *   sandwichesSalads: number, beverages: number, additions: number, miscellaneous: number,
 *   percentualBebidasPdf: number|null, percentualAdicionaisPdf: number|null, percentualDiversosPdf: number|null,
 *   hash: string
 * }>}
 */
export async function parseVisioProductReport(buf) {
  const matriz = await matrizDePdf(buf);

  const torque = extrairTorquePorEstabelecimento(matriz);
  if (!torque) throw ApiError.badRequest("Não foi possível localizar o faturamento e o PPD neste relatório. Confira se é um \"Relatório de Produtos\" exportado da Visio.");

  const mix = extrairMixVendas(matriz);
  if (!mix) throw ApiError.badRequest("Não foi possível localizar as quantidades de Sanduíches/Saladas, Bebidas, Adicionais e Diversos neste relatório.");

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
