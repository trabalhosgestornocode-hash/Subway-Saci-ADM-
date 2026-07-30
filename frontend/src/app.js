// Entry-point da plataforma — amarra estado, sessão, navegação e eventos.
//
// O boot agora tem QUATRO telas possíveis, e a decisão entre elas é o coração
// do fluxo novo:
//
//   login    -> não autenticado
//   selecao  -> autenticado, com 2+ acessos e sem contexto escolhido
//   app      -> autenticado com contexto (tenant)
//   admin    -> autenticado como SuperAdmin da plataforma
//
// Regra que resolve os casos de borda: com UM único acesso, entra direto (não
// faz sentido pedir para escolher entre uma opção). Sem nenhum acesso e sem ser
// superadmin, a tela de seleção explica a situação em vez de mostrar uma lista
// vazia sem contexto.

import { state } from "./state.js";
import { MENU, SECOES, TABELAS, INTEGRACOES } from "./config.js";
import { el, els, escapeHtml, toast } from "./utils.js";
import { carregarCmv } from "./api.js";
import {
  login, logout, restaurarSessao, listarAcessos, selecionarContexto,
  restaurarContexto, encerrarContexto, aplicarContexto,
  precisaDefinirSenha, definirNovaSenha,
} from "./sessao.js";
import { irPara, renderRotaAtual } from "./router.js";
import { acoes } from "./actions.js";
import { getLinha, contarAlertas } from "./views.js";
import { abrirProdutoModal } from "./produtoModal.js";
import { aplicarTemaSalvo } from "./configuracoes.js";
import { abrirPainelAdmin, fecharPainelAdmin } from "./admin.js";

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

// ---------- troca de telas ----------
const TELAS = { login: "#login-screen", senha: "#senha-screen", selecao: "#selecao-screen", app: "#app", admin: "#admin" };

/** Mostra uma tela e esconde as outras. Estado de tela é exclusivo por design. */
function mostrarTela(qual) {
  for (const [nome, sel] of Object.entries(TELAS)) {
    const nodo = el(sel);
    if (nodo) nodo.hidden = nome !== qual;
  }
  fecharMenusUsuario();
  if (qual !== "admin") fecharPainelAdmin();
}

// ---------- tela: app (tenant) ----------
function mostrarApp() {
  const { usuario, empresa, unidade, papelRotulo, impersonando } = state.sessao;
  const nome = usuario?.nome || usuario?.email || "usuário";

  // Espelhos de compatibilidade para as views que ainda leem state.usuario.
  state.usuario = usuario?.email ?? nome;
  state.unidade = unidade?.nome || empresa?.nome || "—";

  mostrarTela("app");
  el("#user-nome").textContent = nome;
  el("#user-avatar").textContent = (nome[0] || "U").toUpperCase();
  el("#user-empresa").textContent = unidade?.nome ? `${empresa?.nome} · ${unidade.nome}` : (empresa?.nome ?? "—");
  el("#chip-unidade").textContent = "🏪 " + state.unidade;
  el("#um-nome").textContent = nome;
  el("#um-email").textContent = usuario?.email ?? "—";
  el("#um-papel").textContent = impersonando ? "SuperAdmin (suporte)" : (papelRotulo ?? "—");
  // "Painel SuperAdmin" só aparece para quem é superadmin — inclusive durante
  // uma impersonação, que é justamente quando o caminho de volta importa.
  el("#um-painel").hidden = !state.sessao.superadmin;
  // Trocar de unidade não faz sentido dentro de uma impersonação: o contexto
  // não veio de um vínculo do usuário, veio de um acesso de suporte.
  el("#um-trocar").hidden = !!impersonando;

  const barra = el("#imp-barra");
  barra.hidden = !impersonando;
  if (impersonando) el("#imp-empresa").textContent = empresa?.nome ?? "—";

  montarMenu();
  iniciarRelogio();
  popularTabelas();
  irPara("dashboard");
  carregar();
}

