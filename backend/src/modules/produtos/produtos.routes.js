import { Router } from "express";
import * as controller from "./produtos.controller.js";

export const produtosRouter = Router();
produtosRouter.get("/", controller.listar);
produtosRouter.get("/:id", controller.obter);
produtosRouter.put("/:id", controller.atualizar);
