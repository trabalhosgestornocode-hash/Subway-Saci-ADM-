import { Router } from "express";
import * as controller from "./contexto.controller.js";

export const contextoRouter = Router();
contextoRouter.get("/", controller.obter);
contextoRouter.post("/acessar", controller.acessar);
contextoRouter.get("/acessos", controller.acessos);
