import { Router } from "express";
import * as controller from "./produtos.controller.js";
import { requirePermissao } from "../../middlewares/auth.js";
import { PERMISSOES } from "../../shared/permissoes.js";

export const produtosRouter = Router();

const editarProdutos = requirePermissao(PERMISSOES.PRODUTOS_EDITAR);

produtosRouter.get("/", controller.listar);
produtosRouter.get("/historico/recentes", controller.historicoRecente); // antes de "/:id"
produtosRouter.get("/:id", controller.obter);
produtosRouter.get("/:id/historico", controller.historico);
produtosRouter.put("/:id", editarProdutos, controller.atualizar);
produtosRouter.delete("/:id", editarProdutos, controller.remover);

// Ficha técnica editável (escrita exige permissão de edição de produtos).
produtosRouter.post("/:id/ficha", editarProdutos, controller.adicionarComponente);
produtosRouter.patch("/:id/ficha/:fichaId", editarProdutos, controller.atualizarComponente);
produtosRouter.delete("/:id/ficha/:fichaId", editarProdutos, controller.removerComponente);