// ---------- tela: seleção de unidade ----------
/** @param {{opcoes: Array<object>, superadmin: boolean}} dados */
function mostrarSelecao(dados) {
  mostrarTela("selecao");
  const nome = state.sessao.usuario?.nome || state.sessao.usuario?.email || "—";
  el("#sel-nome").textContent = nome;
  el("#sel-erro").hidden = true;
  el("#sel-admin").hidden = !dados.superadmin;

  const lista = el("#sel-lista");

  if (!dados.opcoes.length) {
    // Depois da virada de acessos, este é o estado normal de uma conta nova:
    // existe, autentica, e ainda não foi associada a nenhuma empresa. Dizer
    // isso é melhor que mostrar uma lista vazia sem explicação.
    lista.innerHTML = `
      <div class="sel-vazio">
        <span class="sel-vazio-ic">🔒</span>
        <h3>Nenhuma empresa vinculada à sua conta</h3>
        <p>${dados.superadmin
          ? "Como SuperAdmin, você administra a plataforma pelo painel — e pode associar acessos por lá."
          : "Seu acesso precisa ser liberado pelo administrador da plataforma. Fale com o responsável para ser associado a uma empresa."}</p>
      </div>`;
    return;
  }

  lista.innerHTML = dados.opcoes.map((o, i) => {
    const sub = o.unidadeNome ? `${o.unidadeNome} · ${o.papelRotulo}` : o.papelRotulo;
    const logo = o.logoUrl
      ? `<img src="${escapeHtml(o.logoUrl)}" alt="" class="sel-logo" />`
      : `<span class="sel-logo sel-logo--txt">${escapeHtml((o.empresaNome[0] || "?").toUpperCase())}</span>`;
    return `
      <div class="sel-item ${o.acessivel ? "" : "sel-item--off"}" role="listitem">
        ${logo}
        <div class="sel-item-info">
          <b>${escapeHtml(o.empresaNome)}</b>
          <small>${escapeHtml(sub)}</small>
          ${o.acessivel ? "" : `<span class="pill bad">${escapeHtml(o.motivo ?? "Indisponível")}</span>`}
        </div>
        <button class="btn ${o.acessivel ? "btn-primary" : "btn-ghost"} btn-sm sel-btn"
                data-idx="${i}" ${o.acessivel ? "" : "disabled"}>
          ${o.acessivel ? "Acessar" : "Bloqueada"}
        </button>
      </div>`;
  }).join("");

  els(".sel-btn", lista).forEach((b) => b.addEventListener("click", () => {
    entrarNoContexto(dados.opcoes[Number(b.dataset.idx)], b);
  }));
}

/** @param {object} opcao @param {HTMLButtonElement} [botao] */
async function entrarNoContexto(opcao, botao) {
  if (!opcao?.acessivel) return;
  const erroBox = el("#sel-erro");
  erroBox.hidden = true;
  if (botao) { botao.disabled = true; botao.textContent = "Entrando…"; }
  try {
    await selecionarContexto({
      organizacaoId: opcao.organizacaoId,
      unidadeId: opcao.unidadeId ?? null,
      troca: true,
    });
    mostrarApp();
  } catch (e) {
    erroBox.textContent = e.message;
    erroBox.hidden = false;
    if (botao) { botao.disabled = false; botao.textContent = "Acessar"; }
  }
}

// ---------- tela: login ----------
function mostrarLogin() {
  mostrarTela("login");
  el("#login-pass").value = "";
}

// ---------- tela: definir senha (primeiro acesso) ----------
function mostrarSenha() {
  mostrarTela("senha");
  const nome = state.sessao.usuario?.nome || state.sessao.usuario?.email || "—";
  el("#senha-nome").textContent = nome;
  el("#senha-nova").value = "";
  el("#senha-conf").value = "";
  el("#senha-erro").hidden = true;
  avaliarRequisitosSenha();
  el("#senha-nova").focus();
}

