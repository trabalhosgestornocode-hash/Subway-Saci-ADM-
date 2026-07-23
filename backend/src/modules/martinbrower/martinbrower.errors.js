// Erros específicos da integração Martin Brower.
//
// Cada erro carrega DOIS textos:
//   * codigo   — técnico, para log/auditoria (gravado em sincronizacoes.erro_codigo);
//   * message  — para o usuário final, em português claro, SEM jargão e SEM
//                nenhum dado sensível (senha, token, cookie).
//
// Estende ApiError para atravessar o errorHandler já existente sem adaptação.
import { ApiError } from "../../shared/ApiError.js";

export class MartinBrowerError extends ApiError {
  constructor(codigo, statusCode, message, details) {
    super(statusCode, message, details);
    this.name = "MartinBrowerError";
    this.codigo = codigo;
  }
}

// codigo -> [status HTTP, mensagem ao usuário]
const CATALOGO = {
  MARTIN_BROWER_NOT_CONFIGURED: [400,
    "A integração com a Martin Brower ainda não foi configurada para esta loja. Informe o código de cliente em Configurar integração."],
  MARTIN_BROWER_AUTH_FAILED: [401,
    "Não foi possível entrar no portal da Martin Brower. Confira o usuário e a senha e tente de novo."],
  MARTIN_BROWER_2FA_REQUIRED: [200,
    "O portal enviou um código de segurança. Informe o código para continuar."],
  MARTIN_BROWER_2FA_INVALID: [400,
    "O código de segurança informado não confere. Verifique e tente novamente."],
  MARTIN_BROWER_SESSION_EXPIRED: [440,
    "A sessão com o portal expirou. Inicie a sincronização novamente."],
  MARTIN_BROWER_ACCESS_DENIED: [403,
    "O portal recusou o acesso a esta loja. Verifique as permissões da sua conta na Martin Brower."],
  MARTIN_BROWER_CLIENT_NOT_FOUND: [404,
    "O código de cliente configurado não foi encontrado no portal da Martin Brower."],
  MARTIN_BROWER_ORDER_NOT_FOUND: [404,
    "Não há pedido disponível para esta loja no momento. Tente novamente quando a janela de pedido abrir."],
  MARTIN_BROWER_FINANCIAL_RESTRICTION: [409,
    "O portal indicou uma restrição financeira para esta loja. Regularize com a Martin Brower para liberar o pedido."],
  MARTIN_BROWER_CATALOG_INVALID: [502,
    "O portal devolveu o catálogo em um formato inesperado. Tente novamente em alguns minutos."],
  MARTIN_BROWER_RATE_LIMITED: [429,
    "Muitas tentativas em pouco tempo. Aguarde um minuto antes de tentar de novo."],
  MARTIN_BROWER_UNAVAILABLE: [503,
    "O portal da Martin Brower está indisponível no momento. Tente novamente mais tarde."],
  MARTIN_BROWER_SYNC_CONFLICT: [409,
    "Já existe uma sincronização em andamento para esta loja. Aguarde ela terminar ou cancele antes de iniciar outra."],
  MARTIN_BROWER_SYNC_CANCELLED: [499,
    "A sincronização foi cancelada."],
  MARTIN_BROWER_WORKER_DISABLED: [503,
    "A sincronização automática ainda não está habilitada neste ambiente."],

  // --- específicos do worker remoto (Fase 3) ---
  MARTIN_BROWER_REMOTE_SESSION_LOST: [410,
    "A sessão de sincronização foi perdida. Isso pode acontecer se o processo for reiniciado — inicie a sincronização novamente."],
  MARTIN_BROWER_MANUAL_VERIFICATION_REQUIRED: [423,
    "O portal da Martin Brower pediu uma verificação de segurança que precisa ser feita por uma pessoa. Acesse o portal diretamente, conclua a verificação e tente sincronizar de novo."],
  MARTIN_BROWER_WORKER_UNREACHABLE: [503,
    "Não foi possível falar com o serviço de sincronização. Tente novamente em alguns minutos."],
};

// Fábrica única: mbErro('MARTIN_BROWER_ORDER_NOT_FOUND') ou com detalhes/mensagem própria.
export function mbErro(codigo, { detalhes, mensagem } = {}) {
  const [status, msgPadrao] = CATALOGO[codigo] ?? [500, "Falha na integração com a Martin Brower."];
  return new MartinBrowerError(codigo, status, mensagem ?? msgPadrao, detalhes);
}

export const MB_ERROS = Object.freeze(
  Object.fromEntries(Object.keys(CATALOGO).map((k) => [k, k]))
);

// Traduz um status HTTP do portal para o erro de domínio correspondente.
// 401/403 NUNCA devem virar retry — quem chama usa isto para decidir.
export function erroPorStatusHttp(status) {
  if (status === 401) return mbErro(MB_ERROS.MARTIN_BROWER_SESSION_EXPIRED);
  if (status === 403) return mbErro(MB_ERROS.MARTIN_BROWER_ACCESS_DENIED);
  if (status === 404) return mbErro(MB_ERROS.MARTIN_BROWER_ORDER_NOT_FOUND);
  if (status === 429) return mbErro(MB_ERROS.MARTIN_BROWER_RATE_LIMITED);
  if (status >= 500) return mbErro(MB_ERROS.MARTIN_BROWER_UNAVAILABLE);
  return mbErro(MB_ERROS.MARTIN_BROWER_CATALOG_INVALID, { detalhes: { status } });
}

// Status HTTP que fazem sentido tentar de novo. 401/403/429 ficam de fora
// de propósito: repetir com sessão inválida só queima tentativa.
export function ehTransitorio(status) {
  return status >= 500 && status <= 599;
}
