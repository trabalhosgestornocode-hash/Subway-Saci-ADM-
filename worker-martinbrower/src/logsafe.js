// Sanitização de logs do worker.
//
// Este processo é o ÚNICO ponto do sistema que vê a senha do portal, o código
// 2FA, o JWT e os cookies da Martin Brower. Nenhum deles pode chegar ao log —
// e no Cloud Run o log vai para o Cloud Logging, que é persistente.
//
// Porte do backend/src/modules/martinbrower/martinbrower.logsafe.js. Mantidos
// separados de propósito: o worker não compartilha código com o backend, para
// poder ser deployado e versionado de forma independente.

// Duas listas, porque casar tudo por substring mascara demais.
//
// O caso que motivou a separação: "codigo" como substring redigia o CÓDIGO DO
// ERRO (`codigo: "MARTIN_BROWER_AUTH_FAILED"`), que é exatamente o dado de
// diagnóstico que precisamos ler no log. Palavra ambígua exige match EXATO.

// Ambíguas: só mascaram quando a chave é EXATAMENTE isto.
const CHAVES_EXATAS = [
  "codigo", "code", "senha", "pass", "pwd", "token", "auth", "secret",
];

// Inequívocas: qualquer chave que CONTENHA isto é segredo.
const CHAVES_PARCIAIS = [
  "password", "authorization", "accesstoken", "refreshtoken", "jwt", "bearer",
  "cookie", "setcookie",
  "codigo2fa", "code2fa", "codigoseguranca", "otp", "mfa", "twofactor",
  "credentials", "credenciais", "apikey", "signature",
];

const MASCARA = "[REDACTED]";
const PROFUNDIDADE_MAX = 6;

const normalizarChave = (c) => String(c).toLowerCase().replace(/[-_\s]/g, "");

function chaveEhSensivel(chave) {
  const k = normalizarChave(chave);
  if (CHAVES_EXATAS.includes(k)) return true;
  return CHAVES_PARCIAIS.some((p) => k.includes(normalizarChave(p)));
}

const PADROES_TEXTO = [
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, MASCARA],
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${MASCARA}`],
  [/\b(JSESSIONID|SESSION|PHPSESSID|access_token|refresh_token)=[^;\s]+/gi, `$1=${MASCARA}`],
];

const sanitizarTexto = (t) => PADROES_TEXTO.reduce((s, [re, sub]) => s.replace(re, sub), t);

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

// Assinatura HMAC no log: só os 8 primeiros caracteres, o suficiente para
// correlacionar duas linhas sem permitir reconstrução.
export const prefixoAssinatura = (sig) =>
  typeof sig === "string" && sig.length > 8 ? `${sig.slice(0, 8)}…` : "[curta]";

export const mascararClientId = (id) => {
  const s = String(id ?? "");
  return !s ? null : s.length <= 2 ? "••" : `••${s.slice(-2)}`;
};

// Log estruturado em JSON — o Cloud Logging indexa os campos automaticamente.
export function log(nivel, evento, dados = {}) {
  const linha = {
    severity: nivel === "error" ? "ERROR" : nivel === "warn" ? "WARNING" : "INFO",
    servico: "mb-worker",
    evento,
    ...sanitizar(dados),
  };
  const fn = nivel === "error" ? console.error : console.log;
  fn(JSON.stringify(linha));
}

// --- métricas básicas -----------------------------------------------------
// Sem biblioteca: o que interessa é memória (para dimensionar o container) e
// duração (para dimensionar o timeout). Ambas saem no log estruturado.

export function memoriaMb() {
  const m = process.memoryUsage();
  return {
    rssMb: Math.round(m.rss / 1048576),
    heapUsadoMb: Math.round(m.heapUsed / 1048576),
    externoMb: Math.round(m.external / 1048576),
  };
}

/** Cronômetro que já loga memória no fim — usado em cada etapa cara. */
export function cronometro(evento, contexto = {}) {
  const t0 = Date.now();
  return {
    fim(extra = {}) {
      const duracaoMs = Date.now() - t0;
      log("info", evento, { ...contexto, ...extra, duracaoMs, ...memoriaMb() });
      return duracaoMs;
    },
  };
}
