// Adapter HTTP para o worker Playwright remoto (Cloud Run).
//
// Implementa a interface de martinbrower.worker.contract.js — `iniciar`,
// `informarCodigo`, `coletar`, `encerrar`. O controller, o normalizador, os
// filtros, o sync e o repositório NÃO sabem que existe um worker remoto: para
// eles, isto é apenas "o worker".
//
// DUAS CAMADAS DE AUTENTICAÇÃO
//   1. IAM do Cloud Run — o serviço sobe com --no-allow-unauthenticated. Como
//      o Render não roda no GCP, usamos uma service account e um ID token OIDC
//      obtido do metadata server (ou de GOOGLE_APPLICATION_CREDENTIALS).
//   2. HMAC — assinatura própria de cada requisição, independente da primeira.
//
// O QUE ATRAVESSA A FRONTEIRA
//   ida:   organizationId, unidadeId, userId, clientId, credenciais, código 2FA
//   volta: status da sessão e os payloads CRUS do portal
// Token e cookie do portal NUNCA voltam — o worker não os expõe.
//
// Este arquivo NÃO importa playwright. O backend continua sem Chromium.

import { createHmac, createHash, randomBytes } from "node:crypto";
import { mbErro, MB_ERROS } from "./martinbrower.errors.js";
import { MB_WORKER } from "./martinbrower.constants.js";
import { mbLog, mascararClientId } from "./martinbrower.logsafe.js";

const config = () => ({
  url: (process.env.MB_WORKER_URL ?? "").replace(/\/+$/, ""),
  segredo: process.env.MB_WORKER_SECRET,
  timeoutMs: Number(process.env.MB_WORKER_TIMEOUT_MS ?? MB_WORKER.timeoutPadraoMs),
});

// --- camada 1: identidade do Cloud Run ------------------------------------

let tokenCache = { valor: null, expiraEm: 0 };

/**
 * ID token OIDC com `audience` = URL do worker. Vem do metadata server do GCP
 * quando disponível. Fora do GCP (dev local), devolve null e seguimos só com
 * HMAC — o worker local sobe sem exigir IAM.
 */
