// Registro de resolvers de navegação do Agente Crescer (Etapa F.1) — folha
// pura, ZERO imports, mesmo padrão de contextoEscopo.js#registrarResetDeContexto.
//
// POR QUE ESTE ARQUIVO EXISTE (evitar import circular): o motor do chat
// (agenteChat.js) precisa executar uma navegação de destino específico (abrir
// O PRODUTO certo, não só a tela), mas quem sabe fazer isso é cada view
// (produtoModal.js, insumoModal.js, parserFoodDelivery.js) — e essas views já
// importam agentePainel.js (botão contextual), que importa agenteChat.js.
// Se agenteChat.js importasse essas views de volta pra navegar, seria um
// ciclo. Em vez disso, app.js (o topo do grafo de imports — nada o importa de
// volta) registra os resolvers uma vez no boot; agenteChat.js só CONSOME.
//
// Um resolver NUNCA constrói URL — só chama código real do Crescer
// (irPara/abrirProdutoModal/etc.), com os `params` já validados pelo backend
// (agente.acoes.js#resolverAcao). Se nenhum resolver estiver registrado pra
// um target, a action simplesmente não navega (nunca lança, nunca inventa
// comportamento).

/** @type {Record<string, (params: Record<string,string>) => void|Promise<void>>} */
const resolvedores = {};

/**
 * @param {string} target
 * @param {(params: Record<string,string>) => void|Promise<void>} fn
 */
export function registrarResolverAcao(target, fn) {
  resolvedores[target] = fn;
}

/** @param {string} target @returns {((params: Record<string,string>) => void|Promise<void>)|undefined} */
export function obterResolverAcao(target) {
  return resolvedores[target];
}

/** Só pra teste/depuração — nunca use em produção pra decidir navegação. */
export function targetsRegistrados() {
  return Object.keys(resolvedores);
}
