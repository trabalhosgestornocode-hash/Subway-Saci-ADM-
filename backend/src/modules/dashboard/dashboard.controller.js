import { asyncHandler } from "../../shared/asyncHandler.js";
import * as service from "./dashboard.service.js";

export const resumo = asyncHandler(async (req, res) => {
  const data = await service.resumo({ unidadeId: req.tenant.unidadeId });
  res.json({ data });
});