async function obterTokenIdentidade(audience) {
  if (process.env.MB_WORKER_SKIP_OIDC === "true") return null;
  if (tokenCache.valor && tokenCache.expiraEm > Date.now()) return tokenCache.valor;

  try {
    const url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
      + `?audience=${encodeURIComponent(audience)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(url, { headers: { "Metadata-Flavor": "Google" }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;

    const token = (await r.text()).trim();
    // Renova com folga: o token vale ~1h.
    tokenCache = { valor: token, expiraEm: Date.now() + 45 * 60_000 };
    return token;
  } catch {
    // Sem metadata server (ex.: rodando fora do GCP). O HMAC segue valendo.
    return null;
  }
}

// --- camada 2: HMAC -------------------------------------------------------

// Mensagem canônica — precisa ser IDÊNTICA à do worker
// (worker-martinbrower/src/auth.middleware.js). Alterar uma exige alterar a
// outra; os testes dos dois lados cobrem o formato.
function assinar({ segredo, timestamp, nonce, metodo, caminho, corpo }) {
  const hashCorpo = createHash("sha256").update(corpo ?? "").digest("hex");
  const mensagem = [timestamp, nonce, String(metodo).toUpperCase(), caminho, hashCorpo].join("\n");
  return createHmac("sha256", segredo).update(mensagem).digest("hex");
}

/** Requisição assinada ao worker. `caminho` inclui a query string. */
async function chamar(metodo, caminho, corpoObj, { sinal } = {}) {
  const { url, segredo, timeoutMs } = config();
  if (!url || !segredo) throw mbErro(MB_ERROS.MARTIN_BROWER_WORKER_DISABLED);

  // Cancelamento que chegou ANTES da chamada: `addEventListener('abort')` não
  // dispara em sinal já abortado, então sem esta checagem a requisição sairia
  // mesmo depois de o usuário ter cancelado.
  if (sinal?.aborted) throw mbErro(MB_ERROS.MARTIN_BROWER_SYNC_CANCELLED);

  // O corpo é serializado UMA vez: é exatamente esta string que é assinada e
  // enviada. Reserializar mudaria os bytes e quebraria a assinatura.
  const corpo = corpoObj === undefined ? "" : JSON.stringify(corpoObj);
  const timestamp = String(Date.now());
  const nonce = randomBytes(18).toString("base64url");   // 24 chars, dentro do formato aceito
  const assinatura = assinar({ segredo, timestamp, nonce, metodo, caminho, corpo });

  const headers = {
    "X-MB-Timestamp": timestamp,
    "X-MB-Nonce": nonce,
    "X-MB-Signature": assinatura,
  };
  if (corpo) headers["Content-Type"] = "application/json";

  const tokenId = await obterTokenIdentidade(url);
  if (tokenId) headers.Authorization = `Bearer ${tokenId}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const aoCancelar = () => ctrl.abort();
  sinal?.addEventListener("abort", aoCancelar, { once: true });

  const t0 = Date.now();
  try {
    const resp = await fetch(`${url}${caminho}`, {
      method: metodo, headers, body: corpo || undefined, signal: ctrl.signal,
    });
    const duracaoMs = Date.now() - t0;

    const texto = await resp.text();
    let json;
    try { json = texto ? JSON.parse(texto) : {}; } catch { json = {}; }

    // O log registra a rota e a duração — nunca headers (que trazem a
    // assinatura) nem o corpo (que traz a senha).
    mbLog(resp.ok ? "info" : "warn", "worker.chamada", {
      metodo, caminho: caminho.split("?")[0], status: resp.status, duracaoMs,
    });

    if (!resp.ok) throw traduzirErro(resp.status, json);
    return json;
  } catch (e) {
    if (e?.codigo) throw e;
    if (sinal?.aborted) throw mbErro(MB_ERROS.MARTIN_BROWER_SYNC_CANCELLED);
    if (e?.name === "AbortError") {
      mbLog("error", "worker.timeout", { caminho: caminho.split("?")[0], timeoutMs });
      throw mbErro(MB_ERROS.MARTIN_BROWER_UNAVAILABLE, { detalhes: { motivo: "timeout do worker" } });
    }
    mbLog("error", "worker.inalcancavel", { caminho: caminho.split("?")[0], erro: e?.message });
    throw mbErro(MB_ERROS.MARTIN_BROWER_WORKER_UNREACHABLE);
  } finally {
    clearTimeout(timer);
    sinal?.removeEventListener("abort", aoCancelar);
  }
}

// O worker devolve o código do contrato; repassamos sem traduzir, para que o
// usuário veja a mensagem que o backend já sabe produzir.
function traduzirErro(status, json) {
  const codigo = json?.error;
  if (codigo && MB_ERROS[codigo]) return mbErro(codigo);

  // 401/403 aqui NÃO são do portal — são do worker recusando a NOSSA
  // assinatura ou o IAM. Não é problema do usuário; é configuração.
  if (status === 401 || status === 403) {
    mbLog("error", "worker.autenticacao_recusada", { status });
    return mbErro(MB_ERROS.MARTIN_BROWER_WORKER_UNREACHABLE);
  }
  if (status === 410) return mbErro(MB_ERROS.MARTIN_BROWER_REMOTE_SESSION_LOST);
  if (status === 503) return mbErro(MB_ERROS.MARTIN_BROWER_UNAVAILABLE);
  return mbErro(MB_ERROS.MARTIN_BROWER_UNAVAILABLE);
}

// --- a interface que o contrato exige -------------------------------------

const R = "/internal/martin-brower";

export const remoteWorker = {
  /**
   * Abre a sessão remota e faz o login. Devolve `precisa2fa` para o serviço
   * decidir se aguarda o código.
   */
  async iniciar({ clientId, credenciais, sinal, tenant, aoProgredir }) {
    aoProgredir?.("Iniciando navegador seguro");
    const r = await chamar("POST", `${R}/sessions`, {
      organizationId: tenant.organizacaoId,
      unidadeId: tenant.unidadeId,
      userId: tenant.usuarioId,
      clientId,
      usuario: credenciais.usuario,
      senha: credenciais.senha,
    }, { sinal });

    mbLog("info", "worker.sessao_aberta", {
      clientId: mascararClientId(clientId), precisa2fa: !!r.precisa2fa,
    });
    // Guardamos o id da sessão REMOTA para as chamadas seguintes.
    return { precisa2fa: !!r.precisa2fa, remoteSessionId: r.remoteSessionId };
  },

  async informarCodigo({ remoteSessionId, codigo, tenant, sinal }) {
    return chamar("POST", `${R}/sessions/${encodeURIComponent(remoteSessionId)}/code`, {
      organizationId: tenant.organizacaoId,
      unidadeId: tenant.unidadeId,
      userId: tenant.usuarioId,
      codigo,
    }, { sinal });
  },

  /**
   * Dispara a coleta. O orderId é descoberto DENTRO do worker, pelo
   * findProxPedidoV2 — nunca enviado daqui.
   * @returns {{pedido: object, catalogo: object}} payloads CRUS
   */
  async coletar({ remoteSessionId, tenant, sinal }) {
    const r = await chamar("POST", `${R}/sessions/${encodeURIComponent(remoteSessionId)}/collect`, {
      organizationId: tenant.organizacaoId,
      unidadeId: tenant.unidadeId,
      userId: tenant.usuarioId,
    }, { sinal });

    if (!r?.catalogo?.data?.groups) throw mbErro(MB_ERROS.MARTIN_BROWER_CATALOG_INVALID);
    return { pedido: r.pedido, catalogo: r.catalogo };
  },

  async status({ remoteSessionId, tenant }) {
    const q = new URLSearchParams({
      organizationId: tenant.organizacaoId,
      unidadeId: tenant.unidadeId,
      userId: tenant.usuarioId,
    });
    return chamar("GET", `${R}/sessions/${encodeURIComponent(remoteSessionId)}/status?${q}`);
  },

  /**
   * Encerra a sessão remota. IDEMPOTENTE e nunca lança: é chamado em bloco
   * `finally`, e uma falha aqui não pode mascarar o erro original.
   */
  async encerrar({ remoteSessionId, tenant }) {
    if (!remoteSessionId) return;
    try {
      const q = new URLSearchParams({
        organizationId: tenant?.organizacaoId ?? "",
        unidadeId: tenant?.unidadeId ?? "",
        userId: tenant?.usuarioId ?? "",
      });
      await chamar("DELETE", `${R}/sessions/${encodeURIComponent(remoteSessionId)}?${q}`);
    } catch (e) {
      mbLog("warn", "worker.falha_ao_encerrar", { erro: e?.message });
    }
  },

  /** Healthcheck — usado pela tela de configuração para mostrar o estado. */
  async saude() {
    const { url } = config();
    if (!url) return { ok: false, motivo: "MB_WORKER_URL nao configurada" };
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      return r.ok ? { ok: true, ...(await r.json()) } : { ok: false, status: r.status };
    } catch (e) {
      return { ok: false, motivo: e.message };
    }
  },
};

// Exportado para teste do formato canônico da assinatura.
export const _assinar = assinar;
