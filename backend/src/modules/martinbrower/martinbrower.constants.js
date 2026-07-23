// Constantes da integração Martin Brower.
// Tudo que é "configuração de protocolo" mora aqui — nenhum valor de negócio
// (clientId, orderId, credencial) é fixado: eles vêm da configuração da
// unidade e da própria API, sempre.

export const MB_BASE_URL = "https://portal.martinbrower.com.br/mbbr/portal-api";
export const MB_PORTAL_URL = "https://portal.martinbrower.com.br/";

// Rotas confirmadas do portal (o orderId NUNCA é fixo — vem do findProxPedidoV2).
export const MB_ROTAS = {
  proximoPedido: (clientId) => `/order/findProxPedidoV2?clientId=${encodeURIComponent(clientId)}`,
  itens: (clientId, orderId, size = 1000) =>
    `/order/loadItens?size=${size}&orderId=${encodeURIComponent(orderId)}&clientId=${encodeURIComponent(clientId)}`,
};

export const MB_HTTP = {
  timeoutMs: 30_000,          // AbortController por chamada
  maxTentativas: 3,           // só para erros transitórios (5xx / rede)
  backoffBaseMs: 800,
  maxRespostaBytes: 12 * 1024 * 1024, // catálogo completo cabe folgado; corta resposta anômala
  pageSize: 1000,
};

// Status da sincronização — espelham os valores gravados em
// martin_brower_sincronizacoes.status e os estados da interface.
export const MB_STATUS = {
  AGUARDANDO: "aguardando",
  AUTENTICANDO: "autenticando",
  AGUARDANDO_CODIGO: "aguardando_codigo",
  IDENTIFICANDO_UNIDADE: "identificando_unidade",
  IDENTIFICANDO_PEDIDO: "identificando_pedido",
  COLETANDO: "coletando",
  NORMALIZANDO: "normalizando",
  SINCRONIZANDO: "sincronizando",
  CONCLUIDO: "concluido",
  ERRO: "erro",
  CANCELADO: "cancelado",
  EXPIRADO: "expirado",
};

export const MB_STATUS_FINAIS = new Set([
  MB_STATUS.CONCLUIDO, MB_STATUS.ERRO, MB_STATUS.CANCELADO, MB_STATUS.EXPIRADO,
]);

// Texto de progresso mostrado ao usuário durante a sincronização.
export const MB_ETAPAS = {
  INICIANDO_NAVEGADOR: "Iniciando navegador seguro",
  ABRINDO_PORTAL: "Abrindo Portal Martin Brower",
  AGUARDANDO_AUTENTICACAO: "Aguardando autenticação",
  AGUARDANDO_CODIGO: "Aguardando código de segurança",
  SESSAO_AUTENTICADA: "Sessão autenticada",
  IDENTIFICANDO_UNIDADE: "Identificando unidade",
  BUSCANDO_PEDIDO: "Buscando próximo pedido",
  PEDIDO_ENCONTRADO: "Pedido encontrado",
  CARREGANDO_CATALOGO: "Carregando catálogo",
  NORMALIZANDO: "Normalizando produtos",
  FILTRANDO: "Filtrando itens ignorados",
  COMPARANDO_PRECOS: "Comparando preços",
  ATUALIZANDO_BANCO: "Atualizando banco",
  FINALIZANDO: "Finalizando sincronização",
};

// Sessões temporárias do worker (memória do processo, nunca banco).
export const MB_SESSAO = {
  ttlMs: 10 * 60 * 1000,      // 10 minutos — expiração curta (política acordada)
  maxTentativasLogin: 3,
  maxTentativas2fa: 3,
  lockTtlMs: 15 * 60 * 1000,  // lock morre sozinho se o processo cair (Render hiberna)
};

// Rate limiting das rotas que recebem credenciais.
export const MB_RATE_LIMIT = {
  janelaMs: 60_000,
  maxPorUsuario: 5,
};

// Lotes do upsert — evita estourar o payload do PostgREST em catálogo grande.
export const MB_LOTE_UPSERT = 200;

// Worker remoto (Cloud Run). O backend nunca abre navegador: fala HTTP com um
// processo separado. Ver worker-martinbrower/ e docs/martin-brower-worker.md.
export const MB_WORKER = {
  // Maior que o fluxo completo (login + 2FA humano + coleta) e MENOR que o
  // --timeout do Cloud Run, para o worker responder erro tratado antes de o
  // Google cortar a conexão.
  timeoutPadraoMs: 300_000,
  // Janela do HMAC — precisa bater com a do worker.
  janelaHmacMs: 60_000,
};
