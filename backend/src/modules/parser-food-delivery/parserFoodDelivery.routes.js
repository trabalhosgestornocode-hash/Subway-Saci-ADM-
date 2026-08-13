import { Router } from "express";
import * as controller from "./parserFoodDelivery.controller.js";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";

export const parserFoodDeliveryRouter = Router();

const ver = requirePermissao(PERMISSOES.PARSER_FD_VER);
const importar = requirePermissao(PERMISSOES.PARSER_FD_IMPORTAR);
const excluir = requirePermissao(PERMISSOES.PARSER_FD_EXCLUIR);

parserFoodDeliveryRouter.get("/importacoes", ver, controller.importacoes);
parserFoodDeliveryRouter.get("/importacoes/:id", ver, controller.importacaoDetalhe);
parserFoodDeliveryRouter.get("/importacoes/:id/arquivo", ver, controller.arquivoImportacao);
parserFoodDeliveryRouter.post("/importacoes/:id/codigos-sem-taxa", importar, controller.editarCodigos);
parserFoodDeliveryRouter.post("/importacoes/:id/excluir", excluir, controller.excluirImportacao);

// Importação: prévia (dry-run) do arquivo -> prévia da conciliação -> confirmação.
parserFoodDeliveryRouter.post("/importar/preview", importar, controller.importarPreview);
parserFoodDeliveryRouter.post("/conciliar/preview", importar, controller.conciliarPreview);
parserFoodDeliveryRouter.post("/conciliar/confirmar", importar, controller.conciliarConfirmar);
