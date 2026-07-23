// Orquestração da integração Martin Brower.
//
// ESCOPO DO TENANT: todas as funções recebem { organizacaoId, unidadeId }
// vindos de req.tenant — resolvidos e VALIDADOS pelo requireAuth contra os
// vínculos do usuário (usuarios_organizacoes / usuarios_unidades). Este
// módulo nunca aceita esses ids do corpo da requisição.
//
// FASE ATUAL: o worker Playwright está atrás de MB_PLAYWRIGHT_ENABLED
// (default false). Enquanto isso, a validação ponta a ponta de normalização,
// filtro, upsert e histórico é feita pela importação manual administrativa
// — ferramenta TEMPORÁRIA de teste, não substituta da integração final.

import * as repo from "./martinbrower.repository.js";
import * as sessions from "./martinbrower.sessions.js";
import { processarCatalogo } from "./martinbrower.sync.service.js";
import { descobrirPedidoAtual } from "./martinbrower.order.service.js";
import { normalizarPedido } from "./martinbrower.normalizer.js";
import { obterWorker, exigirWorkerHabilitado, workerHabilitado } from "./martinbrower.worker.contract.js";
import { MB_STATUS, MB_ETAPAS } from "./martinbrower.constants.js";
import { mbErro, MB_ERROS } from "./martinbrower.errors.js";
import { mbLog, mascararClientId, auditarSincronizacao } from "./martinbrower.logsafe.js";
import { ApiError } from "../../shared/ApiError.js";

// --- configuração ---------------------------------------------------------

export async function obterConfiguracao({ organizacaoId, unidadeId }) {
  const integracao = await repo.obterIntegracao({ organizacaoId, unidadeId });
  const emAndamento = await repo.sincronizacaoEmAndamento({ organizacaoId, unidadeId });

  return {
    configurada: !!integracao,
    workerHabilitado: workerHabilitado(),
    // clientId exibido mascarado; o valor cru só aparece para quem edita a
    // configuração (rota de settings restrita a admin).
    clientIdMascarado: integracao ? mascararClientId(integracao.client_id) : null,
    unidadeNome: integracao?.unidade_nome ?? null,
    status: integracao?.status ?? "nao_configurado",
    ultimoOrderId: integracao?.ultimo_order_id ?? null,
    ultimaSincronizacao: integracao?.ultima_sincronizacao ?? null,
    ultimoErro: integracao?.ultimo_erro ?? null,
    sincronizacaoEmAndamento: emAndamento ?? null,
    politicaCredenciais: "Credenciais efêmeras, mantidas exclusivamente em memória e descartadas ao final de cada sincronização.",
  };
}

export async function salvarConfiguracao({ organizacaoId, unidadeId, clientId, unidadeNome, ativo }) {
  const salva = await repo.salvarIntegracao({ organizacaoId, unidadeId, clientId, unidadeNome, ativo });
  mbLog("info", "config.salva", { organizacaoId, unidadeId, clientId: mascararClientId(clientId) });
  return { id: salva.id, clientIdMascarado: mascararClientId(salva.client_id), unidadeNome: salva.unidade_nome, ativo: salva.ativo };
}

// Carrega a integração exigindo que exista — usada por tudo que sincroniza.
async function exigirIntegracao({ organizacaoId, unidadeId }) {
  const integracao = await repo.obterIntegracao({ organizacaoId, unidadeId });
  if (!integracao?.client_id) throw mbErro(MB_ERROS.MARTIN_BROWER_NOT_CONFIGURED);
  return integracao;
}

// --- consultas ------------------------------------------------------------

export const listarProdutos = (p) => repo.listarProdutos(p);
export const listarHistoricoPrecos = (p) => repo.listarHistoricoPrecos(p);
export const listarSincronizacoes = (p) => repo.listarSincronizacoes(p);
export const listarSemVinculo = (p) => repo.listarSemVinculo(p);
export const criarVinculo = (p) => repo.criarVinculo(p);
export const removerVinculo = (p) => repo.removerVinculo(p);

