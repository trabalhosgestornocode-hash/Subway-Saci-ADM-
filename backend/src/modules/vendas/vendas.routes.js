import { Router } from "express";
import * as controller from "./vendas.controller.js";

export const vendasRouter = Router();

// Consultas
vendasRouter.get("/visao-geral", controller.visaoGeral);
vendasRouter.get("/faturamento", controller.faturamento);
vendasRouter.get("/produtos", controller.produtosVendidos);
vendasRouter.get("/importacoes", controller.importacoes);
vendasRouter.get("/importacoes/:id/arquivo", controller.arquivoOriginal);
vendasRouter.delete("/importacoes/:id", controller.excluirImportacao);
vendasRouter.get("/divergencias", controller.divergencias);
vendasRouter.patch("/divergencias/:id", controller.resolverDivergencia);

// Importação (serviço central: mesma lógica p/ manual, API ou iFood).
// O arquivo original vai em base64 e é interpretado no backend (CSV/Excel/PDF).
vendasRouter.post("/importar/preview", controller.preview);   // dry-run
vendasRouter.post("/importar", controller.importar);          // confirma e persiste

// Vínculo de produto do SW -> produto do sistema
vendasRouter.post("/vincular", controller.vincular);
vendasRouter.post("/vincular-lote", controller.vincularLote);
vendasRouter.get("/combos/:codigo/componentes", controller.componentesCombo);
