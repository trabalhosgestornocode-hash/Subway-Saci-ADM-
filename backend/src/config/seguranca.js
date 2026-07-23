// Política de segurança HTTP do backend.
//
// Separada do app.js porque cada regra aqui depende de um detalhe concreto do
// frontend (de onde vêm fontes, scripts e o iframe da Martin Brower). Deixar
// isso documentado em um lugar só evita que um "helmet padrão" quebre o portal.

import { config } from "./env.js";

const producao = process.env.NODE_ENV === "production";

// --- CORS -----------------------------------------------------------------
// O frontend é servido pelo PRÓPRIO backend (mesma origem), então em condições
// normais nenhuma requisição do app dispara CORS. A allowlist existe para
// ambientes onde o front roda em outro host (preview, app futuro).
// Vazia = só mesma origem, que é o mais restritivo e o padrão desejado.
const origensPermitidas = (process.env.CORS_ORIGINS ?? "")
  .split(",").map((o) => o.trim()).filter(Boolean);

export const corsOptions = {
  origin(origin, cb) {
    // Sem header Origin = mesma origem, curl, health check do Render. Libera.
    if (!origin) return cb(null, true);
    if (origensPermitidas.includes(origin)) return cb(null, true);
    // Não lança erro: responde sem os headers de CORS, e o navegador bloqueia.
    // Lançar aqui viraria 500 e poluiria o log com tentativa de terceiro.
    return cb(null, false);
  },
  credentials: false,   // a API é Bearer puro — não há cookie a compartilhar
  maxAge: 86400,
};

// --- CSP ------------------------------------------------------------------
// Montada a partir do que o frontend REALMENTE usa hoje:
//   * Chart.js e supabase-js vêm de cdn.jsdelivr.net (index.html);
//   * fontes do Google (googleapis + gstatic);
//   * Supabase Auth/REST/Realtime no domínio do projeto (https + wss);
//   * o portal da Martin Brower é embutido em iframe na aba dedicada.
//
// A diretiva frame-src é a crítica: sem ela a aba Martin Brower para de
// funcionar. Por isso o portal é listado explicitamente.
const supabaseOrigem = (() => {
  try { return new URL(config.supabaseUrl).origin; } catch { return ""; }
})();
const supabaseWs = supabaseOrigem.replace(/^https:/, "wss:");

export const PORTAL_MARTIN_BROWER = "https://portal.martinbrower.com.br";

export const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
  // 'unsafe-inline' em estilo é aceito: o app usa style="" em elementos
  // gerados (gráficos, barras de progresso). O risco de CSS inline é baixo
  // e a alternativa exigiria reescrever a renderização inteira.
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
  imgSrc: ["'self'", "data:", "blob:", "https:"],
  connectSrc: ["'self'", supabaseOrigem, supabaseWs].filter(Boolean),
  // A aba Martin Brower embute o portal oficial da distribuidora.
  frameSrc: [PORTAL_MARTIN_BROWER],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],   // ninguém embute o NOSSO app
  upgradeInsecureRequests: producao ? [] : null,
};

// Report-Only por padrão: a CSP é publicada e VIOLAÇÕES SÃO REGISTRADAS no
// console do navegador, mas nada é bloqueado. Depois de confirmar que o portal
// da Martin Brower e o app carregam limpos, ligue CSP_ENFORCE=true.
export const cspEmModoBloqueio = process.env.CSP_ENFORCE === "true";

export const helmetOptions = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: Object.fromEntries(
      Object.entries(cspDirectives).filter(([, v]) => v !== null)
    ),
    reportOnly: !cspEmModoBloqueio,
  },
  // COEP quebra iframe de terceiro (o portal não manda CORP) — precisa ficar
  // desligado, senão a aba Martin Brower volta a exibir a tela de bloqueio.
  crossOriginEmbedderPolicy: false,
  // Idem: 'same-origin' impediria o navegador de carregar o portal embutido.
  crossOriginResourcePolicy: { policy: "cross-origin" },
  // O portal abre em nova guia via window.open — 'same-origin' o isolaria.
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
};

// --- limites de corpo -----------------------------------------------------
// 30 MB era o limite GLOBAL por causa dos relatórios do SW em base64. Agora
// esse teto vale só na rota que precisa dele; o resto da API fica em 1 MB.
export const LIMITES_CORPO = {
  padrao: "1mb",
  vendasImportacao: "30mb",   // relatórios CSV/Excel/PDF em base64
  martinBrowerImportacao: "8mb", // JSON do loadItens colado pelo admin
};

// --- timeouts do servidor -------------------------------------------------
export const TIMEOUTS = {
  // Teto por requisição. Generoso por causa da importação de vendas, que
  // interpreta PDF grande de forma síncrona.
  requestTimeoutMs: 120_000,
  headersTimeoutMs: 65_000,
  keepAliveTimeoutMs: 61_000,  // > que o do proxy do Render, evita 502 espúrio
};

export const emProducao = producao;
