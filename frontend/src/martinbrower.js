// Aba MARTIN BROWER — portal da distribuidora + painel de integração.
//
// O portal oficial continua embutido via iframe, com os mesmos estados de
// carregando / carregado / erro / bloqueado — nada disso foi alterado.
// ACIMA dele entra o painel da integração: status, catálogo sincronizado,
// alterações de preço, vínculos e histórico.
//
// A sincronização AUTOMATIZADA (login + 2FA via worker) depende de
// MB_PLAYWRIGHT_ENABLED no backend. Enquanto estiver desligada, o formulário
// de usuário/senha NÃO é exibido e nenhuma credencial é aceita — o que existe
// é a importação manual do JSON, ferramenta temporária de validação.
import { el, els, fmtMoeda, fmtDataHora, fmtRelativo, fmtTexto } from "./utils.js";
import * as api from "./api.js";

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

// =====================================================================
// PAINEL DE INTEGRAÇÃO
// =====================================================================

// Estados visuais da integração -> rótulo e classe da pílula.
const ESTADOS_INTEGRACAO = {
  nao_configurado:      { classe: "warn", label: "Não configurado" },
  pronto:               { classe: "ok",   label: "Pronto para sincronizar" },
  autenticando:         { classe: "info", label: "Autenticando" },
  aguardando_codigo:    { classe: "warn", label: "Aguardando código de segurança" },
  identificando_unidade:{ classe: "info", label: "Identificando unidade" },
  identificando_pedido: { classe: "info", label: "Identificando pedido" },
  coletando:            { classe: "info", label: "Coletando produtos" },
  normalizando:         { classe: "info", label: "Processando catálogo" },
  sincronizando:        { classe: "info", label: "Atualizando banco" },
  concluido:            { classe: "ok",   label: "Concluído" },
  erro:                 { classe: "bad",  label: "Erro" },
  expirado:             { classe: "bad",  label: "Sessão expirada" },
  cancelado:            { classe: "warn", label: "Cancelado" },
  restricao_financeira: { classe: "bad",  label: "Restrição financeira" },
};

// Estado do painel (separado do estado do iframe, que continua intocado).
const integ = { config: null, aba: null, dados: null, carregando: false, sessionId: null, polling: null, falhasSeguidas: 0 };

// Falhas CONSECUTIVAS de polling toleradas antes de desistir. Oscilação de
// rede não pode derrubar o acompanhamento de uma sincronização em andamento.
const MAX_FALHAS_POLLING = 3;

const escapar = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function pilulaIntegracao(status) {
  const e = ESTADOS_INTEGRACAO[status] ?? ESTADOS_INTEGRACAO.nao_configurado;
  return `<span class="pill ${e.classe}">${e.label}</span>`;
}

function linhaInfo(rotulo, valor) {
  return `<div class="mb-int-info"><span>${rotulo}</span><strong>${valor}</strong></div>`;
}