function mostrarErroSenha(msg) {
  const box = el("#senha-erro");
  box.textContent = msg;
  box.hidden = false;
}

/** Marca cada requisito como cumprido enquanto o usuário digita. */
function avaliarRequisitosSenha() {
  const s = el("#senha-nova")?.value ?? "";
  const c = el("#senha-conf")?.value ?? "";
  const regras = {
    tam: s.length >= 8,
    letra: /[a-zA-Z]/.test(s),
    numero: /\d/.test(s),
    igual: s.length > 0 && s === c,
  };
  for (const [chave, ok] of Object.entries(regras)) {
    el(`#senha-reqs li[data-req="${chave}"]`)?.classList.toggle("ok", ok);
  }
  return Object.values(regras).every(Boolean);
}

// ---------- roteador de sessão ----------
/**
 * Decide para qual tela ir depois de autenticar. É o ÚNICO lugar que toma essa
 * decisão — espalhá-la é o que tornaria o fluxo imprevisível.
 * @param {{preferirAdmin?: boolean}} [opcoes]
 */
async function encaminhar({ preferirAdmin = false } = {}) {
  state.sessao.superadmin = !!state.sessao.usuario?.superadmin;

  // Senha provisória vem ANTES de tudo: enquanto não for trocada, o backend
  // bloqueia a API inteira, então nem adianta tentar restaurar contexto ou
  // listar acessos. Vale para todos, inclusive o SuperAdmin.
  if (precisaDefinirSenha()) {
    mostrarSenha();
    return;
  }

  // Contexto ainda válido (recarregou a página) — volta direto para o trabalho.
  if (!preferirAdmin && await restaurarContexto()) {
    mostrarApp();
    return;
  }

  const dados = await listarAcessos();

  // SuperAdmin sem vínculo nenhum é o caso esperado: o painel é a casa dele.
  if (dados.superadmin && (preferirAdmin || !dados.opcoes.length)) {
    abrirPainelAdmin({
      mostrarTela,
      aoEntrarEmEmpresa: entrarPorImpersonacao,
      aoSair: sairDeTudo,
      usuario: state.sessao.usuario,
    });
    return;
  }

  // Um único acesso: entra direto, sem pedir para escolher entre uma opção.
  const acessiveis = dados.opcoes.filter((o) => o.acessivel);
  if (acessiveis.length === 1 && !dados.superadmin) {
    try {
      await selecionarContexto({
        organizacaoId: acessiveis[0].organizacaoId,
        unidadeId: acessiveis[0].unidadeId ?? null,
      });
      mostrarApp();
      return;
    } catch {
      // Se a entrada automática falhar, cai na seleção, que mostra o motivo.
    }
  }

  mostrarSelecao(dados);
}

/** Recebe o contexto de impersonação vindo do painel e entra no shell tenant. */
function entrarPorImpersonacao(contexto) {
  aplicarContexto(contexto);
  mostrarApp();
  toast(`Você entrou em ${contexto.empresa?.nome ?? "a empresa"} como SuperAdmin.`);
}

async function sairDeTudo() {
  await logout();
  mostrarLogin();
}

// ---------- menus de usuário ----------
function fecharMenusUsuario() {
  for (const [chip, menu] of [["#user-chip", "#user-menu"], ["#adm-user-chip", "#adm-user-menu"]]) {
    const m = el(menu);
    if (m) m.hidden = true;
    el(chip)?.setAttribute("aria-expanded", "false");
  }
}

