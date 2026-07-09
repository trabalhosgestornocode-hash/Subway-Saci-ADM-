// Entry-point do painel Subway Saci — amarra estado, dados, navegação e eventos.
import { state } from "./state.js";
import { MENU, SECOES, TABELAS, INTEGRACOES } from "./config.js";
import { el, els } from "./utils.js";
import { carregarCmv } from "./api.js";
import { login, logout, restaurarSessao } from "./auth.js";
import { irPara, renderRotaAtual } from "./router.js";
import { acoes } from "./actions.js";
import { getLinha, contarAlertas } from "./views.js";
import { abrirProdutoModal } from "./produtoModal.js";
import { aplicarTemaSalvo } from "./configuracoes.js";

// ---------- sidebar ----------
function montarMenu() {
  el("#menu").innerHTML = SECOES.map((secao) => {
    const itens = MENU.filter((m) => m.secao === secao);
    if (!itens.length) return "";
    return `<li class="menu-secao">${secao}</li>` + itens.map((m) => {
      const logo = m.integ && INTEGRACOES[m.integ]?.logo;
      const icone = logo ? `<img src="${logo}" alt="" class="m-logo" />` : m.icon;
      return `
      <li data-rota="${m.id}">
        <span class="m-icon">${icone}</span>
        <span class="m-label">${m.label}</span>
        ${m.tipo === "construcao" ? '<span class="m-tag">em breve</span>' : ""}
      </li>`;
    }).join("");
  }).join("");
  els("#menu li[data-rota]").forEach((li) => li.addEventListener("click", () => irPara(li.dataset.rota)));
}

// Relógio em tempo real (topbar)
let relogioIniciado = false;
function iniciarRelogio() {
  if (relogioIniciado) return;
  relogioIniciado = true;
  const upd = () => { const r = el("#relogio"); if (r) r.textContent = new Date().toLocaleTimeString("pt-BR"); };
  upd();
  setInterval(upd, 1000);
}

function setSync(estado, texto) {
  const box = el("#sync-status");
  if (box) box.dataset.estado = estado;
  const t = el("#sync-text");
  if (t) t.textContent = texto;
}

function atualizarNotif() {
  const badge = el("#notif-badge");
  if (!badge) return;
  const n = contarAlertas(state.linhas);
  badge.textContent = n;
  badge.hidden = n === 0;
}

// ---------- filtros globais (canal / tabela) ----------
function popularTabelas() {
  const sel = el("#tabela");
  sel.innerHTML = TABELAS[state.canal].map((t) => `<option>${t}</option>`).join("");
  if (!TABELAS[state.canal].includes(state.tabela)) state.tabela = TABELAS[state.canal][0];
  sel.value = state.tabela;
}

// ---------- carregamento de dados ----------
async function carregar() {
  state.carregando = true;
  state.erro = null;
  setSync("sync", "Sincronizando…");
  el("#btn-refresh")?.classList.add("girando");
  renderRotaAtual();
  try {
    state.linhas = await carregarCmv(state.canal, state.tabela);
    state.atualizadoEm = Date.now();
    setSync("ok", "Sincronizado " + new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }));
  } catch (e) {
    state.erro = e.message;
    state.linhas = [];
    setSync("erro", "Falha na sincronização");
  } finally {
    state.carregando = false;
    el("#btn-refresh")?.classList.remove("girando");
    atualizarNotif();
    renderRotaAtual();
  }
}

// ---------- sessão ----------
function mostrarApp() {
  el("#login-screen").hidden = true;
  el("#app").hidden = false;
  const nome = state.usuario || "usuário";
  el("#user-nome").textContent = nome;
  el("#user-avatar").textContent = (nome[0] || "U").toUpperCase();
  el("#chip-unidade").textContent = "🏪 " + state.unidade;
  montarMenu();
  iniciarRelogio();
  popularTabelas();
  irPara("dashboard");
  carregar();
}

function mostrarLogin() {
  el("#app").hidden = true;
  el("#login-screen").hidden = false;
  el("#login-pass").value = "";
}

// ---------- eventos globais ----------
function wireEventos() {
  el("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const erroBox = el("#login-erro");
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    try {
      erroBox.hidden = true;
      btn?.classList.add("carregando");
      if (btn) btn.disabled = true;
      await login(el("#login-user").value, el("#login-pass").value);
      mostrarApp();
    } catch (err) {
      erroBox.textContent = err.message;
      erroBox.hidden = false;
    } finally {
      btn?.classList.remove("carregando");
      if (btn) btn.disabled = false;
    }
  });

  el("#btn-logout").addEventListener("click", async () => { await logout(); mostrarLogin(); });

  // Sessão expirada / token inválido (disparado pela camada de API ao receber 401)
  document.addEventListener("app:sessao-expirada", async () => { await logout(); mostrarLogin(); });

  // Mostrar/ocultar senha (UI apenas — não altera a lógica de login)
  const toggleSenha = el("#toggle-senha");
  if (toggleSenha) {
    toggleSenha.addEventListener("click", () => {
      const inp = el("#login-pass");
      const mostrar = inp.type === "password";
      inp.type = mostrar ? "text" : "password";
      toggleSenha.classList.toggle("ativo", mostrar);
      toggleSenha.setAttribute("aria-label", mostrar ? "Ocultar senha" : "Mostrar senha");
    });
  }

  el("#canal").addEventListener("change", (e) => { state.canal = e.target.value; popularTabelas(); carregar(); });
  el("#tabela").addEventListener("change", (e) => { state.tabela = e.target.value; carregar(); });

  document.addEventListener("app:reload", carregar);

  // topbar: refresh manual + sino de notificações
  el("#btn-refresh")?.addEventListener("click", carregar);
  el("#btn-notif")?.addEventListener("click", () => irPara("dashboard"));

  // menu mobile
  el("#btn-menu").addEventListener("click", () => el("#app").classList.toggle("menu-aberto"));
  el("#backdrop").addEventListener("click", () => el("#app").classList.remove("menu-aberto"));

  // ações da tabela + clique no nome (delegação — funciona após re-render)
  el("#view").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-acao]");
    if (btn) {
      const row = getLinha(btn.dataset.idx);
      const fn = acoes[btn.dataset.acao];
      if (row && fn) fn(row);
      return;
    }
    const link = e.target.closest(".prod-link");
    if (link) {
      const row = getLinha(link.dataset.idx);
      if (row?.produto_id) abrirProdutoModal(row.produto_id);
    }
  });
}

// ---------- boot ----------
async function boot() {
  aplicarTemaSalvo();
  wireEventos();
  try {
    if (await restaurarSessao()) mostrarApp();
    else mostrarLogin();
  } catch {
    mostrarLogin();
  }
}
boot();
