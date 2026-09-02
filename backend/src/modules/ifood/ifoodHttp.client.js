// Cliente HTTP centralizado da API do iFood (Merchant API).
//
// DESACOPLADO DO TRANSPORTE: aceita `fetchImpl` injetável (default: fetch
// global). Nos testes é um fetch falso — nenhuma chamada real ao iFood, nem
// aqui nem no CI.
//
// RESPONSABILIDADES (e SÓ estas — nada de regra de negócio):
//   * base URL + montagem de URL;
//   * headers (Accept, Authorization Bearer, Content-Type form-urlencoded);
//   * timeout por chamada (AbortController) + encadeia cancelamento externo;
//   * classificação de status HTTP -> erro de domínio (ifood.errors.js);
//   * retry SELETIVO: só 5xx / rede / 429 (respeitando Retry-After, com teto);
//   * corte de resposta anômala + parse de JSON tolerante a erro;
//   * sanitização: nunca loga corpo, header, token, clientSecret ou query
//     sensível — só URL sanitizada, rótulo, status e duração.
//
// Segredos (clientId/clientSecret/tokens) são passados pelos SERVICES; este
// módulo os coloca no lugar certo da requisição e nunca os registra.

import { ifoodBaseUrl, IFOOD_HTTP } from "./ifood.constants.js";
import { ifoodErro, IFOOD_ERROS, erroPorStatusHttp, ehTransitorio } from "./ifood.errors.js";
import { ifoodLog, urlParaLog } from "./ifood.logsafe.js";

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry-After em segundos ou data HTTP -> ms, com teto. */
function retryAfterMs(header) {
  if (!header) return null;
  const seg = Number(header);
  if (Number.isFinite(seg)) return Math.min(seg * 1000, IFOOD_HTTP.maxRetryAfterMs);
  const data = Date.parse(header);
  if (Number.isFinite(data)) return Math.min(Math.max(data - Date.now(), 0), IFOOD_HTTP.maxRetryAfterMs);
  return null;
}

async function lerCorpo(resp) {
  const bruto = await resp.text();
  if (bruto.length > IFOOD_HTTP.maxRespostaBytes) {
    throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { motivo: "resposta acima do limite" } });
  }
  if (!bruto) return {};
  try { return JSON.parse(bruto); }
  catch { throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { motivo: "JSON inválido" } }); }
}

/**
 * Uma requisição com timeout, classificação de erro e retry seletivo.
 * @param {object} params
 * @param {string} params.metodo 'GET' | 'POST'
 * @param {string} params.caminho começa com '/'
 * @param {Record<string,string>} [params.headers]
 * @param {string} [params.corpo] já serializado (form-urlencoded)
 * @param {string} [params.rotulo] identificador para o log
 * @param {'oauth'|'merchant'} [params.contexto] afina a tradução de 400
 * @param {AbortSignal} [params.sinal] cancelamento externo
 * @param {typeof fetch} [params.fetchImpl]
 */
async function requisitar({ metodo, caminho, headers = {}, corpo, rotulo, contexto, sinal, fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") throw ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL, { detalhes: { motivo: "fetch indisponível" } });

  const url = `${ifoodBaseUrl()}${caminho}`;
  let ultimoErro;

  for (let tentativa = 1; tentativa <= IFOOD_HTTP.maxTentativas; tentativa += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IFOOD_HTTP.timeoutMs);
    const aoCancelar = () => ctrl.abort();
    sinal?.addEventListener("abort", aoCancelar, { once: true });

    const t0 = Date.now();
    try {
      const resp = await doFetch(url, {
        method: metodo,
        headers: { Accept: "application/json", ...headers },
        body: corpo,
        signal: ctrl.signal,
      });
      const duracaoMs = Date.now() - t0;

      if (!resp.ok) {
        ifoodLog("warn", "api.resposta", { rotulo, url: urlParaLog(url), status: resp.status, duracaoMs, tentativa });

        if (!ehTransitorio(resp.status)) throw erroPorStatusHttp(resp.status, { contexto });

        ultimoErro = erroPorStatusHttp(resp.status, { contexto });
        if (tentativa < IFOOD_HTTP.maxTentativas) {
          const espera = (resp.status === 429 && retryAfterMs(resp.headers?.get?.("retry-after")))
            || IFOOD_HTTP.backoffBaseMs * 2 ** (tentativa - 1);
          await dormir(espera);
          continue;
        }
        throw ultimoErro;
      }

      const ct = String(resp.headers?.get?.("content-type") ?? "").toLowerCase();
      if (ct && !ct.includes("application/json")) {
        ifoodLog("warn", "api.content_type_inesperado", { rotulo, contentType: ct, duracaoMs });
        throw ifoodErro(IFOOD_ERROS.IFOOD_RESPOSTA_INVALIDA, { detalhes: { motivo: "content-type não-JSON" } });
      }

      const json = await lerCorpo(resp);
      ifoodLog("info", "api.ok", { rotulo, url: urlParaLog(url), status: resp.status, duracaoMs, tentativa });
      return json;
    } catch (e) {
      clearTimeout(timer);
      sinal?.removeEventListener("abort", aoCancelar);

      if (e?.codigo) throw e;                         // erro de domínio: sobe direto
      if (sinal?.aborted) throw ifoodErro(IFOOD_ERROS.IFOOD_CANCELADO);
      if (e?.name === "AbortError") {
        ultimoErro = ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL, { detalhes: { motivo: "timeout" } });
      } else {
        ultimoErro = ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL, { detalhes: { motivo: "falha de rede" } });
      }
      ifoodLog("warn", "api.falha", { rotulo, tentativa, erro: e?.message });
      if (tentativa < IFOOD_HTTP.maxTentativas) { await dormir(IFOOD_HTTP.backoffBaseMs * 2 ** (tentativa - 1)); continue; }
      throw ultimoErro;
    } finally {
      clearTimeout(timer);
      sinal?.removeEventListener("abort", aoCancelar);
    }
  }

  throw ultimoErro ?? ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL);
}

/**
 * POST application/x-www-form-urlencoded. Usado no fluxo OAuth (userCode e
 * troca/renovação de token). `campos` é um objeto plano string->string; o
 * clientSecret pode estar aqui e NUNCA é logado.
 * @param {string} caminho
 * @param {Record<string, string|number>} campos
 * @param {{rotulo?: string, contexto?: string, sinal?: AbortSignal, fetchImpl?: typeof fetch}} [opts]
 */
export async function postForm(caminho, campos, opts = {}) {
  const corpo = new URLSearchParams(
    Object.entries(campos).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
  ).toString();
  return requisitar({
    metodo: "POST", caminho, corpo,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    contexto: "oauth",
    ...opts,
  });
}

/**
 * GET autenticado por Bearer. Usado na Merchant API (blocos D/E) — leitura.
 * @param {string} caminho
 * @param {{accessToken: string, rotulo?: string, sinal?: AbortSignal, fetchImpl?: typeof fetch}} opts
 */
export async function getJson(caminho, { accessToken, rotulo, sinal, fetchImpl } = {}) {
  if (!accessToken) throw ifoodErro(IFOOD_ERROS.IFOOD_TOKEN_EXPIRADO);
  return requisitar({
    metodo: "GET", caminho,
    headers: { Authorization: `Bearer ${accessToken}` },
    contexto: "merchant",
    rotulo, sinal, fetchImpl,
  });
}
