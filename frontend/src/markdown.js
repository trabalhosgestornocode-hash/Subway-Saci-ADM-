// Markdown MÍNIMO e SEGURO para as respostas do Agente Crescer.
//
// Sem lib externa: o projeto não tem bundler/npm no frontend (ES modules
// carregados direto pelo navegador, ver icons.js "nunca ícone de CDN
// externo") — importar uma lib de markdown exigiria CDN ou vendorizar um
// arquivo gigante, então escrevemos só o subconjunto que o Agente realmente
// usa (negrito, itálico, código inline, listas, títulos, quebras de linha).
//
// SEGURANÇA: `escapeHtml` roda ANTES de qualquer transformação — nenhum
// caractere `< > & " '` do texto do modelo sobrevive. As transformações
// abaixo só ENVOLVEM o texto já escapado em tags FIXAS (nunca atributos
// vindos do texto), então não existe caminho para HTML/script arbitrário
// do modelo virar DOM real. Ex.: "<script>alert(1)</script>" volta como
// texto literal "&lt;script&gt;..." — nunca executa.
import { escapeHtml } from "./utils.js";

/** @param {string} texto @returns {string} HTML seguro, pronto para innerHTML */
export function renderizarMarkdownSeguro(texto) {
  const linhas = escapeHtml(texto ?? "").split("\n");
  const blocos = [];
  let listaAtual = null;

  const fecharLista = () => {
    if (listaAtual) { blocos.push(`<ul>${listaAtual.join("")}</ul>`); listaAtual = null; }
  };

  for (const linhaBruta of linhas) {
    const linha = linhaBruta.trim();
    const item = linha.match(/^[-*]\s+(.+)/);
    if (item) { (listaAtual ??= []).push(`<li>${formatarInline(item[1])}</li>`); continue; }
    fecharLista();

    if (!linha) { blocos.push(""); continue; }
    const titulo = linha.match(/^#{1,4}\s+(.+)/);
    blocos.push(titulo ? `<strong class="md-titulo">${formatarInline(titulo[1])}</strong>` : formatarInline(linha));
  }
  fecharLista();

  // Colapsa linhas em branco repetidas (evita <br> empilhados) e junta o resto.
  return blocos.filter((b, i) => b !== "" || blocos[i - 1] !== "").join("<br>");
}

/** Negrito, itálico e código inline — só sobre texto JÁ escapado. */
function formatarInline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
}