// --- sincronização automatizada (Fase 3, atrás da flag) -------------------

/**
 * Inicia a sincronização com o worker Playwright.
 * Enquanto MB_PLAYWRIGHT_ENABLED=false isto falha em WORKER_DISABLED ANTES
 * de tocar em qualquer credencial — a rota sequer aceita senha.
 */
export async function iniciarSincronizacao({ organizacaoId, unidadeId, usuarioId, credenciais }) {
  exigirWorkerHabilitado();
  const integracao = await exigirIntegracao({ organizacaoId, unidadeId });
  const clientId = integracao.client_id;

  // Concorrência: lock em memória (rápido) + verificação no banco (sobrevive
  // a restart). As duas barreiras porque o Render Free hiberna.
  const jaRodando = await repo.sincronizacaoEmAndamento({ organizacaoId, unidadeId });
  if (jaRodando) throw mbErro(MB_ERROS.MARTIN_BROWER_SYNC_CONFLICT);

  const sinc = await repo.criarSincronizacao({
    organizacaoId, unidadeId, clientId, criadoPor: usuarioId,
    origem: "worker", status: MB_STATUS.AUTENTICANDO,
  });

  const sessao = sessions.criarSessao({
    organizacaoId, unidadeId, clientId, usuarioId, credenciais, sincronizacaoId: sinc.id,
  });

  let chaveLock;
  try {
    chaveLock = sessions.adquirirLock({ organizacaoId, unidadeId, clientId, sessionId: sessao.sessionId });
  } catch (e) {
    sessions.finalizarSessao(sessao.sessionId, MB_STATUS.CANCELADO);
    await repo.atualizarSincronizacao({ organizacaoId, unidadeId, sincronizacaoId: sinc.id,
      campos: { status: MB_STATUS.CANCELADO, erro_codigo: e.codigo, finalizado_em: new Date().toISOString() } });
    throw e;
  }

  // Executa em segundo plano; o frontend acompanha por polling do status.
  executarFluxoWorker({ sessao, chaveLock, integracao }).catch((e) => {
    mbLog("error", "worker.falha_nao_tratada", { sessionId: sessao.sessionId, erro: e?.message });
  });

  return sessions.paraCliente(sessao);
}

