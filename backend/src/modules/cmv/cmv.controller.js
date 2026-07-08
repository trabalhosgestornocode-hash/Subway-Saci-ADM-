import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./cmv.service.js";

export const listar = asyncHandler(async (req, res) => {
  const { canal, tabela } = req.query;
  const data = await service.listarMargens({
    organizacaoId: req.tenant.organizacaoId,
    canal,
    tabela,
  });
  res.json({ data });
});

export const porProduto = asyncHandler(async (req, res) => {
  const data = await service.margemProduto({
    organizacaoId: req.tenant.organizacaoId,
    produtoId: req.params.id,
  });
  res.json({ data });
});
