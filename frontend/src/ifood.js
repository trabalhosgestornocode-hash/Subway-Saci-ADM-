// Página INTEGRAÇÃO IFOOD — Fase 1: conexão da unidade, fluxo OAuth
// distribuído (2 etapas), descoberta de merchant e status.
//
// Não usa iframe (diferente da aba Martin Brower). Não guarda NADA em
// localStorage — o sessionId do fluxo OAuth vive só em `estado.wizard` (memória
// do módulo) e some ao trocar de contexto. Nenhum token/secret/verifier chega
// aqui: o backend só devolve userCode + URLs + prazo, e status sanitizado.
//
// As DECISÕES (estado visual, seleção de merchant, contador, confirmação de
// troca) ficam em ifoodEstado.js (puro, testado). Aqui é só DOM + orquestração.

import { el, fmtDataHora, toast, escapeHtml as esc } from "./utils.js";
import * as api from "./api.js";
import { registrarResetDeContexto } from "./contextoEscopo.js";
import {
  APP_ROTULO, derivarEstadoIntegracao, prepararSelecaoMerchant, contadorExpiracao,
  precisaConfirmarTrocaMerchant, textoConfirmacaoTroca, mensagemErroAutorizacao, avisoDesconexao,
} from "./ifoodEstado.js";

const IFOOD_LOGO = "/assets/menu-dashboard-ifood.png";

const estado = {
  status: null,
  carregando: false,
  wizard: null,   // { etapa, appType, sessionId, userCode, verificationUrlComplete, expiraEm, timer, feito:{analytics,financial}, selecao }
};

// Fase F (auditoria de troca de contexto): trocar de unidade pelo seletor
// global não passa por renderIfood() se o usuário está em outra tela. Sem
// isto, um contador (setInterval) da unidade A seguiria rodando sobre o
// contexto da unidade B.
registrarResetDeContexto(() => {
  pararContador();
  estado.status = null;
  estado.wizard = null;
});

// ---------------------------------------------------------------------------
// Contador de expiração do userCode
// ---------------------------------------------------------------------------
function pararContador() {
  if (estado.wizard?.timer) { clearInterval(estado.wizard.timer); estado.wizard.timer = null; }
}

function armarContador() {
  pararContador();
  atualizarContador();
  estado.wizard.timer = setInterval(atualizarContador, 1000);
}

function atualizarContador() {
  const w = estado.wizard;
  if (!w?.expiraEm) return;
  const c = contadorExpiracao(w.expiraEm);
  const alvo = el("#ifood-contador");
  if (alvo) { alvo.textContent = c.rotulo; alvo.classList.toggle("ifood-expirado", c.expirado); }
  const concluir = el("#ifood-concluir");
  if (concluir) concluir.disabled = c.expirado;
  const regen = el("#ifood-regenerar");
  if (regen) regen.hidden = !c.expirado;
  if (c.expirado) pararContador();
}

// ---------------------------------------------------------------------------
// Carga de status
// ---------------------------------------------------------------------------
async function carregarStatus() {
  estado.carregando = true;
  try {
    const { data } = await api.ifoodStatus();
    estado.status = data;
  } catch (e) {
    estado.status = null;
    toast(e.message || "Não foi possível carregar o status da integração iFood.");
  } finally {
    estado.carregando = false;
  }
  pintarPainel();
}

// ---------------------------------------------------------------------------
// Painel de status
// ---------------------------------------------------------------------------
function linhaApp(rotulo, appEstado) {
  return `
    <div class="ifood-app-linha">
      <span class="ifood-app-nome">${esc(rotulo)}</span>
      <span class="pill ${appEstado.classe}">${esc(appEstado.rotulo)}</span>
    </div>`;
}

function blocoMerchant(merchant) {
  if (!merchant) return `<div class="ifood-merchant vazio">Nenhuma loja iFood vinculada</div>`;
  return `
    <div class="ifood-merchant">
      <div class="ifood-merchant-nome">${esc(merchant.nome || "—")}</div>
      <div class="ifood-merchant-meta">Razão social: ${esc(merchant.razaoSocial || "—")}</div>
      <div class="ifood-merchant-meta">Merchant: <span class="mono">${esc(merchant.idMascarado || "—")}</span></div>
    </div>`;
}