// Fluxo completo do worker. TODO segredo morre no `finally`.
async function executarFluxoWorker({ sessao, chaveLock, integracao }) {
  const worker = obterWorker();
  const { organizacaoId, unidadeId, clientId, sincronizacaoId, usuarioId } = sessao;
  const iniciadoEm = new Date().toISOString();
  const progresso = (etapa, status) => {
    sessions.atualizarSessao(sessao, { etapa, status });
    repo.atualizarSincronizacao({ organizacaoId, unidadeId, sincronizacaoId,
      campos: { etapa_atual: etapa, ...(status ? { status } : {}) } }).catch(() => {});
  };

  // Identidade enviada ao worker em TODA chamada: é o que impede uma sessão
  // remota de ser tocada por outra organização, unidade ou usuário.
  const tenant = { organizacaoId, unidadeId, usuarioId };
  const sinal = sessao._controle.signal;

  try {
    progresso(MB_ETAPAS.INICIANDO_NAVEGADOR, MB_STATUS.AUTENTICANDO);
    const inicio = await worker.iniciar({
      clientId, credenciais: sessao._credenciais,
      sinal, tenant, aoProgredir: progresso,
    });
    // O worker remoto tem o PRÓPRIO id de sessão, separado do nosso sessionId
    // (que é o que o frontend enxerga). Guardamos para as chamadas seguintes.
    sessao.remoteSessionId = inicio.remoteSessionId ?? null;

    if (inicio.precisa2fa) {
      progresso(MB_ETAPAS.AGUARDANDO_CODIGO, MB_STATUS.AGUARDANDO_CODIGO);
      await aguardarCodigo2fa(sessao);
      await worker.informarCodigo({
        remoteSessionId: sessao.remoteSessionId, codigo: sessao._codigo2fa, tenant, sinal,
      });
      // O código já foi usado: some da nossa memória também.
      sessao._codigo2fa = null;
    }

    progresso(MB_ETAPAS.BUSCANDO_PEDIDO, MB_STATUS.IDENTIFICANDO_PEDIDO);
    const { pedido, catalogo } = await worker.coletar({
      remoteSessionId: sessao.remoteSessionId, tenant, sinal,
    });

    const pedidoNorm = normalizarPedido(pedido);
    if (!pedidoNorm.orderId) throw mbErro(MB_ERROS.MARTIN_BROWER_ORDER_NOT_FOUND);

    progresso(MB_ETAPAS.NORMALIZANDO, MB_STATUS.SINCRONIZANDO);
    const resumo = await processarCatalogo({
      organizacaoId, unidadeId, clientId, orderId: pedidoNorm.orderId,
      payload: catalogo, sincronizacaoId, aoProgredir: (e) => progresso(e),
    });

    await concluir({ sessao, sincronizacaoId, pedido: pedidoNorm, resumo, iniciadoEm });
  } catch (e) {
    await falhar({ sessao, sincronizacaoId, erro: e, iniciadoEm });
  } finally {
    // Ordem importa: encerra o browser ANTES de soltar o lock, para que uma
    // nova sincronização não comece com o Chromium anterior ainda vivo.
    await worker.encerrar({ remoteSessionId: sessao.remoteSessionId, tenant }).catch(() => {});
    sessions.liberarLock(chaveLock, sessao.sessionId);
    sessions.finalizarSessao(sessao.sessionId);   // apaga credenciais e código 2FA
    mbLog("info", "worker.encerrado", { sessionId: sessao.sessionId, usuarioId });
  }
}

// Espera o usuário digitar o código, respeitando cancelamento e expiração.
function aguardarCodigo2fa(sessao) {
  return new Promise((resolve, reject) => {
    const checar = setInterval(() => {
      if (sessao._codigo2fa) { clearInterval(checar); resolve(); return; }
      if (sessao._controle.signal.aborted) { clearInterval(checar); reject(mbErro(MB_ERROS.MARTIN_BROWER_SYNC_CANCELLED)); return; }
      if (sessao.expiraEm <= Date.now()) { clearInterval(checar); reject(mbErro(MB_ERROS.MARTIN_BROWER_SESSION_EXPIRED)); }
    }, 1000);
    checar.unref?.();
  });
}

async function concluir({ sessao, sincronizacaoId, pedido, resumo, iniciadoEm }) {
  const { organizacaoId, unidadeId, clientId, usuarioId } = sessao;
  const finalizadoEm = new Date().toISOString();

  await repo.atualizarSincronizacao({ organizacaoId, unidadeId, sincronizacaoId, campos: {
    status: MB_STATUS.CONCLUIDO, etapa_atual: MB_ETAPAS.FINALIZANDO, order_id: pedido.orderId,
    produtos_encontrados: resumo.produtosEncontrados, produtos_validos: resumo.produtosValidos,
    produtos_ignorados: resumo.produtosIgnorados, produtos_criados: resumo.produtosCriados,
    produtos_atualizados: resumo.produtosAtualizados, precos_alterados: resumo.precosAlterados,
    produtos_com_erro: resumo.produtosComErro, financial_restriction: pedido.financialRestriction,
    janela_inicio: pedido.janelaInicio, janela_final: pedido.janelaFinal, finalizado_em: finalizadoEm,
  } });

  await repo.atualizarStatusIntegracao({ organizacaoId, unidadeId, campos: {
    status: "concluido", ultimo_order_id: pedido.orderId,
    ultima_sincronizacao: finalizadoEm, ultimo_erro: null,
  } });

  sessions.atualizarSessao(sessao, { status: MB_STATUS.CONCLUIDO, etapa: MB_ETAPAS.FINALIZANDO, resultado: { ...resumo, orderId: pedido.orderId, finalizadoEm } });
  auditarSincronizacao({ organizacaoId, unidadeId, clientId, orderId: pedido.orderId, usuarioId,
    iniciadoEm, finalizadoEm, produtos: resumo.produtosValidos, erros: resumo.produtosComErro, status: "concluido" });
}

