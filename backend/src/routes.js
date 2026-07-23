import { Router } from "express";
import { produtosRouter } from "./modules/produtos/produtos.routes.js";
import { cmvRouter } from "./modules/cmv/cmv.routes.js";
import { dashboardRouter } from "./modules/dashboard/dashboard.routes.js";
import { usuariosRouter } from "./modules/usuarios/usuarios.routes.js";
import { vendasRouter } from "./modules/vendas/vendas.routes.js";
import { contextoRouter } from "./modules/contexto/contexto.routes.js";
import { martinBrowerRouter } from "./modules/martinbrower/martinbrower.routes.js";

export const router = Router();
router.use("/produtos", produtosRouter);
router.use("/cmv", cmvRouter);
router.use("/dashboard", dashboardRouter);
router.use("/usuarios", usuariosRouter);
router.use("/vendas", vendasRouter);
router.use("/contexto", contextoRouter);
router.use("/integracoes/martin-brower", martinBrowerRouter);
