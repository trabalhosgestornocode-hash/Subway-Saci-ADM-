import { Router } from "express";
import * as controller from "./insumos.controller.js";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";

// Leitura exige insumos.ver; escrita exige insumos.editar. O papel de consulta
// enxerga, mas não altera — a autorização é no servidor, nunca só no front.
export const insumosRouter = Router();

const verInsumos = requirePermissao(PERMISSOES.INSUMOS_VER);
const editarInsumos = requirePermissao(PERMISSOES.INSUMOS_EDITAR);

insumosRouter.get("/", verInsumos, controller.listar);
insumosRouter.get("/:id", verInsumos, controller.obter);
insumosRouter.get("/:id/produtos", verInsumos, controller.produtos);
insumosRouter.post("/", editarInsumos, controller.criar);
insumosRouter.put("/:id", editarInsumos, controller.atualizar);
insumosRouter.patch("/:id/status", editarInsumos, controller.definirAtivo);
insumosRouter.delete("/:id", editarInsumos, controller.remover);