async function falhar({ sessao, sincronizacaoId, erro, iniciadoEm }) {
  const { organizacaoId, unidadeId, clientId, usuarioId } = sessao;
  const finalizadoEm = new Date().toISOString();
  const cancelado = erro?.codigo === MB_ERROS.MARTIN_BROWER_SYNC_CANCELLED;
  const codigo = erro?.codigo ?? "MARTIN_BROWER_UNAVAILABLE";

  await repo.atualizarSincronizacao({ organizacaoId, unidadeId, sincronizacaoId, campos: {
    status: cancelado ? MB_STATUS.CANCELADO : MB_STATUS.ERRO,
    erro_codigo: codigo,
    // Mensagem para humano — o errorHandler nunca vê credencial porque
    // nenhum erro deste módulo carrega o corpo da requisição.
    erro_mensagem: erro?.message ?? null,
    finalizado_em: finalizadoEm,
  } }).catch(() => {});

  await repo.atualizarStatusIntegracao({ organizacaoId, unidadeId,
    campos: { status: cancelado ? "cancelado" : "erro", ultimo_erro: erro?.message ?? null } }).catch(() => {});

  sessions.atualizarSessao(sessao, {
    status: cancelado ? MB_STATUS.CANCELADO : MB_STATUS.ERRO,
    erro: { codigo, mensagem: erro?.message ?? "Falha na sincronização." },
  });
  auditarSincronizacao({ organizacaoId, unidadeId, clientId, orderId: null, usuarioId,
    iniciadoEm, finalizadoEm, produtos: 0, erros: 1, status: "erro", erroCodigo: codigo });
}

// --- controle da sessão ---------------------------------------------------

export function informarCodigo({ sessionId, usuarioId, organizacaoId, unidadeId, codigo }) {
  exigirWorkerHabilitado();
  const sessao = sessions.obterSessao({ sessionId, usuarioId, organizacaoId, unidadeId });
  // 404 e não 403: não confirmamos sequer que o sessionId existe para quem
  // não é o dono.
  if (!sessao) throw ApiError.notFound("Sessão de sincronização não encontrada ou expirada.");
  if (sessao.status !== MB_STATUS.AGUARDANDO_CODIGO) throw ApiError.badRequest("Esta sincronização não está aguardando código.");
  sessions.informarCodigo2fa(sessao, codigo);
  return sessions.paraCliente(sessao);
}

export function statusSessao({ sessionId, usuarioId, organizacaoId, unidadeId }) {
  const sessao = sessions.obterSessao({ sessionId, usuarioId, organizacaoId, unidadeId });
  if (!sessao) throw ApiError.notFound("Sessão de sincronização não encontrada ou expirada.");
  return sessions.paraCliente(sessao);
}

export function cancelarSincronizacao({ sessionId, usuarioId, organizacaoId, unidadeId }) {
  const sessao = sessions.obterSessao({ sessionId, usuarioId, organizacaoId, unidadeId });
  if (!sessao) throw ApiError.notFound("Sessão de sincronização não encontrada ou expirada.");
  sessions.cancelarSessao(sessao);
  return sessions.paraCliente(sessao);
}

// --- importação manual (FERRAMENTA TEMPORÁRIA DE TESTE) -------------------

