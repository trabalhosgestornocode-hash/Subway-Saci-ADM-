// Cliente das rotas internas da API do portal Martin Brower.
//
// DESACOPLADO DO TRANSPORTE de propósito: recebe uma `sessao` que expõe
// `fetch(url, opts)`. Hoje isso pode ser o request context autenticado do
// Playwright (rodando FORA deste processo, ver martinbrower.worker.contract.js);
// nos testes é um fetch falso. Este módulo nunca abre navegador, nunca lê
// credencial e nunca vê senha.
//
// NUNCA loga Authorization nem Cookie: as opções de requisição não são
// registradas em lugar nenhum, só a URL sanitizada e a duração.

import { MB_BASE_URL, MB_ROTAS, MB_HTTP } from "./martinbrower.constants.js";
import { mbErro, MB_ERROS, erroPorStatusHttp, ehTransitorio } from "./martinbrower.errors.js";
import { mbLog, mascararClientId } from "./martinbrower.logsafe.js";

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// URL sem query sensível para o log (clientId mascarado, resto preservado).
function urlParaLog(caminho) {
  return caminho.replace(/clientId=(\d+)/, (_, id) => `clientId=${mascararClientId(id)}`);
}

/**
 * Uma requisição GET com timeout, validação e retry apenas em erro transitório.
 * @param {{fetch: Function}} sessao transporte autenticado
 */
async function getJson(sessao, caminho, { rotulo, sinal } = {}) {
  let ultimoErro;

  for (let tentativa = 1; tentativa <= MB_HTTP.maxTentativas; tentativa += 1) {
    // AbortController próprio por tentativa; encadeia o cancelamento externo.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MB_HTTP.timeoutMs);
    const aoCancelar = () => ctrl.abort();
    sinal?.addEventListener("abort", aoCancelar, { once: true });

    const t0 = Date.now();
    try {
      const resp = await sessao.fetch(`${MB_BASE_URL}${caminho}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });
      const duracaoMs = Date.now() - t0;

      if (!resp.ok) {
        mbLog("warn", "api.resposta", { rotulo, url: urlParaLog(caminho), status: resp.status, duracaoMs, tentativa });
        // 401/403/429 NUNCA são repetidos: repetir com sessão inválida só
        // queima tentativa e pode travar a conta no portal.
        if (!ehTransitorio(resp.status)) throw erroPorStatusHttp(resp.status);
        ultimoErro = erroPorStatusHttp(resp.status);
        if (tentativa < MB_HTTP.maxTentativas) { await dormir(MB_HTTP.backoffBaseMs * tentativa); continue; }
        throw ultimoErro;
      }

      const contentType = String(resp.headers?.get?.("content-type") ?? "");
      if (!contentType.toLowerCase().includes("application/json")) {
        // HTML aqui quase sempre significa "fui redirecionado para o login".
        mbLog("warn", "api.content_type_inesperado", { rotulo, contentType, duracaoMs });
        throw mbErro(MB_ERROS.MARTIN_BROWER_SESSION_EXPIRED);
      }

      const bruto = await resp.text();
      if (bruto.length > MB_HTTP.maxRespostaBytes) {
        throw mbErro(MB_ERROS.MARTIN_BROWER_CATALOG_INVALID, { detalhes: { motivo: "resposta acima do limite" } });
      }

      let json;
      try { json = JSON.parse(bruto); }
      catch { throw mbErro(MB_ERROS.MARTIN_BROWER_CATALOG_INVALID, { detalhes: { motivo: "JSON inválido" } }); }

      mbLog("info", "api.ok", { rotulo, url: urlParaLog(caminho), duracaoMs, bytes: bruto.length, tentativa });
      return json;
    } catch (e) {
      clearTimeout(timer);
      sinal?.removeEventListener("abort", aoCancelar);

      if (e?.codigo) throw e;                       // erro de domínio: sobe direto
      if (sinal?.aborted) throw mbErro(MB_ERROS.MARTIN_BROWER_SYNC_CANCELLED);
      if (e?.name === "AbortError") {               // timeout nosso
        ultimoErro = mbErro(MB_ERROS.MARTIN_BROWER_UNAVAILABLE, { detalhes: { motivo: "timeout" } });
      } else {                                      // falha de rede
        ultimoErro = mbErro(MB_ERROS.MARTIN_BROWER_UNAVAILABLE, { detalhes: { motivo: "falha de rede" } });
      }
      mbLog("warn", "api.falha", { rotulo, tentativa, erro: e?.message });
      if (tentativa < MB_HTTP.maxTentativas) { await dormir(MB_HTTP.backoffBaseMs * tentativa); continue; }
      throw ultimoErro;
    } finally {
      clearTimeout(timer);
      sinal?.removeEventListener("abort", aoCancelar);
    }
  }

  throw ultimoErro ?? mbErro(MB_ERROS.MARTIN_BROWER_UNAVAILABLE);
}

/** Pedido corrente da unidade. O orderId SEMPRE sai daqui — nunca é fixo. */
export function getCurrentOrder(clientId, sessao, opcoes = {}) {
  return getJson(sessao, MB_ROTAS.proximoPedido(clientId), { rotulo: "findProxPedidoV2", ...opcoes });
}

/** Catálogo do pedido. */
export function loadItems(clientId, orderId, sessao, opcoes = {}) {
  return getJson(sessao, MB_ROTAS.itens(clientId, orderId, MB_HTTP.pageSize), { rotulo: "loadItens", ...opcoes });
}