function painelIntegracao(c) {
  if (!c) return `<div class="mb-int-card"><div class="mb-int-carregando">Carregando integração…</div></div>`;

  const sinc = c.sincronizacaoEmAndamento;
  const status = sinc?.status ?? c.status;
  // Restrição financeira e erro do último ciclo aparecem como avisos próprios.
  const avisos = [
    c.ultimoErro ? `<div class="mb-int-aviso bad">⚠ ${escapar(c.ultimoErro)}</div>` : "",
    !c.workerHabilitado
      ? `<div class="mb-int-aviso info">A sincronização automática ainda não está habilitada neste ambiente. Use <strong>Importar catálogo (JSON)</strong> para validar o fluxo enquanto isso.</div>`
      : "",
  ].join("");

  return `
    <div class="mb-int-card" id="mb-int">
      <div class="mb-int-topo">
        <div class="mb-int-titulo">
          <h3>Integração de catálogo ${pilulaIntegracao(status)}</h3>
          <p>Sincroniza produtos e preços oficiais pelo código Martin Brower.</p>
        </div>
        <div class="mb-int-acoes">
          ${c.configurada && c.workerHabilitado
            ? `<button class="btn btn-primary" id="mb-sync">⟳ Sincronizar catálogo</button>`
            : `<button class="btn btn-primary" id="mb-sync" disabled title="${c.configurada ? "Worker de sincronização desabilitado neste ambiente" : "Configure o código de cliente primeiro"}">⟳ Sincronizar catálogo</button>`}
          ${sinc ? `<button class="btn btn-ghost" id="mb-cancelar">Cancelar</button>` : ""}
          <button class="btn btn-ghost" id="mb-config">⚙ Configurar</button>
        </div>
      </div>

      <div class="mb-int-grid">
        ${linhaInfo("Unidade conectada", escapar(c.unidadeNome ?? "—"))}
        ${linhaInfo("Código de cliente", escapar(c.clientIdMascarado ?? "—"))}
        ${linhaInfo("Última sincronização", c.ultimaSincronizacao ? `${fmtRelativo(c.ultimaSincronizacao)}` : "Nunca")}
        ${linhaInfo("Último pedido", c.ultimoOrderId ?? "—")}
      </div>
      ${avisos}
      ${sinc ? `<div class="mb-int-progresso"><div class="spinner spinner-sm"></div><span id="mb-etapa">${escapar(sinc.etapa_atual ?? "Iniciando…")}</span></div>` : ""}

      <div class="mb-int-abas" role="tablist">
        <button class="mb-int-aba" data-aba="catalogo">Catálogo</button>
        <button class="mb-int-aba" data-aba="precos">Alterações de preço</button>
        <button class="mb-int-aba" data-aba="vinculos">Produtos sem vínculo</button>
        <button class="mb-int-aba" data-aba="historico">Histórico de sincronizações</button>
        ${!c.workerHabilitado ? `<button class="mb-int-aba" data-aba="importar">Importar catálogo (JSON)</button>` : ""}
      </div>
      <div class="mb-int-conteudo" id="mb-int-conteudo" hidden></div>
    </div>`;
}

// --- conteúdo das abas ---------------------------------------------------

const tabelaVazia = (msg) => `<p class="mb-int-vazio">${msg}</p>`;

