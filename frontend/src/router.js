import { state } from "./state.js";
import { MENU } from "./config.js";
import { el, els } from "./utils.js";
import * as views from "./views.js";
import { renderConfiguracoes } from "./configuracoes.js";

// Navega para uma rota da sidebar
export function irPara(rotaId) {
  const item = MENU.find((m) => m.id === rotaId) || MENU[0];
  state.rota = item.id;
  el("#page-title").textContent = item.label;
  els("#menu li").forEach((li) => li.classList.toggle("ativo", li.dataset.rota === item.id));
  el("#app").classList.remove("menu-aberto"); // fecha sidebar no mobile
  renderRotaAtual();
}

// Renderiza a view da rota atual (chamado também após (re)carregar dados)
export function renderRotaAtual() {
  const item = MENU.find((m) => m.id === state.rota) || MENU[0];
  switch (item.tipo) {
    case "pagina":
      if (item.id === "produtos") views.renderProdutos();
      else views.renderDashboard();
      break;
    case "integracoes":
      views.renderIntegracoes();
      break;
    case "integracao":
      views.renderIntegracaoDetalhe(item.integ);
      break;
    case "configuracoes":
      renderConfiguracoes();
      break;
    case "construcao":
      views.renderConstrucao(item.id, item.label);
      break;
    default:
      views.renderDashboard();
  }
}
