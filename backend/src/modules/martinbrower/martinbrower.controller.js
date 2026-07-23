// Controllers da integração Martin Brower.
//
// Segue o padrão dos módulos existentes: fino, sem regra de negócio, tenant
// sempre de req.tenant, resposta em { data }.
//
// NENHUM controller aqui lê organizacaoId ou unidadeId do corpo/query — se
// o frontend quiser trocar de loja, ele manda o header x-unidade-id, que o
// requireAuth valida contra os vínculos do usuário antes de chegar aqui.

import { asyncHandler } from "../../shared/asyncHandler.js";
import { ApiError } from "../../shared/ApiError.js";
import * as service from "./martinbrower.service.js";
import * as v from "./martinbrower.validators.js";

const tenant = (req) => {
  const { organizacaoId, unidadeId } = req.tenant ?? {};
  if (!unidadeId) {
    throw ApiError.badRequest("Selecione a loja antes de usar a integração Martin Brower.");
  }
  return { organizacaoId, unidadeId };
};

// --- configuração ---------------------------------------------------------

export const obterConfiguracao = asyncHandler(async (req, res) => {
  res.json({ data: await service.obterConfiguracao(tenant(req)) });
});

export const salvarConfiguracao = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const clientId = v.validarClientId(req.body?.clientId);
  const unidadeNome = typeof req.body?.unidadeNome === "string" ? req.body.unidadeNome.trim().slice(0, 120) : null;
  const ativo = req.body?.ativo !== false;
  res.json({ data: await service.salvarConfiguracao({ organizacaoId, unidadeId, clientId, unidadeNome, ativo }) });
});

// --- catálogo e histórico -------------------------------------------------

export const listarProdutos = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  res.json({ data: await service.listarProdutos({ organizacaoId, unidadeId, filtros: v.validarFiltrosListagem(req.query) }) });
});

export const historicoPrecos = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const codigo = typeof req.query.codigo === "string" ? req.query.codigo.trim() : null;
  res.json({ data: await service.listarHistoricoPrecos({ organizacaoId, unidadeId, codigo, limite: req.query.limite }) });
});

export const historicoSincronizacoes = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  res.json({ data: await service.listarSincronizacoes({ organizacaoId, unidadeId, limite: req.query.limite }) });
});

// --- vínculo com insumo interno -------------------------------------------

export const semVinculo = asyncHandler(async (req, res) => {
  res.json({ data: await service.listarSemVinculo(tenant(req)) });
});

export const vincular = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const mbProdutoId = v.validarUuid(req.body?.mbProdutoId, "mbProdutoId");
  const insumoId = v.validarUuid(req.body?.insumoId, "insumoId");
  const observacao = typeof req.body?.observacao === "string" ? req.body.observacao.slice(0, 500) : null;
  res.status(201).json({ data: await service.criarVinculo({
    organizacaoId, unidadeId, mbProdutoId, insumoId, confirmadoPor: req.user.id, observacao,
  }) });
});

export const desvincular = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const mbProdutoId = v.validarUuid(req.params.mbProdutoId, "mbProdutoId");
  res.json({ data: await service.removerVinculo({ organizacaoId, unidadeId, mbProdutoId }) });
});

// --- sincronização automatizada (só responde com MB_PLAYWRIGHT_ENABLED=true)

export const iniciar = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  // As credenciais só são LIDAS depois que o service confirma que o worker
  // está habilitado — com a flag desligada, a senha nem é tocada.
  const credenciais = v.validarCredenciais(req.body);
  const data = await service.iniciarSincronizacao({
    organizacaoId, unidadeId, usuarioId: req.user.id, credenciais,
  });
  res.status(202).json({ data });
});

export const informarCodigo = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  res.json({ data: service.informarCodigo({
    sessionId: v.validarSessionId(req.params.sessionId),
    usuarioId: req.user.id, organizacaoId, unidadeId,
    codigo: v.validarCodigo2fa(req.body),
  }) });
});

export const statusSessao = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  res.json({ data: service.statusSessao({
    sessionId: v.validarSessionId(req.params.sessionId),
    usuarioId: req.user.id, organizacaoId, unidadeId,
  }) });
});

export const cancelar = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  res.json({ data: service.cancelarSincronizacao({
    sessionId: v.validarSessionId(req.params.sessionId),
    usuarioId: req.user.id, organizacaoId, unidadeId,
  }) });
});

// --- importação manual (ferramenta temporária de teste, restrita a admin) --

export const importarManual = asyncHandler(async (req, res) => {
  const { organizacaoId, unidadeId } = tenant(req);
  const payload = v.validarPayloadCatalogo(req.body);
  const orderId = v.validarOrderIdOpcional(req.body?.orderId);
  const pedidoPayload = req.body?.pedido && typeof req.body.pedido === "object" ? req.body.pedido : null;

  res.status(201).json({ data: await service.importarCatalogoManual({
    organizacaoId, unidadeId, usuarioId: req.user.id, payload, orderId, pedidoPayload,
  }) });
});
