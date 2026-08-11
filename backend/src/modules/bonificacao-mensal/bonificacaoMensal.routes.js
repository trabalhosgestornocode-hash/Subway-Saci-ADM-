import { Router } from "express";
import * as controller from "./bonificacaoMensal.controller.js";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";

export const bonificacaoMensalRouter = Router();

const ver = requirePermissao(PERMISSOES.BONIFICACAO_MENSAL_VER);
const lancar = requirePermissao(PERMISSOES.BONIFICACAO_MENSAL_LANCAR);
const excluir = requirePermissao(PERMISSOES.BONIFICACAO_MENSAL_EXCLUIR);

bonificacaoMensalRouter.get("/mes", ver, controller.mes);
bonificacaoMensalRouter.get("/metas", ver, controller.metas);
bonificacaoMensalRouter.get("/historico", ver, controller.historico);
bonificacaoMensalRouter.get("/lancamentos/:data", ver, controller.lancamentoPorData);
bonificacaoMensalRouter.post("/lancamentos", lancar, controller.salvarLancamento);
bonificacaoMensalRouter.post("/lancamentos/:data/excluir", excluir, controller.excluirLancamento);

bonificacaoMensalRouter.get("/importacoes", ver, controller.importacoes);
bonificacaoMensalRouter.get("/importacoes/:id/arquivo", ver, controller.arquivoImportacao);

// Importação dos 2 PDFs da Visio: prévia (dry-run) sempre antes de confirmar.
bonificacaoMensalRouter.post("/importar/preview", lancar, controller.importarPreview);
bonificacaoMensalRouter.post("/importar", lancar, controller.importarConfirmar);
