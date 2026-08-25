// Persistência do "modo de comparação" de tabela (Dashboard comum e
// Produtos/CMV) — DELIBERADAMENTE em sessionStorage, nunca como configuração
// da unidade: sobrevive a um F5 na mesma aba/unidade, mas nunca atravessa
// troca de unidade, logout ou uma aba nova. A tabela OFICIAL da unidade
// nunca passa por aqui — vem sempre do backend (ver api.js#obterTabelasComerciaisUnidade).
const CHAVE = "saci-comparacao-tabela";

/** @returns {{unidadeId: string, canal: string, tabela: string}|null} */
function ler() {
  try {
    const bruto = JSON.parse(sessionStorage.getItem(CHAVE) || "null");
    if (!bruto || typeof bruto !== "object") return null;
    if (typeof bruto.unidadeId !== "string" || typeof bruto.canal !== "string" || typeof bruto.tabela !== "string") return null;
    return bruto;
  } catch { return null; }
}

/** Comparação salva, SÓ se for da unidade informada — nunca de outra. */
export function comparacaoSalvaDaUnidade(unidadeId) {
  const salva = ler();
  return salva && salva.unidadeId === unidadeId ? { canal: salva.canal, tabela: salva.tabela } : null;
}

export function salvarComparacao({ unidadeId, canal, tabela }) {
  try { sessionStorage.setItem(CHAVE, JSON.stringify({ unidadeId, canal, tabela })); } catch { /* modo privado etc. — não é crítico */ }
}

export function limparComparacaoSalva() {
  try { sessionStorage.removeItem(CHAVE); } catch { /* ignora */ }
}