function ligarMenuUsuario(chipSel, menuSel) {
  const chip = el(chipSel);
  const menu = el(menuSel);
  if (!chip || !menu) return;
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    const abrir = menu.hidden;
    fecharMenusUsuario();
    menu.hidden = !abrir;
    chip.setAttribute("aria-expanded", String(abrir));
  });
  menu.addEventListener("click", (e) => e.stopPropagation());
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
      await encaminhar();
    } catch (err) {
      erroBox.textContent = err.message;
      erroBox.hidden = false;
    } finally {
      btn?.classList.remove("carregando");
      if (btn) btn.disabled = false;
    }
  });

  el("#btn-logout").addEventListener("click", sairDeTudo);
  el("#adm-logout").addEventListener("click", sairDeTudo);
  el("#sel-sair").addEventListener("click", sairDeTudo);
  el("#senha-sair").addEventListener("click", sairDeTudo);

  // Definir senha (primeiro acesso): valida, envia, e segue o fluxo normal.
  ["#senha-nova", "#senha-conf"].forEach((sel) =>
    el(sel).addEventListener("input", avaliarRequisitosSenha));

  el("#senha-olho").addEventListener("click", () => {
    const inp = el("#senha-nova");
    const mostrar = inp.type === "password";
    inp.type = mostrar ? "text" : "password";
    el("#senha-olho").classList.toggle("ativo", mostrar);
    el("#senha-olho").setAttribute("aria-label", mostrar ? "Ocultar senha" : "Mostrar senha");
  });

  el("#senha-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const erroBox = el("#senha-erro");
    const btn = el("#senha-btn");
    erroBox.hidden = true;

    const nova = el("#senha-nova").value;
    const conf = el("#senha-conf").value;
    // Barreira local antes de bater no servidor — o backend revalida de todo jeito.
    if (nova.length < 8) return mostrarErroSenha("A senha deve ter ao menos 8 caracteres.");
    if (nova !== conf) return mostrarErroSenha("As senhas não coincidem.");

    try {
      btn.classList.add("carregando");
      btn.disabled = true;
      await definirNovaSenha(nova);
      toast("Senha definida. Bem-vindo!");
      await encaminhar();   // a flag caiu → segue para seleção/painel/app
    } catch (err) {
      mostrarErroSenha(err.message);
    } finally {
      btn.classList.remove("carregando");
      btn.disabled = false;
    }
  });

  // Trocar unidade: encerra só o CONTEXTO e volta para a seleção. O login
  // continua de pé — é exatamente a diferença entre trocar de unidade e sair.
  el("#um-trocar").addEventListener("click", async () => {
    fecharMenusUsuario();
    await encerrarContexto();
    await encaminhar();
  });

  el("#um-conta").addEventListener("click", () => {
    fecharMenusUsuario();
    irPara("configuracoes");
  });

  el("#um-painel").addEventListener("click", async () => {
    fecharMenusUsuario();
    await encaminhar({ preferirAdmin: true });
  });

  el("#sel-admin").addEventListener("click", () => encaminhar({ preferirAdmin: true }));

  el("#adm-um-empresas").addEventListener("click", async () => {
    fecharMenusUsuario();
    await encerrarContexto();
    mostrarSelecao(await listarAcessos());
  });

  // Sair da empresa (fim da impersonação) — volta ao painel da plataforma.
  el("#imp-sair").addEventListener("click", async () => {
    await encerrarContexto();
    await encaminhar({ preferirAdmin: true });
    toast("Você saiu da empresa e voltou ao painel da plataforma.");
  });

  ligarMenuUsuario("#user-chip", "#user-menu");
  ligarMenuUsuario("#adm-user-chip", "#adm-user-menu");
  document.addEventListener("click", fecharMenusUsuario);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharMenusUsuario(); });

  // Sessão expirada (401): o login caiu, volta para o login.
  document.addEventListener("app:sessao-expirada", async () => { await logout(); mostrarLogin(); });

  // Contexto inválido (409): o login está bom, só o contexto caiu. Volta para
  // a seleção — expulsar o usuário do sistema aqui seria desproporcional.
  document.addEventListener("app:contexto-invalido", async (e) => {
    toast(e.detail || "Contexto encerrado. Escolha a unidade novamente.");
    try { await encaminhar(); } catch { mostrarLogin(); }
  });

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
    if (await restaurarSessao()) await encaminhar();
    else mostrarLogin();
  } catch {
    mostrarLogin();
  }
}
boot();
