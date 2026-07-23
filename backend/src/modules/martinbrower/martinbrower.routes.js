// Rotas da integração Martin Brower.
// Montadas sob /api/v1, que já exige autenticação real (requireAuth em app.js).

import { Router } from "express";
import * as controller from "./martinbrower.controller.js";
import { requirePapel } from "../../middlewares/auth.js";
import { limitarPorUsuario } from "./martinbrower.ratelimit.js";
import { workerHabilitado } from "./martinbrower.worker.contract.js";
import { mbErro, MB_ERROS } from "./martinbrower.errors.js";

export const martinBrowerRouter = Router();

// Guarda das rotas que recebem credenciais: com a flag desligada elas nem
// chegam ao controller — o corpo com a senha é descartado sem ser lido.
const exigirWorker = (_req, _res, next) =>
  workerHabilitado() ? next() : next(mbErro(MB_ERROS.MARTIN_BROWER_WORKER_DISABLED));

// --- consultas (qualquer usuário com vínculo na unidade) ------------------
martinBrowerRouter.get("/settings", controller.obterConfiguracao);
martinBrowerRouter.get("/products", controller.listarProdutos);
martinBrowerRouter.get("/price-history", controller.historicoPrecos);
martinBrowerRouter.get("/sync-history", controller.historicoSincronizacoes);
martinBrowerRouter.get("/unlinked", controller.semVinculo);

// --- configuração e vínculo (admin) --------------------------------------
martinBrowerRouter.put("/settings", requirePapel("admin"), controller.salvarConfiguracao);
martinBrowerRouter.post("/links", requirePapel("admin"), controller.vincular);
martinBrowerRouter.delete("/links/:mbProdutoId", requirePapel("admin"), controller.desvincular);

// --- sincronização automatizada (Fase 3 — atrás de MB_PLAYWRIGHT_ENABLED) --
// Rate limit apertado: são as rotas que recebem senha e código 2FA.
martinBrowerRouter.post("/start",
  exigirWorker, limitarPorUsuario({ escopo: "start", max: 3 }), controller.iniciar);
martinBrowerRouter.post("/:sessionId/code",
  exigirWorker, limitarPorUsuario({ escopo: "code", max: 5 }), controller.informarCodigo);
martinBrowerRouter.post("/:sessionId/cancel", exigirWorker, controller.cancelar);
martinBrowerRouter.get("/:sessionId/status", exigirWorker, controller.statusSessao);

// --- importação manual (ferramenta TEMPORÁRIA de teste, só admin) ---------
// Valida normalização, filtros, upsert e histórico sem depender do Playwright.
martinBrowerRouter.post("/import-manual",
  requirePapel("admin"), limitarPorUsuario({ escopo: "import", max: 10 }), controller.importarManual);
