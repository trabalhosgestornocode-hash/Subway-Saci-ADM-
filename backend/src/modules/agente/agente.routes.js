import { Router } from "express";
import * as controller from "./agente.controller.js";
import { limiteDeTaxa, combinar } from "../../shared/rateLimit.js";
import { RATE_LIMIT_AGENTE } from "../../config/limites.js";

// requireContexto e requireModulo(MODULOS.AGENTE_IA) já são aplicados na
// montagem deste router em routes.js — mesmo padrão dos demais módulos.
export const agenteRouter = Router();

// Proteção FINANCEIRA (P0.5) — 1ª camada, por CONTA, em memória: corta rajada
// de dezenas/centenas de chamadas (spam, automação, loop). A 2ª camada é o
// teto por ORGANIZAÇÃO verificado contra agente_uso dentro do service.
const limiteAgenteConta = combinar(
  limiteDeTaxa({ escopo: "agente:conta:min", ...RATE_LIMIT_AGENTE.porContaMinuto }),
  limiteDeTaxa({ escopo: "agente:conta:hora", ...RATE_LIMIT_AGENTE.porContaHora }),
);

agenteRouter.post("/mensagem", limiteAgenteConta, controller.mensagem);
agenteRouter.get("/conversas/:conversationId", controller.historicoConversa);
