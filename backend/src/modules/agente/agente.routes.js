import { Router } from "express";
import * as controller from "./agente.controller.js";

// requireContexto e requireModulo(MODULOS.AGENTE_IA) já são aplicados na
// montagem deste router em routes.js — mesmo padrão dos demais módulos.
export const agenteRouter = Router();

agenteRouter.post("/mensagem", controller.mensagem);
agenteRouter.get("/conversas/:conversationId", controller.historicoConversa);
