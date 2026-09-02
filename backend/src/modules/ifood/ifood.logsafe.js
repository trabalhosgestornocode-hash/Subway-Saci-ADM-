// Sanitização de logs da integração iFood.
//
// REGRA ABSOLUTA: nada que passe por aqui pode conter clientSecret, clientId,
// accessToken, refreshToken, authorizationCode, authorizationCodeVerifier,
// userCode, header Authorization ou JWT. Todo log da integração passa por
// ifoodLog()/sanitizar() — nunca use console.* direto no módulo.
//
// Mesmo desenho de martinbrower.logsafe.js (o padrão do projeto), adaptado
// ao vocabulário do iFood.

const CHAVES_PROIBIDAS = [
  "password", "senha",
  "authorization", "auth", "bearer",
  "token", "accesstoken", "access_token", "refreshtoken", "refresh_token",
  "jwt", "idtoken", "id_token",
  "clientsecret", "client_secret", "clientid", "client_id",
  "authorizationcode", "authorization_code",
  "authorizationcodeverifier", "authorization_code_verifier", "verifier",
  "usercode", "user_code",
  "secret", "apikey", "api_key", "cookie", "set-cookie",
];

const MASCARA = "[REDACTED]";
const PROFUNDIDADE_MAX = 6;

function chaveEhSensivel(chave) {
  const k = String(chave).toLowerCase().replace(/[-_\s]/g, "");
  return CHAVES_PROIBIDAS.some((p) => k.includes(p.replace(/[-_\s]/g, "")));
}

// Padrões que denunciam segredo mesmo solto numa string.
const PADROES_TEXTO = [
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, MASCARA],   // JWT
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${MASCARA}`],
  [/\b(access_token|refresh_token|authorizationCode|authorizationCodeVerifier)=[^&\s]+/gi, `$1=${MASCARA}`],
];

function sanitizarTexto(txt) {
  let saida = txt;
  for (const [re, sub] of PADROES_TEXTO) saida = saida.replace(re, sub);
  return saida;
}

/** Devolve uma CÓPIA segura de qualquer valor. Nunca muta a entrada. */
export function sanitizar(valor, profundidade = 0) {
  if (valor == null) return valor;
  if (profundidade > PROFUNDIDADE_MAX) return "[...]";
  if (typeof valor === "string") return sanitizarTexto(valor);
  if (typeof valor !== "object") return valor;
  if (valor instanceof Error) {
    return { nome: valor.name, mensagem: sanitizarTexto(valor.message), codigo: valor.codigo ?? null };
  }
  if (Array.isArray(valor)) return valor.map((v) => sanitizar(v, profundidade + 1));

  const saida = {};
  for (const [k, v] of Object.entries(valor)) {
    saida[k] = chaveEhSensivel(k) ? MASCARA : sanitizar(v, profundidade + 1);
  }
  return saida;
}

// Mascara identificadores para log/exibição — só início e fim.
// "550e8400-e29b-41d4-a716-446655440000" -> "550e****0000".
export function mascararId(valor) {
  const s = String(valor ?? "");
  if (!s) return null;
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

// URL sem query sensível para o log.
export function urlParaLog(url) {
  return String(url ?? "").replace(/([?&](?:clientId|access_token|refresh_token)=)[^&]+/gi, "$1[REDACTED]");
}

/** Log padronizado da integração. `dados` sempre sanitizado. */
export function ifoodLog(nivel, evento, dados = {}) {
  const linha = { escopo: "ifood", evento, ...sanitizar(dados) };
  const fn = nivel === "error" ? console.error : nivel === "warn" ? console.warn : console.log;
  fn(`[ifood] ${evento}`, JSON.stringify(linha));
}
