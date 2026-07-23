// Configuração do worker. Tudo por variável de ambiente; nada hardcoded que
// seja específico de uma loja (clientId vem do backend, a cada chamada).

export const PORTAL_URL = process.env.MB_PORTAL_URL ?? "https://portal.martinbrower.com.br/";
export const API_BASE = "/mbbr/portal-api";

// ---------------------------------------------------------------------------
// TRAVA DE ACESSO AO PORTAL REAL
// ---------------------------------------------------------------------------
// Motivo concreto: em 2026-07-22 um teste automatizado de HMAC, que no Windows
// parava por falta de Chromium, seguiu adiante dentro do container e fez uma
// tentativa de login no portal REAL com credenciais falsas. Ninguém pretendia
// isso — o script era o mesmo, só o ambiente mudou.
//
// A trava vive AQUI, no worker, e não nos scripts de teste: um script pode ser
// escrito sem cuidado, o worker não. Falhar fechado é o padrão.
//
// Para falar com o portal real é preciso dizer isso EXPLICITAMENTE:
//     MB_ALLOW_REAL_PORTAL=true
// Sem essa variável, qualquer host da Martin Brower é recusado.
export const HOSTS_PORTAL_REAL = ["martinbrower.com.br", "martinbrower.com"];

export function ehPortalReal(url = PORTAL_URL) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return HOSTS_PORTAL_REAL.some((d) => host === d || host.endsWith(`.${d}`));
}

export const portalRealAutorizado = () => process.env.MB_ALLOW_REAL_PORTAL === "true";

/**
 * Recusa apontar para o portal real sem autorização explícita.
 * @throws Error com instrução de como proceder
 */
export function validarAlvoDoPortal(url = PORTAL_URL) {
  if (!ehPortalReal(url) || portalRealAutorizado()) return;

  let host = "(url invalida)";
  try { host = new URL(url).hostname; } catch { /* mantém o rótulo */ }

  throw new Error(
    `[PORTAL REAL BLOQUEADO] MB_PORTAL_URL aponta para "${host}", que e o portal de producao `
    + "da Martin Brower, e MB_ALLOW_REAL_PORTAL nao esta definida.\n"
    + "  * Em TESTE: aponte MB_PORTAL_URL para um alvo local/inofensivo.\n"
    + "  * Em uso REAL e acompanhado: defina MB_ALLOW_REAL_PORTAL=true de forma consciente.\n"
    + "Esta trava existe para impedir tentativa de login automatizada nao intencional "
    + "num sistema de terceiro.");
}

export const config = {
  // O Cloud Run injeta PORT; 8080 é o padrão dele.
  porta: Number(process.env.PORT) || 8080,

  // Segredo do HMAC. O worker RECUSA subir sem ele — um worker sem
  // autenticação exposto seria um proxy aberto para o portal.
  segredoHmac: process.env.MB_WORKER_SECRET,

  // Teto de uma execução. Deve ser menor que o --timeout do Cloud Run, para
  // que o worker responda com erro tratado antes de o Google cortar a conexão.
  timeoutExecucaoMs: Number(process.env.MB_WORKER_TIMEOUT_MS ?? 600_000),

  // Tamanho máximo do corpo de uma requisição interna. As entradas são
  // pequenas (credenciais, código); o volume grande é a RESPOSTA do catálogo.
  limiteCorpoBytes: Number(process.env.MB_MAX_BODY_BYTES ?? 64 * 1024),

  // Teto da resposta do portal — corta payload anômalo antes de estourar a
  // memória do container.
  limiteCatalogoBytes: Number(process.env.MB_MAX_CATALOG_BYTES ?? 12 * 1024 * 1024),
};

export function validarConfig() {
  const faltando = [];
  if (!config.segredoHmac) faltando.push("MB_WORKER_SECRET");
  if (config.segredoHmac && config.segredoHmac.length < 32) {
    throw new Error("MB_WORKER_SECRET curto demais (mínimo 32 caracteres). Gere com: openssl rand -base64 48");
  }
  if (faltando.length) {
    throw new Error(`Variáveis obrigatórias ausentes: ${faltando.join(", ")}`);
  }
  // Falha na SUBIDA se o alvo for o portal real sem autorização — assim o
  // container nem chega a existir num estado capaz de tocar a produção.
  validarAlvoDoPortal();
}
