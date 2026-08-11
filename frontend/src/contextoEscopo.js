// Escopo de contexto (empresa + unidade) no frontend.
//
// POR QUE ESTE MÓDULO EXISTE
//
// Os módulos de view guardam estado no nível do MÓDULO — `const dex = {...}`
// no Dashboard iFood, `const bm = {...}` na Bonificação Mensal, caches de
// lista em Vendas/Insumos. Um módulo ES é singleton: esse estado sobrevive
// a uma troca de unidade, porque trocar de unidade não recarrega a página.
//
// Isso produzia duas famílias de bug, ambas reais:
//
//   1. DADO ANTIGO NA TELA — ao entrar na unidade B, o que estava em memória
//      da unidade A continuava renderizado até a resposta nova chegar. Entre
//      organizações diferentes isso é vazamento de dado de outra empresa.
//
//   2. CORRIDA DE RESPOSTA — a requisição da unidade A demora, o usuário
//      troca para B, a resposta de B chega primeiro e a de A chega por
//      último, sobrescrevendo a tela com dados da unidade errada. O usuário
//      fica olhando B no cabeçalho e A no conteúdo.
//
// A solução tem duas partes, e as duas moram aqui:
//
//   * `registrarResetDeContexto(fn)` — cada módulo com estado registra como
//     zerar o que é dele. `resetarEscopoDeContexto()` chama todos de uma vez.
//     Assim app.js não precisa conhecer o estado interno de ninguém.
//
//   * `geracaoContexto()` / `contextoMudou(g)` — um contador que muda a cada
//     troca. Quem faz fetch guarda a geração ANTES do `await` e descarta o
//     resultado se ela mudou no meio. É o que mata a corrida do item 2.
//
// Não substitui o isolamento do servidor — lá o Context Token já garante que
// a API só devolve dados da unidade da sessão. Isto resolve o que é
// exclusivamente do cliente: memória que não deveria atravessar a troca.

/** Muda a cada troca de contexto. Nunca reseta para 0 — só cresce. */
let geracao = 0;

/** @type {Array<() => void>} */
const aoResetar = [];

/**
 * Registra a limpeza de estado de um módulo. Chame no topo do módulo, uma
 * única vez (o registro é global e vale enquanto a página viver).
 * @param {() => void} fn
 */
export function registrarResetDeContexto(fn) {
  if (typeof fn === "function") aoResetar.push(fn);
}

/** Geração atual — guarde ANTES de um await e confira depois com `contextoMudou`. */
export function geracaoContexto() {
  return geracao;
}

/**
 * O contexto mudou desde que `g` foi capturada? Se sim, a resposta em mãos é
 * de outra unidade/empresa e deve ser DESCARTADA (nunca renderizada).
 * @param {number} g
 */
export function contextoMudou(g) {
  return g !== geracao;
}

/**
 * Sobe a geração SEM limpar estado de módulo — usado no exato instante em que
 * o contexto muda de identidade (sessao.js#aplicarContexto e #limparContexto),
 * que acontece ANTES de app.js#mostrarApp montar a tela nova.
 *
 * Sem isto sobraria uma janela curta (a ida e volta de rede da seleção de
 * contexto) em que uma resposta 409 do contexto ANTERIOR ainda seria tratada
 * como válida — e apagaria o token da unidade recém-escolhida.
 */
export function invalidarGeracaoDeContexto() {
  geracao++;
}

/**
 * Invalida tudo o que pertencia ao contexto anterior: sobe a geração (as
 * respostas em voo passam a ser descartadas) e limpa o estado de cada módulo
 * registrado. Chamado por app.js#mostrarApp — o funil único por onde toda
 * entrada no shell do tenant passa (seleção de unidade, restauração de
 * sessão e impersonação).
 */
export function resetarEscopoDeContexto() {
  geracao++;
  for (const fn of aoResetar) {
    // Um módulo que falhe ao limpar não pode impedir os outros de limpar —
    // deixar estado sujo é justamente o bug que este arquivo combate.
    try { fn(); } catch (e) { console.error("[contexto] falha ao resetar um módulo:", e); }
  }
}