function pintarPainel() {
  const view = el("#view");
  if (!view) return;
  pararContador();
  estado.wizard = null;

  const e = derivarEstadoIntegracao(estado.status);
  const acoes = [];
  if (e.podeConectarAnalytics || e.podeConectarFinancial) {
    acoes.push(`<button class="btn btn-primary" id="ifood-conectar">${e.chave === "nao_conectado" ? "Conectar iFood" : "Continuar conexão"}</button>`);
  }
  if (e.precisaReconectar) {
    acoes.push(`<button class="btn btn-primary" id="ifood-reconectar">Reconectar</button>`);
  }
  if (e.podeDesconectar) {
    acoes.push(`<button class="btn btn-ghost" id="ifood-desconectar">Desconectar</button>`);
  }

  view.innerHTML = `
    <div class="ifood-page">
      <div class="vd-head ifood-head">
        <div class="ifood-head-id">
          <img src="${IFOOD_LOGO}" alt="iFood" class="ifood-head-logo" />
          <div class="vd-head-txt">
            <h2>Integração iFood <span class="pill ${e.classe}" id="ifood-status-pill">${esc(e.rotulo)}</span></h2>
            <p>Conecte esta unidade ao iFood para, no futuro, sincronizar dados de desempenho e financeiro. Nesta fase só a conexão e a identificação da loja são feitas.</p>
          </div>
        </div>
      </div>

      <div class="ifood-card">
        <div class="ifood-apps">
          ${linhaApp(APP_ROTULO.analytics, e.apps.analytics)}
          ${linhaApp(APP_ROTULO.financial, e.apps.financial)}
        </div>
        <div class="ifood-secao-rotulo">Loja iFood vinculada</div>
        ${blocoMerchant(e.merchant)}
        ${estado.status?.ultimoErro ? `<div class="ifood-aviso bad">${esc(estado.status.ultimoErro)}</div>` : ""}
        <div class="ifood-info-linha">
          <span>Conectada em</span><strong>${e.conectadaEm ? fmtDataHora(e.conectadaEm) : "—"}</strong>
        </div>
        <div class="ifood-info-linha">
          <span>Última atualização</span><strong>Ainda não sincronizado</strong>
        </div>
        <div class="ifood-acoes">${acoes.join("") || '<span class="ifood-tudo-ok">Integração conectada. Sincronização de dados chega em uma próxima fase.</span>'}</div>
      </div>
    </div>`;

  el("#ifood-conectar")?.addEventListener("click", () => abrirWizard("auto"));
  el("#ifood-reconectar")?.addEventListener("click", () => abrirWizard("reauth"));
  el("#ifood-desconectar")?.addEventListener("click", desconectar);
}

// ---------------------------------------------------------------------------
// Assistente (wizard) de conexão
// ---------------------------------------------------------------------------
function primeiraEtapaPendente(modo) {
  const e = derivarEstadoIntegracao(estado.status);
  if (modo === "reauth") {
    return e.apps.financial.classe === "bad" ? "financial" : "analytics";
  }
  if (e.podeConectarAnalytics) return "analytics";
  if (e.podeConectarFinancial) return "financial";
  return "financial";
}

function abrirWizard(modo) {
  estado.wizard = { etapa: primeiraEtapaPendente(modo), appType: null, sessionId: null, feito: {}, selecao: null };
  pintarWizard();
}

function sairDoWizard() {
  pararContador();
  estado.wizard = null;
  carregarStatus();
}

function cabecalhoWizard(tituloEtapa, passo) {
  return `
    <div class="vd-head ifood-head">
      <div class="vd-head-txt">
        <h2>Conectar iFood <span class="ifood-passo">Etapa ${passo} de 2</span></h2>
        <p>${esc(tituloEtapa)}</p>
      </div>
      <button class="btn btn-ghost" id="ifood-wizard-sair">Voltar ao status</button>
    </div>`;
}

function pintarWizard() {
  const view = el("#view");
  const w = estado.wizard;
  if (!view || !w) return;
  pararContador();

  if (w.etapa === "analytics") return pintarEtapaOAuth("analytics", 1, "Dados de desempenho — autorize o aplicativo de Analytics.");
  if (w.etapa === "financial") return pintarEtapaOAuth("financial", 2, "Dados financeiros — autorize o aplicativo Financial + Merchant.");
  if (w.etapa === "merchant") return pintarEtapaMerchant();
}

