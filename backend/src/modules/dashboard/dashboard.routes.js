import { Router } from "express";
import * as controller from "./dashboard.controller.js";

export const dashboardRouter = Router();
dashboardRouter.get("/resumo", controller.resumo);
