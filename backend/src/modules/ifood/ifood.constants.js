// Constantes da integração oficial iFood.
//
// "Configuração de protocolo" mora aqui. Nenhum valor de negócio (clientId,
// clientSecret, merchantId, token) é fixado — eles vêm de ENV ou da própria
// API, sempre.
//
// A base URL é lida de process.env DIRETO (com default), não de config/env.js:
// mantém este módulo — e os testes do http client — desacoplados do resto da
// configuração. Um teste pode apontar IFOOD_API_BASE_URL para um mock.

export const IFOOD_API_BASE_URL_PADRAO = "https://merchant-api.ifood.com.br";

export function ifoodBaseUrl() {
  return (process.env.IFOOD_API_BASE_URL || IFOOD_API_BASE_URL_PADRAO).replace(/\/+$/, "");
}

// Rotas confirmadas (ver brief da integração). Merchant só é consumido em
// modo LEITURA nesta fase — nada de interrupções / opening-hours / preparo.
export const IFOOD_ROTAS = {
  userCode: "/authentication/v1.0/oauth/userCode",
  token: "/authentication/v1.0/oauth/token",
  merchants: (page = 1, size = 100) =>
    `/merchant/v1.0/merchants?page=${encodeURIComponent(page)}&size=${encodeURIComponent(size)}`,
  merchant: (merchantId) => `/merchant/v1.0/merchants/${encodeURIComponent(merchantId)}`,
  merchantStatus: (merchantId) => `/merchant/v1.0/merchants/${encodeURIComponent(merchantId)}/status`,
};

// Os dois aplicativos distribuídos. `analytics` PODE ser autorizado nesta
// fase, mas nenhum dado de Analytics é consumido.
export const IFOOD_APPS = Object.freeze({ ANALYTICS: "analytics", FINANCIAL: "financial" });
export const IFOOD_APP_TYPES = Object.freeze(Object.values(IFOOD_APPS));

// grantType do corpo x-www-form-urlencoded (camelCase, conforme o iFood).
export const IFOOD_GRANT = Object.freeze({
  AUTHORIZATION_CODE: "authorization_code",
  REFRESH_TOKEN: "refresh_token",
});

export const IFOOD_HTTP = {
  timeoutMs: 20_000,           // AbortController por chamada
  maxTentativas: 3,            // só para 5xx / rede / 429-com-Retry-After
  backoffBaseMs: 700,
  maxRetryAfterMs: 30_000,     // teto do respeito ao Retry-After (não trava a request)
  maxRespostaBytes: 4 * 1024 * 1024,
  pageSizePadrao: 100,        // GET /merchants
  pageSizeMax: 200,
  // Teto de páginas percorridas em GET /merchants — trava contra loop se a
  // API nunca sinalizar "última página". 50 * 100 = 5000 lojas.
  maxPaginas: 50,
};

// Renovação de token: se faltar MENOS que isto para expirar, renova antes de usar.
export const IFOOD_TOKEN = {
  margemRenovacaoMs: 10 * 60 * 1000,   // 10 min
  // accessToken do iFood normalmente expira em 21600s (6h) — usado só como
  // fallback se a resposta vier sem expiresIn.
  expiresInPadraoS: 21_600,
};

// Sessão OAuth (userCode) expira em ~10 min no iFood. Guardamos o mesmo teto
// como fallback caso a resposta venha sem expiresIn.
export const IFOOD_OAUTH = {
  ttlPadraoS: 600,
};

// Rate limit das rotas que iniciam/concluem autorização.
export const IFOOD_RATE_LIMIT = {
  janelaMs: 60_000,
  maxStart: 5,
  maxComplete: 10,
  maxMerchants: 20,   // descoberta/detalhe de merchant (chamam a API externa)
};
