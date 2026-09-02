// Erros específicos da integração iFood.
//
// Cada erro carrega DOIS textos:
//   * codigo   — técnico, para log/auditoria (nunca contém segredo);
//   * message  — para o usuário final, em português claro, SEM jargão e SEM
//                nenhum dado sensível (secret, token, authorizationCode,
//                merchantId completo).
//
// Estende ApiError para atravessar o errorHandler já existente sem adaptação.
import { ApiError } from "../../shared/ApiError.js";

export class IfoodError extends ApiError {
  constructor(codigo, statusCode, message, details) {
    super(statusCode, message, details);
    this.name = "IfoodError";
    this.codigo = codigo;
  }
}

// codigo -> [status HTTP, mensagem ao usuário]
const CATALOGO = {
  IFOOD_APP_TYPE_INVALIDO: [400,
    "Aplicativo iFood inválido. Escolha entre desempenho (Analytics) e financeiro (Financial)."],
  IFOOD_APP_SEM_CREDENCIAL: [503,
    "As credenciais deste aplicativo iFood não estão configuradas neste ambiente. Fale com o suporte da plataforma."],
  IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA: [404,
    "Não encontramos essa solicitação de autorização. Gere um novo código e tente novamente."],
  IFOOD_OAUTH_SESSAO_EXPIRADA: [400,
    "O código de vínculo expirou. Gere outro código."],
  IFOOD_OAUTH_SESSAO_JA_USADA: [409,
    "Essa autorização já foi concluída ou cancelada. Gere um novo código se precisar reconectar."],
  IFOOD_OAUTH_CODIGO_INVALIDO: [400,
    "Não foi possível concluir a autorização. Verifique o código de autorização fornecido pelo iFood e tente novamente, ou gere um novo código."],
  IFOOD_USER_CODE_FALHOU: [502,
    "Não foi possível gerar o código de vínculo com o iFood. Tente novamente em alguns minutos."],
  IFOOD_TOKEN_TROCA_FALHOU: [502,
    "Não foi possível concluir a autorização com o iFood. Gere um novo código e tente novamente."],
  IFOOD_TOKEN_EXPIRADO: [401,
    "Nossa conexão com o iFood expirou. Reconecte sua conta."],
  IFOOD_REFRESH_FALHOU: [401,
    "Nossa conexão com o iFood expirou e não foi possível renová-la. Reconecte sua conta."],
  IFOOD_CONEXAO_NAO_ENCONTRADA: [404,
    "Esta loja ainda não tem uma conexão com o iFood."],
  IFOOD_CREDENCIAL_NAO_ENCONTRADA: [404,
    "Este aplicativo iFood ainda não foi autorizado para esta loja."],

  // --- Merchant (blocos D/E) ---
  IFOOD_SEM_MERCHANT: [404,
    "Esta conta iFood não possui acesso a nenhuma loja."],
  IFOOD_MERCHANT_SEM_PERMISSAO: [403,
    "Você não tem permissão para vincular esta loja."],
  IFOOD_MERCHANT_NAO_ENCONTRADO: [404,
    "Não foi possível confirmar essa loja no iFood. Tente novamente."],
  IFOOD_VINCULO_DUPLICADO: [409,
    "Esta loja do iFood já está vinculada a outra unidade."],

  // --- transporte ---
  IFOOD_REQUISICAO_INVALIDA: [400,
    "O iFood recusou a requisição. Tente novamente; se persistir, fale com o suporte."],
  IFOOD_RATE_LIMITED: [429,
    "Muitas tentativas em pouco tempo. Aguarde um instante antes de tentar de novo."],
  IFOOD_INDISPONIVEL: [503,
    "O iFood está indisponível no momento. Tente novamente mais tarde."],
  IFOOD_RESPOSTA_INVALIDA: [502,
    "O iFood devolveu uma resposta em um formato inesperado. Tente novamente em alguns minutos."],
  IFOOD_CANCELADO: [499, "A operação foi cancelada."],
};

/** Fábrica única: ifoodErro('IFOOD_SEM_MERCHANT') ou com detalhes/mensagem própria. */
export function ifoodErro(codigo, { detalhes, mensagem } = {}) {
  const [status, msgPadrao] = CATALOGO[codigo] ?? [500, "Falha na integração com o iFood."];
  return new IfoodError(codigo, status, mensagem ?? msgPadrao, detalhes);
}

export const IFOOD_ERROS = Object.freeze(
  Object.fromEntries(Object.keys(CATALOGO).map((k) => [k, k]))
);

// Traduz um status HTTP do iFood para o erro de domínio correspondente.
// 400/401/403 NUNCA viram retry — quem chama usa isto para decidir.
export function erroPorStatusHttp(status, { contexto } = {}) {
  if (status === 400) {
    // No fluxo OAuth, 400 quase sempre é "authorizationCode/verifier inválido".
    return ifoodErro(contexto === "oauth" ? IFOOD_ERROS.IFOOD_OAUTH_CODIGO_INVALIDO : IFOOD_ERROS.IFOOD_REQUISICAO_INVALIDA);
  }
  if (status === 401) return ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
  if (status === 403) return ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO);
  if (status === 404) return ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_NAO_ENCONTRADO);
  if (status === 429) return ifoodErro(IFOOD_ERROS.IFOOD_RATE_LIMITED);
  if (status >= 500) return ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL);
  return ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { status } });
}

// Status que vale a pena repetir. 400/401/403/404 ficam de fora de propósito.
export function ehTransitorio(status) {
  return status === 429 || (status >= 500 && status <= 599);
}
