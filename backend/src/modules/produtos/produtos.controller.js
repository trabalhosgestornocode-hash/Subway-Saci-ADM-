import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./produtos.service.js";

export const listar = asyncHandler(async (req, res) => {
  const { vendavel, tipo } = req.query;
  const data = await service.listarProdutos({
    organizacaoId: req.tenant.organizacaoId,
    vendavel: vendavel === undefined ? undefined : vendavel === "true",
    tipo,
  });
  res.json({ data });
});

export const obter = asyncHandler(async (req, res) => {
  const data = await service.obterProduto({
    organizacaoId: req.tenant.organizacaoId,
    id: req.params.id,
  });
  res.json({ data });
});

export const atualizar = asyncHandler(async (req, res) => {
  const data = await service.atualizarProduto({
    organizacaoId: req.tenant.organizacaoId,
    id: req.params.id,
    dados: req.body ?? {},
    usuario: req.user, // { id, nome, email } — para a auditoria
  });
  res.json({ data });
});

export const historico = asyncHandler(async (req, res) => {
  const data = await service.listarHistoricoProduto({
    organizacaoId: req.tenant.organizacaoId,
    produtoId: req.params.id,
  });
  res.json({ data });
});

export const historicoRecente = asyncHandler(async (req, res) => {
  const limite = Math.min(Math.max(Number(req.query.limite) || 8, 1), 30);
  const data = await service.listarHistoricoRecente({
    organizacaoId: req.tenant.organizacaoId,
    limite,
  });
  res.json({ data });
});
