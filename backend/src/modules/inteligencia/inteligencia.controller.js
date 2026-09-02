import { asyncHandler } from "../../shared/asyncHandler.js";
import { INTEGRACOES } from "./inteligencia.catalogo.js";

// O gate real é o requireModulo('inteligencia') aplicado na montagem do router
// (ver routes.js). Aqui é só entrega de dado estático — nenhum acesso a banco,
// nada escopado por tenant (o catálogo é o mesmo para toda empresa que tem o
// módulo). Impersonação de SuperAdmin passa pelo mesmo bypass de requireModulo.
export const listarIntegracoes = asyncHandler(async (_req, res) => {
  res.json({ data: { integracoes: INTEGRACOES } });
});
