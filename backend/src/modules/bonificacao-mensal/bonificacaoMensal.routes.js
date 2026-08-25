import { Router } from "express";
import * as controller from "./bonificacaoMensal.controller.js";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";

export const bonificacaoMensalRouter = Router();

const ver = requirePermissao(PERMISSOES.BONIFICACAO_MENSAL_VER);
const lancar = requirePermissao(PERMISSOES.BONIFICACAO_MENSAL_LANCAR);
const configurar = requirePermissao(PERMISSOES.BONIFICACAO_MENSAL_CONFIGURAR);
const excluir = requirePermissao(PERMISSOES.BONIFICACAO_MENSAL_EXCLUIR);

bonificacaoMensalRouter.get("/mes", ver, controller.mes);
bonificacaoMensalRouter.get("/metas", ver, controller.metas);
bonificacaoMensalRouter.post("/metas/:indicador", configurar, controller.salvarMeta);
bonificacaoMensalRouter.get("/historico", ver, controller.historico);
bonificacaoMensalRouter.get("/lancamentos/:data", ver, controller.lancamentoPorData);
bonificacaoMensalRouter.post("/lancamentos", lancar, controller.salvarLancamento);
bonificacaoMensalRouter.post("/lancamentos/:data/excluir", excluir, controller.excluirLancamento);

// Indicadores manuais (Pesquisas/Avaliação iFood/Pedidos com chamado/
// Cancelamentos) — acompanhamento diário, igual à Visio.
bonificacaoMensalRouter.get("/indicadores/:indicador/calendario", ver, controller.calendarioIndicador);
bonificacaoMensalRouter.get("/indicadores/:indicador/historico", ver, controller.historicoMensalIndicador);
bonificacaoMensalRouter.post("/indicadores/:indicador", lancar, controller.salvarValorDiaIndicador);

// REV (migration 052): 1 valor por unidade+mês, não mais diário. Leitura
// vem embutida em GET /mes (campo revMensal).
bonificacaoMensalRouter.post("/rev", lancar, controller.salvarRevMensal);

bonificacaoMensalRouter.get("/importacoes", ver, controller.importacoes);
bonificacaoMensalRouter.get("/importacoes/:id/arquivo", ver, controller.arquivoImportacao);

// Importação dos 2 PDFs da Visio: prévia (dry-run) sempre antes de confirmar.
bonificacaoMensalRouter.post("/importar/preview", lancar, controller.importarPreview);
bonificacaoMensalRouter.post("/importar", lancar, controller.importarConfirmar);