function pintarEtapaOAuth(appType, passo, subtitulo) {
  const view = el("#view");
  const w = estado.wizard;
  const temCodigo = w.appType === appType && w.sessionId;

  view.innerHTML = `
    <div class="ifood-page">
      ${cabecalhoWizard(subtitulo, passo)}
      <div class="ifood-card">
        ${w.feito.analytics && appType === "financial" ? `<div class="ifood-aviso ok">Desempenho / Analytics autorizado ✓</div>` : ""}
        ${!temCodigo ? `
          <p>Gere um código de vínculo e autorize o aplicativo no Portal do Parceiro iFood.</p>
          <button class="btn btn-primary" id="ifood-gerar">Gerar código</button>
        ` : `
          <div class="ifood-codigo-box">
            <div class="ifood-codigo-rotulo">Código de vínculo</div>
            <div class="ifood-codigo">${esc(w.userCode)}</div>
            <div class="ifood-codigo-exp">Expira em <span id="ifood-contador">--:--</span></div>
          </div>
          <a class="btn btn-primary" id="ifood-abrir-portal" href="${esc(w.verificationUrlComplete || "#")}" target="_blank" rel="noopener">Abrir Portal do iFood ↗</a>
          <p class="ifood-instrucao">Autorize o aplicativo no Portal do Parceiro e depois cole aqui o <strong>código de autorização</strong> que o iFood fornecer.</p>
          <label class="ifood-label" for="ifood-authcode">Código de autorização</label>
          <input type="text" id="ifood-authcode" class="ifood-input" autocomplete="off" spellcheck="false" placeholder="Cole o código do iFood" />
          <div class="ifood-acoes">
            <button class="btn btn-primary" id="ifood-concluir">Concluir autorização</button>
            <button class="btn btn-ghost" id="ifood-regenerar" hidden>Gerar novo código</button>
            ${appType === "analytics" ? `<button class="btn btn-ghost" id="ifood-pular">Pular por enquanto</button>` : ""}
          </div>
        `}
        <div class="ifood-msg" id="ifood-msg"></div>
      </div>
    </div>`;

  el("#ifood-wizard-sair")?.addEventListener("click", sairDoWizard);
  el("#ifood-gerar")?.addEventListener("click", () => gerarCodigo(appType));
  el("#ifood-regenerar")?.addEventListener("click", () => gerarCodigo(appType));
  el("#ifood-concluir")?.addEventListener("click", () => concluirAutorizacao(appType));
  el("#ifood-pular")?.addEventListener("click", () => { estado.wizard.etapa = "financial"; estado.wizard.appType = null; estado.wizard.sessionId = null; pintarWizard(); });
  if (temCodigo) armarContador();
}

async function gerarCodigo(appType) {
  const btn = el("#ifood-gerar") || el("#ifood-regenerar");
  if (btn) btn.disabled = true;
  try {
    const { data } = await api.ifoodOauthStart(appType);
    estado.wizard.appType = appType;
    estado.wizard.sessionId = data.sessionId;
    estado.wizard.userCode = data.userCode;
    estado.wizard.verificationUrlComplete = data.verificationUrlComplete || data.verificationUrl || null;
    estado.wizard.expiraEm = data.expiraEm;
    pintarWizard();
  } catch (e) {
    if (btn) btn.disabled = false;
    mostrarMsg(mensagemErroAutorizacao(e), "bad");
  }
}

async function concluirAutorizacao(appType) {
  const code = (el("#ifood-authcode")?.value || "").trim();
  if (!code) return mostrarMsg("Cole o código de autorização fornecido pelo iFood.", "bad");
  const btn = el("#ifood-concluir");
  if (btn) btn.disabled = true;
  try {
    await api.ifoodOauthComplete(appType, estado.wizard.sessionId, code);
    estado.wizard.feito[appType] = true;
    pararContador();
    if (appType === "analytics") {
      estado.wizard.etapa = "financial";
      estado.wizard.appType = null; estado.wizard.sessionId = null;
      pintarWizard();
    } else {
      estado.wizard.etapa = "merchant";
      await carregarStatusSilencioso();
      pintarWizard();
    }
  } catch (e) {
    if (btn) btn.disabled = false;
    mostrarMsg(mensagemErroAutorizacao(e), "bad");
    if (e?.codigo === "IFOOD_OAUTH_SESSAO_EXPIRADA") { const r = el("#ifood-regenerar"); if (r) r.hidden = false; }
  }
}