function tabelaCatalogo(linhas) {
  if (!linhas?.length) return tabelaVazia("Nenhum produto sincronizado ainda.");
  return `
    <div class="mb-int-tabela-wrap">
      <table class="mb-int-tabela">
        <thead><tr>
          <th>Código</th><th>Descrição</th><th>Grupo</th><th>Un.</th>
          <th class="num">Preço</th><th>Vínculo interno</th><th>Situação</th>
        </tr></thead>
        <tbody>${linhas.map((p) => {
          const vinculo = p.martin_brower_vinculos?.[0]?.insumos?.nome;
          return `<tr class="${p.ignorado ? "mb-int-ignorado" : ""}">
            <td class="mono">${escapar(p.codigo)}</td>
            <td>${escapar(p.descricao)}</td>
            <td>${escapar(p.grupo_descricao ?? "—")}</td>
            <td>${escapar(p.unidade ?? "—")}</td>
            <td class="num">${fmtMoeda(p.preco)}</td>
            <td>${vinculo ? escapar(vinculo) : '<span class="mb-int-sem">sem vínculo</span>'}</td>
            <td>${p.ignorado
              ? `<span class="pill warn" title="${escapar(p.motivo_ignorado ?? "")}">Ignorado</span>`
              : p.visto_na_ultima_sincronizacao === false
                ? `<span class="pill bad">Não veio no último pedido</span>`
                : `<span class="pill ok">Ativo</span>`}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>`;
}

function tabelaPrecos(linhas) {
  if (!linhas?.length) return tabelaVazia("Nenhuma alteração de preço registrada ainda.");
  return `
    <div class="mb-int-tabela-wrap">
      <table class="mb-int-tabela">
        <thead><tr><th>Quando</th><th>Código</th><th class="num">De</th><th class="num">Para</th><th class="num">Variação</th></tr></thead>
        <tbody>${linhas.map((h) => {
          const pct = h.alteracao_percentual;
          const cls = pct == null ? "" : pct > 0 ? "mb-int-alta" : "mb-int-baixa";
          return `<tr>
            <td>${fmtDataHora(h.coletado_em)}</td>
            <td class="mono">${escapar(h.codigo)}</td>
            <td class="num">${fmtMoeda(h.preco_anterior)}</td>
            <td class="num">${fmtMoeda(h.preco_novo)}</td>
            <td class="num ${cls}">${pct == null ? "—" : `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(2)}%`}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>`;
}

function tabelaSemVinculo(linhas) {
  if (!linhas?.length) return tabelaVazia("Todos os produtos do catálogo já têm vínculo interno.");
  return `
    <p class="mb-int-nota">O vínculo usa o código oficial Martin Brower e exige confirmação manual —
      nada é vinculado automaticamente por semelhança de nome.</p>
    <div class="mb-int-tabela-wrap">
      <table class="mb-int-tabela">
        <thead><tr><th>Código</th><th>Descrição</th><th class="num">Preço</th><th>Grupo</th></tr></thead>
        <tbody>${linhas.map((p) => `<tr>
          <td class="mono">${escapar(p.codigo)}</td>
          <td>${escapar(p.descricao)}</td>
          <td class="num">${fmtMoeda(p.preco)}</td>
          <td>${escapar(p.grupo_descricao ?? "—")}</td>
        </tr>`).join("")}</tbody>
      </table>
    </div>`;
}

function tabelaHistoricoSync(linhas) {
  if (!linhas?.length) return tabelaVazia("Nenhuma sincronização executada ainda.");
  return `
    <div class="mb-int-tabela-wrap">
      <table class="mb-int-tabela">
        <thead><tr>
          <th>Início</th><th>Origem</th><th>Pedido</th><th>Status</th>
          <th class="num">Válidos</th><th class="num">Ignorados</th>
          <th class="num">Novos</th><th class="num">Preços</th><th class="num">Erros</th><th>Duração</th>
        </tr></thead>
        <tbody>${linhas.map((s) => {
          const dur = s.finalizado_em && s.iniciado_em
            ? `${Math.round((new Date(s.finalizado_em) - new Date(s.iniciado_em)) / 1000)}s` : "—";
          return `<tr>
            <td>${fmtDataHora(s.iniciado_em)}</td>
            <td>${s.origem === "importacao_manual" ? "Manual" : "Automática"}</td>
            <td>${fmtTexto(s.order_id)}</td>
            <td>${pilulaIntegracao(s.status)}</td>
            <td class="num">${s.produtos_validos}</td>
            <td class="num">${s.produtos_ignorados}</td>
            <td class="num">${s.produtos_criados}</td>
            <td class="num">${s.precos_alterados}</td>
            <td class="num">${s.produtos_com_erro}</td>
            <td>${dur}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>`;
}

// Importação manual — ferramenta TEMPORÁRIA de validação, sem credenciais.
function formularioImportacao() {
  return `
    <p class="mb-int-nota">
      Ferramenta temporária de validação. Abra o portal, faça login normalmente,
      copie a resposta de <code>loadItens</code> e cole aqui. Isso testa normalização,
      filtros, gravação e histórico de preços sem depender do worker automatizado.
      <strong>Não substitui a integração final.</strong>
    </p>
    <textarea id="mb-json" class="mb-int-textarea" rows="8" spellcheck="false"
      placeholder='{ "data": { "groups": [ ... ] } }'></textarea>
    <div class="mb-int-form-acoes">
      <button class="btn btn-primary" id="mb-importar">Processar catálogo</button>
      <span class="mb-int-form-msg" id="mb-import-msg"></span>
    </div>`;
}

function resumoImportacao(r) {
  const item = (rotulo, valor) => `<div class="mb-int-resumo-item"><span>${rotulo}</span><strong>${valor}</strong></div>`;
  return `
    <div class="mb-int-resumo">
      ${item("Encontrados", r.produtosEncontrados)}
      ${item("Válidos", r.produtosValidos)}
      ${item("Ignorados", r.produtosIgnorados)}
      ${item("Novos", r.produtosCriados)}
      ${item("Atualizados", r.produtosAtualizados)}
      ${item("Preços alterados", r.precosAlterados)}
      ${item("Com erro", r.produtosComErro)}
      ${item("Duração", `${(r.duracaoMs / 1000).toFixed(1)}s`)}
      ${item("Pedido", r.orderId ?? "—")}
    </div>`;
}

// --- comportamento do painel ---------------------------------------------

async function carregarIntegracao() {
  try {
    const { data } = await api.mbConfiguracao();
    integ.config = data;
  } catch (e) {
    integ.config = { configurada: false, workerHabilitado: false, status: "erro", ultimoErro: e.message };
  }
  const host = el("#mb-int-host");
  if (!host) return;
  host.innerHTML = painelIntegracao(integ.config);
  ligarPainel();
  if (integ.aba) abrirAba(integ.aba);
}

function ligarPainel() {
  els(".mb-int-aba").forEach((b) => b.addEventListener("click", () => abrirAba(b.dataset.aba)));
  el("#mb-config")?.addEventListener("click", configurarIntegracao);
  el("#mb-sync")?.addEventListener("click", () => {
    // Com o worker desligado o botão está disabled; esta é só a segunda barreira.
    if (!integ.config?.workerHabilitado) return;
    iniciarSincronizacao();
  });
}

async function abrirAba(aba) {
  const alvo = el("#mb-int-conteudo");
  if (!alvo) return;

  // Clicar na aba já aberta fecha o painel.
  if (integ.aba === aba && !alvo.hidden) { alvo.hidden = true; integ.aba = null; els(".mb-int-aba").forEach((b) => b.classList.remove("ativa")); return; }

  integ.aba = aba;
  alvo.hidden = false;
  els(".mb-int-aba").forEach((b) => b.classList.toggle("ativa", b.dataset.aba === aba));

  if (aba === "importar") { alvo.innerHTML = formularioImportacao(); ligarImportacao(); return; }

  alvo.innerHTML = `<div class="mb-int-carregando">Carregando…</div>`;
  try {
    if (aba === "catalogo")   alvo.innerHTML = tabelaCatalogo((await api.mbProdutos({ limite: 500 })).data);
    if (aba === "precos")     alvo.innerHTML = tabelaPrecos((await api.mbHistoricoPrecos({ limite: 200 })).data);
    if (aba === "vinculos")   alvo.innerHTML = tabelaSemVinculo((await api.mbSemVinculo()).data);
    if (aba === "historico")  alvo.innerHTML = tabelaHistoricoSync((await api.mbHistoricoSincronizacoes()).data);
  } catch (e) {
    alvo.innerHTML = `<p class="mb-int-vazio bad">${escapar(e.message)}</p>`;
  }
}

function ligarImportacao() {
  el("#mb-importar")?.addEventListener("click", async () => {
    const campo = el("#mb-json");
    const msg = el("#mb-import-msg");
    const botao = el("#mb-importar");
    let payload;
    try { payload = JSON.parse(campo.value); }
    catch { msg.textContent = "JSON inválido — confira o conteúdo colado."; msg.className = "mb-int-form-msg bad"; return; }

    botao.disabled = true;
    msg.textContent = "Processando…"; msg.className = "mb-int-form-msg";
    try {
      const { data } = await api.mbImportarManual({ payload });
      msg.textContent = "";
      el("#mb-int-conteudo").insertAdjacentHTML("beforeend", resumoImportacao(data));
      campo.value = "";
      await carregarIntegracao();
      abrirAba("historico");
    } catch (e) {
      msg.textContent = e.message; msg.className = "mb-int-form-msg bad";
    } finally {
      botao.disabled = false;
    }
  });
}

async function configurarIntegracao() {
  const atual = integ.config?.clientIdMascarado ?? "";
  const valor = window.prompt(
    `Código de cliente da loja no portal Martin Brower (apenas números).${atual ? `\nAtual: ${atual}` : ""}`, "");
  if (valor === null) return;
  try {
    // STRING, nunca Number: "04532" precisa chegar ao backend com o zero à
    // esquerda intacto (migration 019). O backend valida o formato.
    await api.mbSalvarConfiguracao({ clientId: valor.trim(), unidadeNome: null });
    await carregarIntegracao();
  } catch (e) {
    window.alert(e.message);
  }
}

// Sincronização automatizada — só chega aqui com o worker habilitado.
// O formulário de credenciais é montado sob demanda e o campo de senha
// nunca é persistido (sem autocomplete, sem storage).
async function iniciarSincronizacao() {
  const usuario = window.prompt("Usuário do portal Martin Brower:");
  if (!usuario) return;
  // Nota: a senha é lida por prompt apenas como placeholder da Fase 3; o
  // formulário definitivo, com type=password e autocomplete=off, entra junto
  // com o worker. Nada é guardado no navegador em nenhuma das duas formas.
  const senha = window.prompt("Senha do portal Martin Brower:");
  if (!senha) return;

  try {
    const { data } = await api.mbIniciarSincronizacao({ usuario, senha });
    integ.sessionId = data.sessionId;
    acompanharSincronizacao();
  } catch (e) {
    window.alert(e.message);
  }
}

// Polling do status: mostra o progresso textual real de cada etapa.
function acompanharSincronizacao() {
  clearInterval(integ.polling);
  integ.polling = setInterval(async () => {
    if (!integ.sessionId) { clearInterval(integ.polling); return; }
    try {
      const { data } = await api.mbStatusSessao(integ.sessionId);
      const etapa = el("#mb-etapa");
      if (etapa) etapa.textContent = data.etapa ?? data.status;

      if (data.aguardandoCodigo) {
        clearInterval(integ.polling);
        const codigo = window.prompt("Informe o código de segurança enviado pela Martin Brower:");
        if (!codigo) { await api.mbCancelarSincronizacao(integ.sessionId); integ.sessionId = null; await carregarIntegracao(); return; }
        await api.mbInformarCodigo(integ.sessionId, codigo);
        acompanharSincronizacao();
        return;
      }
      if (["concluido", "erro", "cancelado", "expirado"].includes(data.status)) {
        clearInterval(integ.polling);
        integ.sessionId = null;
        await carregarIntegracao();
        if (data.status === "concluido" && data.resultado) {
          el("#mb-int-conteudo").hidden = false;
          el("#mb-int-conteudo").innerHTML = resumoImportacao(data.resultado);
        }
      }
      integ.falhasSeguidas = 0;
    } catch (e) {
      // ANTES: o catch vazio matava o polling em silêncio. O usuário ficava
      // olhando a última etapa para sempre, sem saber que a sincronização
      // tinha parado de ser acompanhada — e sem nada no console.
      integ.falhasSeguidas = (integ.falhasSeguidas ?? 0) + 1;
      console.warn(`[mb] falha ao consultar status (${integ.falhasSeguidas}/${MAX_FALHAS_POLLING}):`, e.message);

      // Uma falha isolada costuma ser oscilação de rede: mostra o aviso e
      // continua tentando. Só desiste depois de erros consecutivos.
      if (integ.falhasSeguidas < MAX_FALHAS_POLLING) {
        const etapa = el("#mb-etapa");
        if (etapa) etapa.textContent = `Reconectando… (tentativa ${integ.falhasSeguidas} de ${MAX_FALHAS_POLLING})`;
        return;
      }

      clearInterval(integ.polling);
      integ.sessionId = null;
      integ.falhasSeguidas = 0;
      mostrarErroSincronizacao(
        "Perdemos o contato com a sincronização. Ela pode ter continuado no servidor — "
        + "confira o histórico antes de iniciar outra.",
        e.message,
      );
      await carregarIntegracao().catch(() => {});
    }
  }, 2000);
}

// Erro visível na própria área, com o detalhe técnico disponível mas discreto.
function mostrarErroSincronizacao(mensagem, detalheTecnico) {
  const alvo = el("#mb-int-conteudo");
  if (!alvo) return;
  alvo.hidden = false;
  alvo.innerHTML = `
    <div class="mb-int-aviso bad">
      <strong>${escapar(mensagem)}</strong>
      ${detalheTecnico ? `<div class="mb-int-detalhe-tecnico">Detalhe técnico: ${escapar(detalheTecnico)}</div>` : ""}
    </div>
    <div class="mb-int-form-acoes">
      <button class="btn btn-ghost" id="mb-ver-historico">Ver histórico de sincronizações</button>
    </div>`;
  el("#mb-ver-historico")?.addEventListener("click", () => abrirAba("historico"));
}

// ---------- render ----------
export function renderMartinBrower() {
  const view = el("#view");
  if (!view) return;
  mb.estado = "carregando";
  clearInterval(integ.polling);
  integ.aba = null;

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

      <div id="mb-int-host"></div>

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

  // Painel de integração carrega em paralelo — se a API falhar, o portal
  // embutido continua funcionando normalmente.
  carregarIntegracao();
}
