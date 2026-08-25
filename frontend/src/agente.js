// Agente Crescer — modo PÁGINA CHEIA (rota "ia" do menu).
//
// Toda a lógica de chat (envio, loading, rehidratação, histórico, Markdown
// seguro, tools consultadas, limpar) mora em agenteChat.js — a MESMA usada
// pelo painel global (agentePainel.js). Este arquivo só monta o layout de
// página inteira e delega. Ver agenteChat.js para o motor compartilhado.
import { el } from "./utils.js";
import { montarChatAgente } from "./agenteChat.js";

let instanciaAtual = null;

export function renderAgente() {
  el("#view").innerHTML = `<div class="agente" id="agente-pagina"></div>`;
  instanciaAtual?.desmontar();
  instanciaAtual = montarChatAgente(el("#agente-pagina"), { modo: "pagina" });
}
