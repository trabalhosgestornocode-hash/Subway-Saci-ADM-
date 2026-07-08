import { Router } from "express";
import * as controller from "./produtos.controller.js";

export const produtosRouter = Router();
produtosRouter.get("/", controller.listar);
produtosRouter.get("/historico/recentes", controller.historicoRecente); // antes de "/:id"
produtosRouter.get("/:id", controller.obter);
produtosRouter.get("/:id/historico", controller.historico);
produtosRouter.put("/:id", controller.atualizar);
