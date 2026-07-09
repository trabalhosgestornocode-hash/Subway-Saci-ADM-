import { Router } from "express";
import * as controller from "./usuarios.controller.js";
import { requirePapel } from "../../middlewares/auth.js";

// Gestão de usuários é restrita a Administrador / Desenvolvedor.
const soAdmin = requirePapel("admin", "desenvolvedor");

export const usuariosRouter = Router();
usuariosRouter.get("/", soAdmin, controller.listar);
usuariosRouter.post("/", soAdmin, controller.criar);
usuariosRouter.patch("/:id", soAdmin, controller.atualizar);
usuariosRouter.delete("/:id", soAdmin, controller.excluir);
