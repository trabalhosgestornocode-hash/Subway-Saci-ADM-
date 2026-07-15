// Leitura real dos relatórios do SW no BACKEND (CSV, Excel e PDF).
// O frontend só envia o arquivo em base64; toda a interpretação acontece aqui,
// para que importação manual, API ou integrações usem exatamente a mesma lógica.
import crypto from "node:crypto";
import { ApiError } from "../../shared/ApiError.js";

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
// cabeçalho do SW: tira acentos, sufixos +/-/= e ".", colapsa espaços
export const normH = (s) => norm(s).replace(/[+\-=.]/g, " ").replace(/\s+/g, " ").trim();

export function parseBR(v) {
  if (typeof v === "number") return v;
  let s = String(v || "").replace(/[R$\s]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

export function acharData(matriz) {
  for (const row of matriz) for (const cell of row || []) {
    const s = String(cell);
    const m = s.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/) || s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[3]?.length === 4 ? `${m[3]}-${m[2]}-${m[1]}` : `${m[1]}-${m[2]}-${m[3]}`;
  }
  return null;
}

// ---------- arquivo -> matriz (linhas x colunas) ----------
function matrizDeCsv(texto) {
  const primeira = texto.split("\n")[0] || "";
  const delim = (primeira.match(/;/g) || []).length >= (primeira.match(/,/g) || []).length ? ";" : ",";
  return texto.split(/\r?\n/).filter((l) => l.trim())
    .map((l) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, "")));
}

async function matrizDeExcel(buf) {
  const { read, utils } = await import("xlsx");
  const wb = read(buf, { type: "buffer" });
  return utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: true });
}

// PDF: extrai o texto e reconstitui colunas. Colunas separadas por 2+ espaços;
// quando a linha vem "colada" (1 célula), destaca os números do final
// (ex.: "101 - FRANGO TERIYAKI 15CM 122 2.318,00" -> 3 células).
export function textoParaMatriz(texto) {
  const linhas = String(texto || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return linhas.map((l) => {
    let cels = l.split(/\s{2,}|\t/).map((c) => c.trim()).filter((c) => c !== "");
    if (cels.length === 1) cels = explodirNumerosFinais(cels[0]);
    return cels;
  });
}
const RE_NUM_TOKEN = /^-?(?:R\$)?\d{1,3}(?:\.\d{3})*(?:,\d+)?%?$|^-?\d+(?:[.,]\d+)?%?$/;
export function explodirNumerosFinais(linha) {
  const tokens = String(linha).trim().split(/\s+/);
  const nums = [];
  while (tokens.length > 1 && RE_NUM_TOKEN.test(tokens[tokens.length - 1])) nums.unshift(tokens.pop());
  const resto = tokens.join(" ");
  return resto ? [resto, ...nums] : nums;
}

// pdf-parse padrão cola as colunas ("Produtos +2.290,30"); este pagerender
// preserva as colunas inserindo TAB entre itens de texto da mesma linha (mesmo Y).
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
    throw ApiError.badRequest("Leitor de PDF indisponível no servidor — exporte o relatório em Excel ou CSV.");
  }
  const { text } = await pdfParse(buf, { pagerender: renderPaginaComColunas });
  const matriz = textoParaMatriz(text);
  if (!matriz.length) throw ApiError.badRequest("Não consegui extrair texto deste PDF (pode ser digitalizado/imagem). Exporte o relatório em Excel ou CSV.");
  return matriz;
}

export async function lerMatriz(buf, nomeArquivo) {
  const ext = String(nomeArquivo || "").toLowerCase().split(".").pop();
  if (ext === "pdf") return matrizDePdf(buf);
  if (ext === "xlsx" || ext === "xls") return matrizDeExcel(buf);
  return matrizDeCsv(buf.toString("utf8"));
}

// ---------- Relatório 1 — Análise de Faturamento ----------
export const ALIAS_FATURAMENTO = {
  produtos: "produtos", repiques: "repiques", servicos: "servicos",
  "tx entregas": "taxasEntrega", "taxas de entrega": "taxasEntrega", "taxa de entrega": "taxasEntrega", taxas: "taxasEntrega",
  creditos: "creditos", descontos: "descontos", combos: "combos", especiais: "especiais",
  cortesias: "cortesias", assinadas: "assinadas", total: "total", faturamento: "faturamento", diferenca: "diferenca",
};

