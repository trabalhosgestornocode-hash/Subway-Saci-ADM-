import { Router } from "express";
import * as controller from "./cmv.controller.js";

export const cmvRouter = Router();
cmvRouter.get("/", controller.listar);              // /cmv?canal=balcao&tabela=A
cmvRouter.get("/produto/:id", controller.porProduto);
