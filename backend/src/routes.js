import { Router } from "express";
import { produtosRouter } from "./modules/produtos/produtos.routes.js";
import { cmvRouter } from "./modules/cmv/cmv.routes.js";
import { dashboardRouter } from "./modules/dashboard/dashboard.routes.js";

export const router = Router();
router.use("/produtos", produtosRouter);
router.use("/cmv", cmvRouter);
router.use("/dashboard", dashboardRouter);
