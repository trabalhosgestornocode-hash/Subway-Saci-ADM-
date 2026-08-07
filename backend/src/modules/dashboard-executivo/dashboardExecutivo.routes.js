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
const configurar = requirePermissao(PERMISSOES.DASHBOARD_EXECUTIVO_CONFIGURAR);
const resetarTeste = requirePermissao(PERMISSOES.DASHBOARD_EXECUTIVO_RESETAR_TESTE);

dashboardExecutivoRouter.get("/unidades", ver, controller.unidades);
dashboardExecutivoRouter.get("/mes", ver, controller.mes);
dashboardExecutivoRouter.get("/historico", ver, controller.historico);
dashboardExecutivoRouter.get("/lancamentos/:data", ver, controller.lancamentoPorData);
dashboardExecutivoRouter.post("/lancamentos", lancar, controller.criarLancamento);
dashboardExecutivoRouter.put("/lancamentos/:id", lancar, controller.atualizarLancamento);

// Modelo logístico do iFood (Marketplace x Full Service) — quem só vê usa VER;
// trocar exige CONFIGURAR (finance/operations/organization_admin, não unit_manager).
dashboardExecutivoRouter.get("/unidades/:unidadeId/modelo-logistico", ver, controller.modeloLogistico);
dashboardExecutivoRouter.put("/unidades/:unidadeId/modelo-logistico", configurar, controller.atualizarModeloLogistico);
dashboardExecutivoRouter.get("/unidades/:unidadeId/modelo-logistico/historico", ver, controller.historicoModeloLogistico);

// Reset de dia — SÓ em unidade de teste (eh_teste=true), revalidado sempre no
// service. Mesma permissão de correção não serve aqui de propósito: é uma
// ação estritamente de desenvolvimento/teste, com sua própria permissão.
dashboardExecutivoRouter.post("/unidades/:unidadeId/reset-teste", resetarTeste, controller.resetTeste);