// ---------------------------------------------------------------------------
// Etapa de seleção de merchant
// ---------------------------------------------------------------------------
async function pintarEtapaMerchant() {
  const view = el("#view");
  view.innerHTML = `
    <div class="ifood-page">
      ${cabecalhoWizard("Loja do iFood — identifique a loja desta unidade.", 2)}
      <div class="ifood-card"><div class="ifood-msg">Buscando lojas autorizadas…</div></div>
    </div>`;
  el("#ifood-wizard-sair")?.addEventListener("click", sairDoWizard);

  let sel;
  try {
    const { data } = await api.ifoodMerchants();
    sel = prepararSelecaoMerchant(data?.merchants);
    if (data?.truncado) sel.mensagem += " (lista muito grande — mostrando as primeiras lojas encontradas)";
  } catch (e) {
    return renderMerchantErro(e.message || "Não foi possível listar as lojas do iFood.");
  }
  estado.wizard.selecao = sel;

  const card = el(".ifood-card");
  if (!card) return;

  if (sel.modo === "vazio") {
    card.innerHTML = `
      <div class="ifood-aviso warn">${esc(sel.mensagem)}</div>
      <div class="ifood-acoes">
        <button class="btn btn-ghost" id="ifood-merchant-retry">Tentar de novo</button>
        <button class="btn btn-primary" id="ifood-merchant-depois">Concluir sem vincular loja</button>
      </div>`;
    el("#ifood-merchant-retry")?.addEventListener("click", pintarEtapaMerchant);
    el("#ifood-merchant-depois")?.addEventListener("click", sairDoWizard);
    return;
  }

  const itens = sel.merchants.map((m, i) => `
    <label class="ifood-merchant-opcao">
      <input type="radio" name="ifood-merchant" value="${i}" ${sel.modo === "unico" || i === 0 ? "checked" : ""} />
      <span>
        <strong>${esc(m.nome || "(sem nome)")}</strong>
        <span class="ifood-merchant-meta">Razão social: ${esc(m.razaoSocial || "—")}</span>
        <span class="ifood-merchant-meta">Merchant: <span class="mono">${esc(m.idMascarado || "—")}</span></span>
      </span>
    </label>`).join("");

  card.innerHTML = `
    <p>${esc(sel.mensagem)}</p>
    <div class="ifood-merchant-lista">${itens}</div>
    <div class="ifood-acoes">
      <button class="btn btn-primary" id="ifood-vincular">${sel.modo === "unico" ? "Vincular a esta unidade" : "Vincular loja selecionada"}</button>
      <button class="btn btn-ghost" id="ifood-merchant-depois">Vincular depois</button>
    </div>
    <div class="ifood-msg" id="ifood-msg"></div>`;
  el("#ifood-vincular")?.addEventListener("click", vincularSelecionado);
  el("#ifood-merchant-depois")?.addEventListener("click", sairDoWizard);
}

function renderMerchantErro(msg) {
  const card = el(".ifood-card");
  if (!card) return;
  card.innerHTML = `
    <div class="ifood-aviso bad">${esc(msg)}</div>
    <div class="ifood-acoes">
      <button class="btn btn-ghost" id="ifood-merchant-retry">Tentar de novo</button>
      <button class="btn btn-primary" id="ifood-merchant-depois">Concluir sem vincular loja</button>
    </div>`;
  el("#ifood-merchant-retry")?.addEventListener("click", pintarEtapaMerchant);
  el("#ifood-merchant-depois")?.addEventListener("click", sairDoWizard);
}

async function vincularSelecionado() {
  const sel = estado.wizard?.selecao;
  if (!sel?.merchants?.length) return;
  const idx = Number(el('input[name="ifood-merchant"]:checked')?.value ?? 0);
  const escolhido = sel.merchants[idx];
  if (!escolhido) return;

  // Troca de merchant na mesma unidade: confirmação EXPLÍCITA. Mesmo merchant
  // (idempotente) ou nenhum vinculado -> segue direto.
  if (precisaConfirmarTrocaMerchant(estado.status, escolhido)
      && !window.confirm(textoConfirmacaoTroca(estado.status, escolhido))) {
    return;
  }

  const btn = el("#ifood-vincular");
  if (btn) btn.disabled = true;
  mostrarMsg("Validando a loja no iFood…");
  try {
    const { data } = await api.ifoodVincularMerchant(escolhido.id);
    estado.status = data;
    toast("Loja vinculada à unidade.");
    sairDoWizard();
  } catch (e) {
    if (btn) btn.disabled = false;
    mostrarMsg(e.message || "Não foi possível vincular a loja.", "bad");
  }
}

// ---------------------------------------------------------------------------
// Desconexão local
// ---------------------------------------------------------------------------
async function desconectar() {
  if (!window.confirm(`${avisoDesconexao()}\n\nDesconectar agora?`)) return;
  const btn = el("#ifood-desconectar");
  if (btn) btn.disabled = true;
  try {
    await api.ifoodDesconectar();
    toast("Integração iFood desconectada localmente. Para revogação total, remova o acesso também no Portal do Parceiro iFood.");
  } catch (e) {
    toast(e.message || "Não foi possível desconectar.");
  }
  carregarStatus();
}

// ---------------------------------------------------------------------------
// helpers de UI
// ---------------------------------------------------------------------------
function mostrarMsg(texto, classe = "") {
  const alvo = el("#ifood-msg");
  if (alvo) { alvo.textContent = texto; alvo.className = `ifood-msg ${classe}`; }
}

async function carregarStatusSilencioso() {
  try { const { data } = await api.ifoodStatus(); estado.status = data; } catch { /* mantém o anterior */ }
}

// ---------------------------------------------------------------------------
export function renderIfood() {
  pararContador();
  estado.wizard = null;
  const view = el("#view");
  if (view) view.innerHTML = `<div class="ifood-page"><div class="ifood-card"><div class="ifood-msg">Carregando integração iFood…</div></div></div>`;
  carregarStatus();
}
