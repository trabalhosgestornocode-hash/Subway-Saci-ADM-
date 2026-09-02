import { Router } from "express";
import * as controller from "./inteligencia.controller.js";

// requireContexto e requireModulo(MODULOS.INTELIGENCIA) já são aplicados na
// montagem deste router em routes.js — mesmo padrão dos demais módulos. Sem o
// módulo `inteligencia`, nada aqui responde (403).
export const inteligenciaRouter = Router();

inteligenciaRouter.get("/integracoes", controller.listarIntegracoes);
