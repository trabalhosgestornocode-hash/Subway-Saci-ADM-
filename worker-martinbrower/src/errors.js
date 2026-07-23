// Contrato de erros do worker.
//
// Os códigos são os MESMOS do backend (martinbrower.errors.js) para que o
// adapter remoto possa repassá-los sem tradução — o usuário final vê a
// mensagem que o backend já sabe produzir.
//
// O worker NUNCA devolve mensagem técnica do Playwright ao backend: seletor
// que falhou, HTML da página e stack trace ficam só no log do worker.

export const CODIGOS = {
  AUTH_FAILED: "MARTIN_BROWER_AUTH_FAILED",
  DOIS_FA_REQUERIDO: "MARTIN_BROWER_2FA_REQUIRED",
  DOIS_FA_INVALIDO: "MARTIN_BROWER_2FA_INVALID",
  SESSAO_EXPIRADA: "MARTIN_BROWER_SESSION_EXPIRED",
  ACESSO_NEGADO: "MARTIN_BROWER_ACCESS_DENIED",
  PEDIDO_NAO_ENCONTRADO: "MARTIN_BROWER_ORDER_NOT_FOUND",
  CATALOGO_INVALIDO: "MARTIN_BROWER_CATALOG_INVALID",
  INDISPONIVEL: "MARTIN_BROWER_UNAVAILABLE",
  CANCELADA: "MARTIN_BROWER_SYNC_CANCELLED",
  CONFLITO: "MARTIN_BROWER_SYNC_CONFLICT",
  // Específicos do modelo remoto:
  SESSAO_PERDIDA: "MARTIN_BROWER_REMOTE_SESSION_LOST",
  VERIFICACAO_MANUAL: "MARTIN_BROWER_MANUAL_VERIFICATION_REQUIRED",
};

// status HTTP por código — o adapter usa para decidir se repete
const STATUS = {
  [CODIGOS.AUTH_FAILED]: 401,
  [CODIGOS.DOIS_FA_INVALIDO]: 400,
  [CODIGOS.SESSAO_EXPIRADA]: 440,
  [CODIGOS.ACESSO_NEGADO]: 403,
  [CODIGOS.PEDIDO_NAO_ENCONTRADO]: 404,
  [CODIGOS.CATALOGO_INVALIDO]: 502,
  [CODIGOS.INDISPONIVEL]: 503,
  [CODIGOS.CANCELADA]: 499,
  [CODIGOS.CONFLITO]: 409,
  [CODIGOS.SESSAO_PERDIDA]: 410,
  [CODIGOS.VERIFICACAO_MANUAL]: 423,
};

export class WorkerError extends Error {
  constructor(codigo, detalheInterno) {
    super(codigo);
    this.name = "WorkerError";
    this.codigo = codigo;
    this.status = STATUS[codigo] ?? 500;
    // Fica SÓ no log do worker; nunca entra na resposta HTTP.
    this.detalheInterno = detalheInterno;
  }
}

export const erro = (codigo, detalheInterno) => new WorkerError(codigo, detalheInterno);