/**
 * Recebe o JSON cru do loadItens colado por um administrador e roda o MESMO
 * caminho da sincronização automática (normalizar -> filtrar -> upsert ->
 * histórico). Serve para validar a Fase 2 sem depender do Playwright.
 *
 * NÃO substitui a integração final: não descobre o orderId sozinha, não
 * autentica e depende de alguém colar o payload à mão.
 */
export async function importarCatalogoManual({ organizacaoId, unidadeId, usuarioId, payload, orderId, pedidoPayload }) {
  const integracao = await exigirIntegracao({ organizacaoId, unidadeId });
  const clientId = integracao.client_id;
  const iniciadoEm = new Date().toISOString();

  const jaRodando = await repo.sincronizacaoEmAndamento({ organizacaoId, unidadeId });
  if (jaRodando) throw mbErro(MB_ERROS.MARTIN_BROWER_SYNC_CONFLICT);

  // orderId: preferimos o do payload de pedido, depois o informado, e por
  // último o que vier dentro dos próprios itens. Jamais um valor fixo.
  const pedido = pedidoPayload ? normalizarPedido(pedidoPayload) : null;
  const orderIdFinal = pedido?.orderId ?? orderId ?? payload?.data?.groups?.[0]?.itens?.[0]?.orderHeaderId ?? null;

  const sinc = await repo.criarSincronizacao({
    organizacaoId, unidadeId, clientId, criadoPor: usuarioId,
    origem: "importacao_manual", status: MB_STATUS.SINCRONIZANDO,
  });

  try {
    const resumo = await processarCatalogo({
      organizacaoId, unidadeId, clientId, orderId: orderIdFinal,
      payload, sincronizacaoId: sinc.id,
    });

    const finalizadoEm = new Date().toISOString();
    await repo.atualizarSincronizacao({ organizacaoId, unidadeId, sincronizacaoId: sinc.id, campos: {
      status: MB_STATUS.CONCLUIDO, order_id: orderIdFinal,
      produtos_encontrados: resumo.produtosEncontrados, produtos_validos: resumo.produtosValidos,
      produtos_ignorados: resumo.produtosIgnorados, produtos_criados: resumo.produtosCriados,
      produtos_atualizados: resumo.produtosAtualizados, precos_alterados: resumo.precosAlterados,
      produtos_com_erro: resumo.produtosComErro,
      financial_restriction: pedido?.financialRestriction ?? null,
      janela_inicio: pedido?.janelaInicio ?? null, janela_final: pedido?.janelaFinal ?? null,
      finalizado_em: finalizadoEm,
    } });
    await repo.atualizarStatusIntegracao({ organizacaoId, unidadeId, campos: {
      status: "concluido", ultimo_order_id: orderIdFinal, ultima_sincronizacao: finalizadoEm, ultimo_erro: null,
    } });

    auditarSincronizacao({ organizacaoId, unidadeId, clientId, orderId: orderIdFinal, usuarioId,
      iniciadoEm, finalizadoEm, produtos: resumo.produtosValidos, erros: resumo.produtosComErro, status: "concluido" });

    return { sincronizacaoId: sinc.id, orderId: orderIdFinal, origem: "importacao_manual", ...resumo };
  } catch (e) {
    await repo.atualizarSincronizacao({ organizacaoId, unidadeId, sincronizacaoId: sinc.id, campos: {
      status: MB_STATUS.ERRO, erro_codigo: e?.codigo ?? null, erro_mensagem: e?.message ?? null,
      finalizado_em: new Date().toISOString(),
    } }).catch(() => {});
    throw e;
  }
}

// Consulta o pedido corrente usando uma sessão já autenticada (Fase 3).
// Exportado agora para que a rota exista e o contrato fique fechado.
export async function consultarPedidoAtual({ organizacaoId, unidadeId, sessao, sinal }) {
  const integracao = await exigirIntegracao({ organizacaoId, unidadeId });
  return descobrirPedidoAtual({ clientId: integracao.client_id, sessao, sinal });
}
