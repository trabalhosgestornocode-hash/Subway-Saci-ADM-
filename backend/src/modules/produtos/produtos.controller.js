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
  });
  res.json({ data });
});
