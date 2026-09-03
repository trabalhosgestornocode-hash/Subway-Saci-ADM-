import { Router } from "express";
import * as controller from "./agente.controller.js";
import { limiteDeTaxa, combinar } from "../../shared/rateLimit.js";
import { RATE_LIMIT_AGENTE } from "../../config/limites.js";

// requireContexto e requireModulo(MODULOS.AGENTE_IA) já são aplicados na
// montagem deste router em routes.js — mesmo padrão dos demais módulos.
export const agenteRouter = Router();

// Proteção FINANCEIRA — 1ª camada, por CONTA, em MEMÓRIA: pré-filtro barato que
// corta rajada (spam, automação, loop) antes de tocar o banco. A 2ª camada — a
// autoridade — é a RESERVA ATÔMICA (org + conta + perfil) feita no service via
// a RPC agente_reservar_quota (migration 067).
const limiteAgenteConta = combinar(
  limiteDeTaxa({ escopo: "agente:conta:min", ...RATE_LIMIT_AGENTE.memoriaPorContaMinuto }),
  limiteDeTaxa({ escopo: "agente:conta:hora", ...RATE_LIMIT_AGENTE.memoriaPorContaHora }),
);

agenteRouter.post("/mensagem", limiteAgenteConta, controller.mensagem);
agenteRouter.get("/conversas/:conversationId", controller.historicoConversa);
