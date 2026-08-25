// Busca de produto por NOME, com desambiguação — pura (sem I/O), separada
// para ser testável isoladamente. A consulta ao banco (candidatos amplos via
// ilike) fica no arquivo da tool; aqui só a decisão "único vs ambíguo vs não
// encontrado" a partir de uma lista já carregada.
//
// NUNCA escolhe silenciosamente entre vários produtos plausíveis — "cookie"
// com 3 cookies cadastrados devolve os 3 candidatos, não um palpite.
import { normalizarTexto } from "../../martinbrower/martinbrower.filtros.js";

/** Remove pontuação (b.m.t. -> bmt) por cima da normalização de acento/caixa já existente. */
function chaveComparavel(texto) {
  return normalizarTexto(texto).replace(/[.\-_/]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Distância de edição (Levenshtein) — só para tolerar pequenos erros de
 * grafia na busca (ex.: "teriaki" -> "teriyaki"), nunca para decidir sozinha
 * entre produtos genuinamente diferentes (ver TOLERANCIA_MAX abaixo).
 */
function distanciaEdicao(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** Tolerância de erro de grafia proporcional ao tamanho da PALAVRA (nunca mais que 3). */
const tolerancia = (tamanho) => Math.min(3, Math.max(1, Math.floor(tamanho * 0.2)));

/** Nível de casamento entre duas palavras já normalizadas, ou null se não casam. */
function nivelPalavra(pAlvo, pCand) {
  if (pCand === pAlvo) return 0;
  if (pCand.includes(pAlvo) || pAlvo.includes(pCand)) return 1;
  const dist = distanciaEdicao(pCand, pAlvo);
  return dist <= tolerancia(pAlvo.length) ? 2 : null;
}

/**
 * Escolhe o(s) produto(s) que casam com o termo de busca, dentre uma lista
 * de candidatos já carregada (ver produtoCmv.tool.js — a consulta ampla ao
 * banco acontece lá, isto aqui só decide).
 *
 * Casamento é POR PALAVRA, não pela string inteira — "frango teriaki" (2
 * palavras) precisa casar com AS DUAS palavras de "Frango Teriyaki 15cm"
 * (palavras extras no nome do produto, como "15cm", não atrapalham; uma
 * palavra do TERMO que não acha nada no produto descarta o candidato).
 * @param {Array<{id: string, nome: string}>} candidatos
 * @param {string} termoBusca
 * @returns {{status: 'unico', produto: object} | {status: 'ambiguo', candidatos: object[]} | {status: 'nao_encontrado'}}
 */
export function escolherCandidato(candidatos, termoBusca) {
  const alvoCompleto = chaveComparavel(termoBusca);
  if (!alvoCompleto || !candidatos?.length) return { status: "nao_encontrado" };
  const palavrasAlvo = alvoCompleto.split(" ").filter(Boolean);

  const pontuados = candidatos
    .map((c) => {
      const chaveCand = chaveComparavel(c.nome);
      if (chaveCand === alvoCompleto) return { candidato: c, nivel: 0 }; // atalho: string inteira idêntica

      const palavrasCand = chaveCand.split(" ").filter(Boolean);
      let piorNivel = 0;
      for (const pAlvo of palavrasAlvo) {
        let melhorParaEstaPalavra = null;
        for (const pCand of palavrasCand) {
          const nivel = nivelPalavra(pAlvo, pCand);
          if (nivel !== null && (melhorParaEstaPalavra === null || nivel < melhorParaEstaPalavra)) melhorParaEstaPalavra = nivel;
        }
        if (melhorParaEstaPalavra === null) return null; // palavra do termo sem correspondência -> descarta
        piorNivel = Math.max(piorNivel, melhorParaEstaPalavra);
      }
      return { candidato: c, nivel: piorNivel };
    })
    .filter(Boolean)
    .sort((a, b) => a.nivel - b.nivel);

  if (!pontuados.length) return { status: "nao_encontrado" };

  const melhorNivel = pontuados[0].nivel;
  const melhores = pontuados.filter((p) => p.nivel === melhorNivel).map((p) => p.candidato);

  if (melhores.length === 1) return { status: "unico", produto: melhores[0] };
  return { status: "ambiguo", candidatos: melhores };
}
