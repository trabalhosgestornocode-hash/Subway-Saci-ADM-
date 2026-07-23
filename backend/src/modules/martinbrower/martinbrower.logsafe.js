// Sanitização de logs da integração Martin Brower.
//
// REGRA ABSOLUTA: nada que passe por aqui pode conter senha, código 2FA, JWT,
// cookie ou header Authorization. Todo log da integração passa por
// mbLog()/sanitizar() — nunca use console.* direto no módulo.

const CHAVES_PROIBIDAS = [
  "password", "senha", "pass", "pwd",
  "authorization", "auth", "token", "accesstoken", "access_token",
  "refreshtoken", "refresh_token", "jwt", "bearer",
  "cookie", "cookies", "set-cookie", "setcookie", "session", "sessionid",
  "codigo2fa", "code2fa", "otp", "mfa", "twofactor", "codigoseguranca",
  "credentials", "credenciais", "usuario_senha", "secret", "apikey", "api_key",
];

const MASCARA = "[REDACTED]";
const PROFUNDIDADE_MAX = 6;

function chaveEhSensivel(chave) {
  const k = String(chave).toLowerCase().replace(/[-_\s]/g, "");
  return CHAVES_PROIBIDAS.some((p) => k.includes(p.replace(/[-_\s]/g, "")));
}

// Padrões que denunciam segredo mesmo quando o valor chega solto numa string:
// JWT (3 blocos base64url), header Bearer, Set-Cookie inteiro.
const PADROES_TEXTO = [
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, MASCARA],
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${MASCARA}`],
  [/\b(JSESSIONID|SESSION|PHPSESSID|access_token|refresh_token)=[^;\s]+/gi, `$1=${MASCARA}`],
];

function sanitizarTexto(txt) {
  let saida = txt;
  for (const [re, sub] of PADROES_TEXTO) saida = saida.replace(re, sub);
  return saida;
}

// Devolve uma CÓPIA segura de qualquer valor. Nunca muta a entrada.
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

// Mascara o clientId no que é exibido/logado: 4532 -> "••32".
export function mascararClientId(clientId) {
  const s = String(clientId ?? "");
  if (!s) return null;
  return s.length <= 2 ? "••" : `••${s.slice(-2)}`;
}

// Log padronizado da integração. `dados` sempre sanitizado.
export function mbLog(nivel, evento, dados = {}) {
  const linha = { escopo: "martin-brower", evento, ...sanitizar(dados) };
  const fn = nivel === "error" ? console.error : nivel === "warn" ? console.warn : console.log;
  fn(`[mb] ${evento}`, JSON.stringify(linha));
}

// Registro de auditoria de uma sincronização (seção 19 da spec).
// Note o que NÃO está aqui: nenhuma credencial, nenhum token, nenhum cookie.
export function auditarSincronizacao({
  organizacaoId, unidadeId, clientId, orderId, usuarioId,
  iniciadoEm, finalizadoEm, produtos, erros, status, erroCodigo,
}) {
  mbLog(status === "erro" ? "error" : "info", "sincronizacao", {
    organizacaoId, unidadeId,
    clientId: mascararClientId(clientId),
    orderId, usuarioId,
    iniciadoEm, finalizadoEm,
    duracaoMs: iniciadoEm && finalizadoEm ? new Date(finalizadoEm) - new Date(iniciadoEm) : null,
    produtos, erros, status, erroCodigo: erroCodigo ?? null,
  });
}
