// Aba MARTIN BROWER — área dedicada de acesso ao portal da distribuidora.
// Fase atual: somente interface. O portal oficial é embutido via iframe com
// estados de carregando / carregado / erro / bloqueado. Nenhuma automação,
// credencial ou sincronização acontece aqui ainda — as próximas fases (login
// automatizado, 2FA, sincronização de produtos/preços, pedidos e agente de IA)
// serão plugadas nesta mesma área.
import { el } from "./utils.js";

export const MB_PORTAL_URL = "https://portal.martinbrower.com.br/";
const MB_LOGO = "/assets/logo-mb.jpeg";
const TIMEOUT_CARREGAMENTO = 20000; // ms aguardando o iframe antes de considerar erro

// Estado da página (padrão dos módulos vendas.js / configuracoes.js)
const mb = { estado: "carregando", timer: null };

const STATUS_PORTAL = {
  carregando: { classe: "info", label: "Conectando ao portal…" },
  carregado:  { classe: "ok",   label: "Portal online" },
  erro:       { classe: "bad",  label: "Falha ao carregar" },
  bloqueado:  { classe: "warn", label: "Abrir externamente" },
};

// ---------- pedaços de UI ----------
const overlayCarregando = () => `
  <div class="mb-overlay" id="mb-overlay">
    <div class="spinner"></div>
    <p>Carregando o portal Martin Brower…</p>
    <div class="mb-skels">
      <div class="vd-skel mb-skel-topo"></div>
      <div class="vd-skel mb-skel-corpo"></div>
    </div>
  </div>`;

const painelExterno = (titulo, msg) => `
  <div class="mb-externo" id="mb-externo">
    <div class="mb-externo-logo"><img src="${MB_LOGO}" alt="Martin Brower" /></div>
    <h3>${titulo}</h3>
    <p>${msg}</p>
    <button class="btn btn-primary mb-btn-destaque" id="mb-abrir-destaque">Abrir Portal Martin Brower ↗</button>
    <button class="btn btn-ghost" id="mb-tentar">🔄 Tentar novamente</button>
  </div>`;

// ---------- estados ----------
function setEstado(novo) {
  mb.estado = novo;
  clearTimeout(mb.timer);
  const st = STATUS_PORTAL[novo];
  const pill = el("#mb-status");
  if (pill) { pill.className = `pill ${st.classe}`; pill.textContent = st.label; }
  const corpo = el("#mb-corpo");
  if (!corpo) return;

  el("#mb-overlay")?.remove();
  el("#mb-externo")?.remove();
  const frame = el("#mb-frame");

  if (novo === "carregando") {
    if (frame) frame.classList.remove("visivel");
    corpo.insertAdjacentHTML("beforeend", overlayCarregando());
  } else if (novo === "carregado") {
    frame?.classList.add("visivel");
    el("#mb-hint")?.classList.add("visivel");
  } else {
    // erro ou bloqueado: portal não pôde ser exibido embutido — sem contornos,
    // apenas o caminho oficial em nova guia.
    if (frame) frame.classList.remove("visivel");
    el("#mb-hint")?.classList.remove("visivel");
    corpo.insertAdjacentHTML("beforeend", novo === "bloqueado"
      ? painelExterno("O portal precisa ser aberto externamente",
          "O portal da Martin Brower não permite ser exibido dentro de outros sistemas por políticas de segurança. Use o botão abaixo para acessá-lo em uma nova guia — suas próximas etapas de integração continuarão sendo preparadas por aqui.")
      : painelExterno("Não foi possível carregar o portal",
          "O portal não respondeu dentro do tempo esperado. Verifique sua conexão e tente novamente, ou acesse diretamente em uma nova guia."));
    el("#mb-abrir-destaque")?.addEventListener("click", abrirEmNovaGuia);
    el("#mb-tentar")?.addEventListener("click", recarregarPortal);
  }
}

function abrirEmNovaGuia() {
  window.open(MB_PORTAL_URL, "_blank", "noopener");
}

function recarregarPortal() {
  const frame = el("#mb-frame");
  if (!frame) return;
  setEstado("carregando");
  armarTimeout();
  frame.src = MB_PORTAL_URL;
}

function armarTimeout() {
  clearTimeout(mb.timer);
  mb.timer = setTimeout(() => { if (mb.estado === "carregando") setEstado("erro"); }, TIMEOUT_CARREGAMENTO);
}

function aoCarregarFrame(frame) {
  if (mb.estado !== "carregando") return;
  // Cross-origin: contentDocument é null quando o portal carregou de verdade.
  // Se continuar acessível, o navegador manteve uma página local (vazia/erro),
  // sinal de que a incorporação foi recusada.
  let bloqueado = false;
  try { if (frame.contentDocument) bloqueado = true; } catch { /* cross-origin = ok */ }
  setEstado(bloqueado ? "bloqueado" : "carregado");
}

// ---------- render ----------
export function renderMartinBrower() {
  const view = el("#view");
  if (!view) return;
  mb.estado = "carregando";

  view.innerHTML = `
    <div class="mb-page">
      <div class="vd-head mb-head">
        <div class="mb-head-id">
          <img src="${MB_LOGO}" alt="Martin Brower" class="mb-head-logo" />
          <div class="vd-head-txt">
            <h2>Martin Brower <span class="pill ${STATUS_PORTAL.carregando.classe}" id="mb-status">${STATUS_PORTAL.carregando.label}</span></h2>
            <p>Área de acesso ao portal oficial da distribuidora — consulte pedidos, notas e catálogo sem sair do Subway Saci.</p>
          </div>
        </div>
        <div class="mb-head-acoes">
          <button class="btn btn-ghost" id="mb-recarregar">🔄 Atualizar Portal</button>
          <button class="btn btn-primary" id="mb-nova-guia">↗ Abrir em Nova Guia</button>
        </div>
      </div>

      <div class="mb-frame-card">
        <div class="mb-corpo" id="mb-corpo">
          <iframe id="mb-frame" class="mb-frame" src="${MB_PORTAL_URL}" title="Portal Martin Brower"
            referrerpolicy="no-referrer" sandbox="allow-scripts allow-forms allow-same-origin allow-popups"></iframe>
        </div>
        <div class="mb-hint" id="mb-hint">
          <span>O conteúdo não apareceu? O portal pode restringir a exibição embutida.</span>
          <button class="mb-hint-btn" id="mb-hint-abrir">Abrir em nova guia ↗</button>
        </div>
      </div>
    </div>`;

  const frame = el("#mb-frame");
  frame.addEventListener("load", () => aoCarregarFrame(frame));
  frame.addEventListener("error", () => setEstado("erro"));
  el("#mb-recarregar").addEventListener("click", recarregarPortal);
  el("#mb-nova-guia").addEventListener("click", abrirEmNovaGuia);
  el("#mb-hint-abrir").addEventListener("click", abrirEmNovaGuia);

  setEstado("carregando");
  armarTimeout();
}
