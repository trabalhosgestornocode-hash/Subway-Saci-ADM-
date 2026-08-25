import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./unidade.service.js";

// A unidade vem SEMPRE de req.tenant (Context Token) — nenhum handler aqui
// aceita unidadeId do corpo/query (ver comentário no topo do service).

export const obterTabelasComerciais = asyncHandler(async (req, res) => {
  const data = await service.obterTabelasComerciais({ unidadeId: req.tenant.unidadeId });
  res.json({ data });
});

export const alterarTabelaComercial = asyncHandler(async (req, res) => {
  const data = await service.alterarTabelaComercial(req, req.body ?? {});
  res.json({ data });
});
