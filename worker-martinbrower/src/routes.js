// Rotas internas do worker. Servidor-servidor apenas — nunca chamadas pelo
// navegador. Todas exigem HMAC, exceto /health (o probe do Cloud Run não
// assina).
//
// O QUE NUNCA SAI DAQUI: senha, código 2FA, JWT do portal, cookies, headers de
// autenticação, HTML da página e mensagem interna do Playwright. A projeção
// `paraBackend()` e o tratador de erro garantem isso por construção.

import { Router } from "express";
import * as sessions from "./sessions.js";
import { abrirNavegador } from "./browser.js";
import { fazerLogin, enviarCodigo2fa } from "./portal.login.js";
import { buscarPedidoAtual, buscarCatalogo } from "./portal.api.js";
import { erro, CODIGOS, WorkerError } from "./errors.js";
import { log, memoriaMb, cronometro } from "./logsafe.js";

export const rotas = Router();

// Identidade do chamador, presente em toda requisição. Sem ela a sessão não é
// localizável — é o que impede uma organização de tocar a sessão de outra.
function tenantDoCorpo(req) {
  const { organizationId, unidadeId, userId } = req.corpoJson ?? {};
  if (!organizationId || !unidadeId || !userId) {
    throw erro(CODIGOS.SESSAO_PERDIDA, "organizationId/unidadeId/userId ausentes");
  }
  return { organizationId, unidadeId, userId };
}

// Envolve o handler: converte qualquer exceção no contrato de erros, e mantém
// o detalhe técnico apenas no log.
const handler = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    const we = e instanceof WorkerError ? e : erro(CODIGOS.INDISPONIVEL, e?.message);
    log(we.status >= 500 ? "error" : "warn", "rota.erro", {
      // `codigoErro` e não `codigo`: a chave `codigo` é a do 2FA e fica
      // mascarada no log, corretamente.
      rota: req.path, codigoErro: we.codigo,
      // detalheInterno pode citar seletor/estado da página: fica SÓ no log.
      detalhe: we.detalheInterno ?? null,
    });
    // Ao backend vai apenas o código — nunca o detalhe.
    res.status(we.status).json({ error: we.codigo });
  }
};

// --- POST /sessions — inicia sessão e faz login ---------------------------
rotas.post("/sessions", handler(async (req, res) => {
  const { organizationId, unidadeId, userId } = tenantDoCorpo(req);
  const { clientId, usuario, senha } = req.corpoJson ?? {};

  if (!clientId) throw erro(CODIGOS.SESSAO_PERDIDA, "clientId ausente");
  if (!usuario || !senha) throw erro(CODIGOS.AUTH_FAILED, "credenciais ausentes");

  const sessao = sessions.criarSessao({
    organizationId, unidadeId, userId, clientId,
    credenciais: { usuario, senha },
  });

  try {
    await abrirNavegador(sessao);
    sessions.registrarTentativaLogin(sessao);
    const { precisa2fa } = await fazerLogin(sessao);
    res.status(201).json({ ...sessions.paraBackend(sessao), precisa2fa });
  } catch (e) {
    // Falhou no login: o browser não pode ficar de pé consumindo 500 MB.
    await sessions.encerrar(sessao.remoteSessionId, sessions.STATUS.ERRO);
    throw e;
  }
}));

// --- POST /sessions/:id/code — entrega o código 2FA -----------------------
rotas.post("/sessions/:id/code", handler(async (req, res) => {
  const tenant = tenantDoCorpo(req);
  const { codigo } = req.corpoJson ?? {};
  if (!/^[A-Za-z0-9]{4,12}$/.test(String(codigo ?? ""))) {
    throw erro(CODIGOS.DOIS_FA_INVALIDO, "codigo fora do formato");
  }

  const sessao = sessions.obterSessao(req.params.id, tenant);
  if (sessao.status !== sessions.STATUS.AGUARDANDO_CODIGO) {
    throw erro(CODIGOS.DOIS_FA_INVALIDO, `sessao em status ${sessao.status}, nao aguardando codigo`);
  }

  sessions.informarCodigo2fa(sessao, String(codigo));
  await enviarCodigo2fa(sessao);
  res.json(sessions.paraBackend(sessao));
}));

// --- POST /sessions/:id/collect — descobre o pedido e coleta o catálogo ---
rotas.post("/sessions/:id/collect", handler(async (req, res) => {
  const tenant = tenantDoCorpo(req);
  const sessao = sessions.obterSessao(req.params.id, tenant);

  if (sessao.status !== sessions.STATUS.AUTENTICADO) {
    throw erro(CODIGOS.SESSAO_EXPIRADA, `coleta pedida com sessao em ${sessao.status}`);
  }

  const t = cronometro("coleta.concluida", { remoteSessionId: sessao.remoteSessionId });
  sessions.atualizar(sessao, { status: sessions.STATUS.COLETANDO, etapa: "Buscando próximo pedido" });

  // orderId SEMPRE do findProxPedidoV2 — jamais do corpo da requisição.
  const pedido = await buscarPedidoAtual(sessao.page, sessao.clientId);
  sessions.atualizar(sessao, { etapa: "Carregando catálogo" });
  const catalogo = await buscarCatalogo(sessao.page, sessao.clientId, pedido.data.orderId);

  sessions.atualizar(sessao, { status: sessions.STATUS.CONCLUIDA, etapa: "Coleta concluída" });
  t.fim();

  // Payloads CRUS. Normalização, filtro, upsert e histórico são do backend.
  res.json({ ...sessions.paraBackend(sessao), pedido, catalogo });
}));

// --- GET /sessions/:id/status ---------------------------------------------
// GET não tem corpo assinável com tenant, então o backend manda por query.
rotas.get("/sessions/:id/status", handler(async (req, res) => {
  const { organizationId, unidadeId, userId } = req.query;
  if (!organizationId || !unidadeId || !userId) {
    throw erro(CODIGOS.SESSAO_PERDIDA, "tenant ausente na query");
  }
  const sessao = sessions.obterSessao(req.params.id, { organizationId, unidadeId, userId });
  res.json(sessions.paraBackend(sessao));
}));

// --- DELETE /sessions/:id — cancelamento, IDEMPOTENTE ---------------------
rotas.delete("/sessions/:id", handler(async (req, res) => {
  const { organizationId, unidadeId, userId } = req.query;
  // Cancelar é sempre seguro: se a sessão não existe, o resultado desejado
  // (ela não estar rodando) já vale. Nunca devolve erro.
  try {
    const sessao = sessions.obterSessao(req.params.id, { organizationId, unidadeId, userId });
    await sessions.encerrar(sessao.remoteSessionId, sessions.STATUS.CANCELADA);
  } catch {
    log("info", "sessao.cancelar_inexistente", { remoteSessionId: req.params.id });
  }
  res.json({ encerrada: true });
}));

// --- GET /health — SEM HMAC (o probe do Cloud Run não assina) --------------
export const health = (_req, res) => {
  res.json({
    ok: true,
    servico: "mb-worker",
    sessoesAtivas: sessions.sessoesAtivas(),
    memoria: memoriaMb(),
    uptimeSegundos: Math.round(process.uptime()),
  });
};