export function interpretarFaturamento(matriz) {
  const campos = { produtos: 0, repiques: 0, servicos: 0, taxasEntrega: 0, creditos: 0, descontos: 0, combos: 0, especiais: 0, cortesias: 0, assinadas: 0, total: 0, faturamento: 0, diferenca: 0 };
  const hi = matriz.findIndex((r) => (r || []).filter((c) => ALIAS_FATURAMENTO[normH(c)]).length >= 3);
  let achou = false;
  if (hi >= 0) {
    const header = matriz[hi];
    for (let r = hi + 1; r < matriz.length; r++) {          // 1ª linha com números = valores puros
      const dr = matriz[r];
      if (!dr || !dr.some((c) => /\d/.test(String(c)))) continue;
      header.forEach((c, i) => {
        const k = ALIAS_FATURAMENTO[normH(c)];
        if (k && dr[i] !== undefined && String(dr[i]).trim() !== "") campos[k] = parseBR(dr[i]);
      });
      achou = true; break;
    }
  }
  if (!achou) { // fallback: pares rótulo/valor (layout 2 colunas — comum no PDF)
    for (const row of matriz) for (let i = 0; i < (row || []).length - 1; i++) {
      const k = ALIAS_FATURAMENTO[normH(row[i])];
      if (k) { campos[k] = parseBR(row[i + 1]); achou = true; }
    }
  }
  if (!achou) throw ApiError.badRequest("Não reconheci o relatório de Análise de Faturamento (campos Produtos/Total/Faturamento não encontrados). Confira o arquivo ou exporte em Excel/CSV.");
  return campos;
}

export async function lerFaturamento(buf, nomeArquivo) {
  const matriz = await lerMatriz(buf, nomeArquivo);
  return { ...interpretarFaturamento(matriz), dataMovimento: acharData(matriz), hash: sha256(buf), nomeArquivo };
}

// ---------- Relatório 2 — Venda de Produtos por Grupo ----------
export const TOP_GRUPOS = new Set(["bebidas", "chips e cookies", "etapas", "extras", "insumos", "saladas", "sanduiches", "sobremesas", "taxas e descontos", "combos"]);
const ehNumeroCel = (c) => c !== "" && /\d/.test(c) && !/[a-zA-Z]/.test(String(c).replace(/r\$/gi, "")) && !String(c).includes("%");

export function interpretarProdutos(matriz) {
  let hi = matriz.findIndex((r) => (r || []).some((c) => norm(c) === "produto"));
  if (hi < 0) hi = 0;
  const linhas = []; let grupo = null;
  for (let r = hi + 1; r < matriz.length; r++) {
    const row = (matriz[r] || []).map((c) => String(c).trim());
    if (row.every((c) => c === "")) continue;
    if (/^\(\d+\)/.test(row[0] || "") || row.some((c) => c.includes("%"))) continue;   // subtotal do SW
    const pi = row.findIndex((c) => /^\d{2,}\s*-\s*\S/.test(c));                        // "código-nome"
    if (pi >= 0) {
      const mp = row[pi].match(/^(\d+)\s*-\s*(.+)$/);
      const nums = row.filter((c, i) => i !== pi && ehNumeroCel(c)).map(parseBR);
      linhas.push({ codigoSw: mp[1], nomeSw: mp[2].trim(), grupo, quantidade: nums[0] ?? 0, valorTotal: nums.length ? nums[nums.length - 1] : 0 });
      continue;
    }
    const texto = row.filter((c) => c !== "");                                          // linha-título (grupo/subgrupo)
    if (texto.length && !row.some(ehNumeroCel)) {
      const lbl = texto.join(" ").trim();
      if (TOP_GRUPOS.has(norm(lbl))) grupo = lbl;
    }
  }
  if (!linhas.length) throw ApiError.badRequest("Não encontrei produtos no relatório (esperado o formato do SW: grupos + linhas 'código-nome | qtd | total'). Confira o arquivo ou exporte em Excel/CSV.");
  return linhas;
}

export async function lerProdutos(buf, nomeArquivo) {
  const matriz = await lerMatriz(buf, nomeArquivo);
  return { linhas: interpretarProdutos(matriz), dataMovimento: acharData(matriz), hash: sha256(buf), nomeArquivo };
}

// ---------- entrada da API: arquivo base64 -> relatório interpretado ----------
const MAX_ARQUIVO = 15 * 1024 * 1024; // 15 MB
export function decodificarArquivo(arq, rotulo) {
  if (!arq?.conteudoBase64) throw ApiError.badRequest(`Arquivo do relatório de ${rotulo} sem conteúdo.`);
  const buf = Buffer.from(arq.conteudoBase64, "base64");
  if (!buf.length) throw ApiError.badRequest(`Arquivo do relatório de ${rotulo} vazio ou corrompido.`);
  if (buf.length > MAX_ARQUIVO) throw ApiError.badRequest(`Arquivo do relatório de ${rotulo} acima de 15 MB.`);
  return buf;
}
