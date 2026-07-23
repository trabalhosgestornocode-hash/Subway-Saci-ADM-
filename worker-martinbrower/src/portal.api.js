// Chamadas às rotas internas do portal, DENTRO da sessão autenticada.
//
// Usamos o APIRequestContext do próprio browser context (`page.request`): ele
// carrega automaticamente os cookies da sessão, e o JWT nunca precisa ser
// extraído, copiado ou manipulado por nós. É o que torna possível cumprir a
// regra "o token nunca sai do browser context".
//
// O orderId SEMPRE vem do findProxPedidoV2. Não existe caminho neste arquivo
// que aceite um orderId de fora.

import { API_BASE, PORTAL_URL, config } from "./config.js";
import { erro, CODIGOS } from "./errors.js";
import { log, cronometro, mascararClientId } from "./logsafe.js";

const urlAbsoluta = (caminho) => new URL(caminho, PORTAL_URL).toString();

/** GET autenticado com validação de content-type, tamanho e JSON. */
async function getJson(page, caminho, rotulo) {
  const t = cronometro("portal.chamada", { rotulo });

  const resp = await page.request.get(urlAbsoluta(caminho), {
    headers: { Accept: "application/json" },
    timeout: 30_000,
  });

  const status = resp.status();
  if (!resp.ok()) {
    t.fim({ status });
    // Traduz para o contrato de erros. 401/403 aqui significam que a sessão
    // do portal caiu no meio da coleta.
    if (status === 401) throw erro(CODIGOS.SESSAO_EXPIRADA, `${rotulo} devolveu 401`);
    if (status === 403) throw erro(CODIGOS.ACESSO_NEGADO, `${rotulo} devolveu 403`);
    if (status === 404) throw erro(CODIGOS.PEDIDO_NAO_ENCONTRADO, `${rotulo} devolveu 404`);
    if (status >= 500) throw erro(CODIGOS.INDISPONIVEL, `${rotulo} devolveu ${status}`);
    throw erro(CODIGOS.CATALOGO_INVALIDO, `${rotulo} devolveu ${status}`);
  }

  const contentType = String(resp.headers()["content-type"] ?? "");
  if (!contentType.toLowerCase().includes("application/json")) {
    // HTML aqui quase sempre é o portal nos devolvendo a tela de login.
    t.fim({ contentType });
    throw erro(CODIGOS.SESSAO_EXPIRADA, `${rotulo} respondeu ${contentType}, nao JSON`);
  }

  const bruto = await resp.text();
  if (bruto.length > config.limiteCatalogoBytes) {
    t.fim({ bytes: bruto.length });
    throw erro(CODIGOS.CATALOGO_INVALIDO, `${rotulo} acima do limite (${bruto.length} bytes)`);
  }

  let json;
  try { json = JSON.parse(bruto); }
  catch { t.fim(); throw erro(CODIGOS.CATALOGO_INVALIDO, `${rotulo} devolveu JSON invalido`); }

  t.fim({ status, bytes: bruto.length });
  return json;
}

/** Pedido corrente. É a ÚNICA origem do orderId. */
export async function buscarPedidoAtual(page, clientId) {
  const payload = await getJson(page, `${API_BASE}/order/findProxPedidoV2?clientId=${encodeURIComponent(clientId)}`, "findProxPedidoV2");

  const orderId = payload?.data?.orderId;
  if (!orderId) {
    log("warn", "portal.sem_pedido", {
      clientId: mascararClientId(clientId),
      restricao: payload?.data?.financialRestriction ?? null,
    });
    throw erro(CODIGOS.PEDIDO_NAO_ENCONTRADO, "findProxPedidoV2 sem orderId");
  }

  log("info", "portal.pedido_encontrado", { clientId: mascararClientId(clientId), orderId });
  return payload;
}

/** Catálogo do pedido descoberto acima. */
export async function buscarCatalogo(page, clientId, orderId) {
  if (!orderId) throw erro(CODIGOS.PEDIDO_NAO_ENCONTRADO, "orderId ausente");

  const payload = await getJson(
    page,
    `${API_BASE}/order/loadItens?size=1000&orderId=${encodeURIComponent(orderId)}&clientId=${encodeURIComponent(clientId)}`,
    "loadItens",
  );

  // Validação de FORMA apenas. Normalizar, filtrar e persistir é do backend —
  // o worker não conhece regra de negócio.
  if (!Array.isArray(payload?.data?.groups)) {
    throw erro(CODIGOS.CATALOGO_INVALIDO, "loadItens sem data.groups[]");
  }

  const itens = payload.data.groups.reduce((n, g) => n + (Array.isArray(g?.itens) ? g.itens.length : 0), 0);
  log("info", "portal.catalogo_coletado", { orderId, grupos: payload.data.groups.length, itens });

  return payload;
}
