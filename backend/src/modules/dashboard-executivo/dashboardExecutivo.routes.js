import { Router } from "express";
import * as controller from "./dashboardExecutivo.controller.js";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";

// Leitura exige dashboard_executivo.ver; lançar exige .lancar. A correção de
// um lançamento já finalizado exige .corrigir — isso é verificado dentro do
// service (a regra depende do STATUS do registro, não só da rota), nunca só
// no frontend.
export const dashboardExecutivoRouter = Router();

const ver = requirePermissao(PERMISSOES.DASHBOARD_EXECUTIVO_VER);
const lancar = requirePermissao(PERMISSOES.DASHBOARD_EXECUTIVO_LANCAR);

dashboardExecutivoRouter.get("/unidades", ver, controller.unidades);
dashboardExecutivoRouter.get("/mes", ver, controller.mes);
dashboardExecutivoRouter.get("/historico", ver, controller.historico);
dashboardExecutivoRouter.get("/lancamentos/:data", ver, controller.lancamentoPorData);
dashboardExecutivoRouter.post("/lancamentos", lancar, controller.criarLancamento);
dashboardExecutivoRouter.put("/lancamentos/:id", lancar, controller.atualizarLancamento);
