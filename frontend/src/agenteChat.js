// Motor ÚNICO do chat do Agente Crescer — envio, loading, rehidratação,
// histórico, Markdown seguro, tools consultadas, limpar conversa. Usado
// tanto pela página cheia (agente.js) quanto pelo painel global
// (agentePainel.js) — UMA conversa, duas superfícies.
//
// Estado é module-level (singleton) de propósito: não existem "duas
// conversas" — existem até duas INSTÂNCIAS MONTADAS (`montagens`) mostrando
// a MESMA conversa. Enviar/receber/limpar em qualquer uma delas re-renderiza
// todas as instâncias montadas no momento (normalmente só uma está visível,
// mas nada impede as duas ao mesmo tempo — nunca duas conversas, sempre o
// mesmo `historico`/`conversationId`).
import { el, escapeHtml, toast } from "./utils.js";
import { icon } from "./icons.js";
import { agenteMensagem, agenteHistorico } from "./api.js";
import { renderizarMarkdownSeguro } from "./markdown.js";
import { registrarResetDeContexto } from "./contextoEscopo.js";
import { obterSugestoes } from "./agenteSugestoes.js";
import { descreverContextoPainel } from "./agentePageContext.js";
import { obterResolverAcao } from "./agenteAcoesResolvedores.js";

/** Abaixo desta largura o painel é quase/full-screen — action navega e fecha (item 11 do pedido); acima, mantém aberto. */
const LARGURA_MOBILE = 620;

const CHAVE_CONVERSA = "cd.agenteConversaId";
const TOOLS_ROTULO = {
  consultar_dashboard_executivo: "Dashboard Executivo",
  consultar_diagnostico: "Diagnóstico",
  consultar_dashboard_dia: "Dashboard Diário",
  consultar_produto_cmv: "Produtos / CMV",
  listar_produtos_cmv: "Produtos / CMV",
  consultar_insumo: "Insumos",
  listar_insumos: "Insumos",
  consultar_parser_resumo: "Parser Food Delivery",
  listar_cancelamentos: "Parser Food Delivery",
  consultar_cancelamento: "Parser Food Delivery",
};

// ---------------------------------------------------------------------------
// ESTADO COMPARTILHADO (singleton — ver cabeçalho do arquivo)
// ---------------------------------------------------------------------------
let historico = [];
let conversationId = sessionStorage.getItem(CHAVE_CONVERSA) || null;
let enviando = false;
let tentouHidratar = false;

/** Instâncias montadas: { root, opts } — ver montarChatAgente(). */
const montagens = new Set();

// Troca de organização/unidade INVALIDA a conversa (item 16 do pedido) —
// mesmo hook que todo módulo com estado próprio usa (ver produtoModal.js,
// parserFoodDelivery.js etc.). Silencioso: não é um "limpar" iniciado pelo
// usuário, é o contexto anterior deixando de existir.
registrarResetDeContexto(() => {
  historico = [];
  conversationId = null;
  tentouHidratar = false;
  sessionStorage.removeItem(CHAVE_CONVERSA);
  renderizarTodasAsInstancias();
});

// ---------------------------------------------------------------------------
// MONTAGEM — chamado por agente.js (modo página) e agentePainel.js (modo painel)
// ---------------------------------------------------------------------------
/**
 * @param {HTMLElement} root — elemento onde o chat é desenhado (uma vez).
 * @param {{modo: 'pagina'|'painel', obterPageContext?: () => object|null}} opts
 * @returns {{desmontar(): void, atualizarContexto(): void}}
 */
export function montarChatAgente(root, opts) {
  const instancia = { root, opts };
  montagens.add(instancia);

  root.innerHTML = template(opts);
  ligarEventos(instancia);
  renderContexto(instancia);
  renderLog(instancia);

  // Rehidrata só 1 vez por carregamento de página, e só se NENHUMA instância
  // já tem o histórico em memória — reabrir o painel/página não bate na API
  // de novo (item "Performance" do pedido).
  if (!tentouHidratar && !historico.length && conversationId) {
    tentouHidratar = true;
    rehidratar();
  }

  return {
    desmontar() { montagens.delete(instancia); },
    atualizarContexto() { renderContexto(instancia); },
  };
}

function renderizarTodasAsInstancias() {
  for (const inst of montagens) { renderLog(inst); renderContexto(inst); }
}

// ---------------------------------------------------------------------------
// TEMPLATE — mesmo miolo visual pros dois modos; painel ganha indicador de
// contexto + botão fechar; página ganha o texto de apresentação mais longo.
// ---------------------------------------------------------------------------
function template(opts) {
  const painel = opts.modo === "painel";
  return `
    <div class="agente-cabecalho">
      <span class="agente-ic">${icon("bot", { size: 22 })}</span>
      <div>
        <h2>Agente Crescer</h2>
        <p>${painel ? "Inteligência operacional" : "Assistente analítico — consulta e explica dados já calculados do Crescer com Delivery. Ainda não altera nada no sistema."}</p>
      </div>
      <div class="agente-cab-acoes">
        <button type="button" class="btn btn-ghost btn-sm" data-agente-limpar hidden>Limpar conversa</button>
        ${painel ? `<button type="button" class="modal-close agente-fechar" data-agente-fechar aria-label="Fechar Agente Crescer">×</button>` : ""}
      </div>
    </div>
    ${painel ? `<div class="agente-contexto" data-agente-contexto hidden></div>` : ""}
    <div class="agente-log" data-agente-log></div>
    <form class="agente-form" data-agente-form>
      <textarea data-agente-input maxlength="2000" rows="1" placeholder="Pergunte sobre seu desempenho, faturamento, metas..."></textarea>
      <button type="submit" class="btn btn-primary">${icon("send", { size: 16 })} Enviar</button>
    </form>
  `;
}

function ligarEventos(instancia) {
  const { root } = instancia;
  el("[data-agente-form]", root).addEventListener("submit", (e) => { e.preventDefault(); aoEnviar(instancia); });
  const campo = el("[data-agente-input]", root);
  campo.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el("[data-agente-form]", root).requestSubmit(); }
  });
  el("[data-agente-limpar]", root).addEventListener("click", () => limpar(instancia));
  el("[data-agente-fechar]", root)?.addEventListener("click", () => instancia.opts.aoFechar?.());
}

// ---------------------------------------------------------------------------
// CONTEXTO (só existe visualmente no modo painel — a página não navega)
// ---------------------------------------------------------------------------
function renderContexto(instancia) {
  const box = el("[data-agente-contexto]", instancia.root);
  if (!box) return; // modo página não tem indicador
  const pageContext = instancia.opts.obterPageContext?.() ?? null;
  const texto = descreverContextoPainel(pageContext);
  box.hidden = !texto;
  if (texto) box.textContent = texto;
}

// ---------------------------------------------------------------------------
// LOG / BOLHAS (idêntico ao comportamento anterior de agente.js)
// ---------------------------------------------------------------------------
function renderLog(instancia) {
  const log = el("[data-agente-log]", instancia.root);
  if (!log) return;
  el("[data-agente-limpar]", instancia.root).hidden = !historico.length;

  if (!historico.length) {
    const sugestoes = obterSugestoes(instancia.opts.obterPageContext?.() ?? null);
    log.innerHTML = `
      <div class="estado">
        <span class="estado-ic">${icon("bot", { size: 24 })}</span>
        <h3>Pergunte algo sobre a sua unidade</h3>
        <p>O agente consulta os dados reais do Crescer com Delivery antes de responder.</p>
        <div class="agente-sugestoes">
          ${sugestoes.map((s) => `<button type="button" class="agente-chip" data-sugestao="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("")}
        </div>
      </div>`;
    log.querySelectorAll("[data-sugestao]").forEach((b) => b.addEventListener("click", () => {
      const campo = el("[data-agente-input]", instancia.root);
      campo.value = b.dataset.sugestao;
      el("[data-agente-form]", instancia.root).requestSubmit();
    }));
    return;
  }

  log.innerHTML = historico.map((m, i) => bolha(m, i)).join("");
  log.scrollTop = log.scrollHeight;
  ligarAcoesNavegacao(instancia, log);
}

function bolha(msg, indice) {
  if (msg.papel === "usuario") {
    return `<div class="agente-msg agente-msg-usuario"><div class="agente-bolha">${escapeHtml(msg.texto)}</div></div>`;
  }
  if (msg.papel === "carregando") {
    return `<div class="agente-msg agente-msg-agente"><div class="agente-bolha agente-carregando">Agente Crescer está analisando…</div></div>`;
  }
  const tools = (msg.tools ?? []).map((t) => TOOLS_ROTULO[t] ?? t);
  // Uma tool pode aparecer 2x (ex.: consultar_cancelamento + listar_cancelamentos
  // -> "Parser Food Delivery" duas vezes) — o rótulo é a FONTE, não a tool
  // técnica, então deduplica antes de exibir.
  const fontes = [...new Set(tools)];
  // Ações de navegação (Etapa F.1) — NUNCA entram em "Consultou" (não são
  // fonte de dado). Rótulo é sempre o que o backend mandou (agente.acoes.js),
  // nunca texto gerado aqui. Máximo já vem capado do backend (3).
  const acoes = msg.actions ?? [];
  return `<div class="agente-msg agente-msg-agente">
    <div class="agente-bolha ${msg.erro ? "agente-erro" : ""}">${msg.erro ? escapeHtml(msg.texto) : renderizarMarkdownSeguro(msg.texto)}</div>
    ${fontes.length ? `<div class="agente-tools">${icon("database", { size: 12 })} Consultou: ${fontes.map(escapeHtml).join(", ")}</div>` : ""}
    ${acoes.length ? `<div class="agente-acoes">${acoes.map((a, i) => `<button type="button" class="btn btn-ghost btn-sm agente-acao-btn" data-agente-acao="${indice}:${i}">${escapeHtml(a.label)}</button>`).join("")}</div>` : ""}
  </div>`;
}

/** Liga cada botão de action renderizado ao seu objeto real (nunca reconstrói a action a partir do DOM). */
function ligarAcoesNavegacao(instancia, log) {
  log.querySelectorAll("[data-agente-acao]").forEach((btn) => {
    const [msgIdx, acaoIdx] = btn.dataset.agenteAcao.split(":").map(Number);
    const acao = historico[msgIdx]?.actions?.[acaoIdx];
    if (!acao) return;
    btn.addEventListener("click", () => executarAcao(instancia, btn, acao));
  });
}

/**
 * Executa uma action de navegação — nunca constrói URL/rota aqui: só chama o
 * resolver JÁ REGISTRADO pra este target (ver agenteAcoesResolvedores.js). Um
 * target sem resolver (nunca deveria acontecer, dado que o backend só manda
 * targets de um enum fechado) simplesmente não navega — nunca lança.
 */
async function executarAcao(instancia, btn, acao) {
  const resolver = obterResolverAcao(acao.target);
  if (!resolver) return;
  btn.disabled = true;
  try {
    await resolver(acao.params ?? {});
  } catch {
    toast("Não foi possível abrir isso agora.");
  } finally {
    btn.disabled = false;
  }
  // Mobile: painel quase/full-screen -> fecha após navegar (item 11 do
  // pedido). Desktop/página: mantém aberto e só atualiza o indicador de
  // contexto (a rota mudou) — nunca recria o painel nem rehidrata o log.
  if (instancia.opts.modo === "painel" && window.innerWidth <= LARGURA_MOBILE) {
    instancia.opts.aoFechar?.();
  } else {
    renderContexto(instancia);
  }
}

// ---------------------------------------------------------------------------
// REHIDRATAÇÃO / ENVIO / LIMPAR
// ---------------------------------------------------------------------------
async function rehidratar() {
  renderizarTodasAsInstancias(); // mostra o log vazio/"carregando" já montado
  try {
    const { data } = await agenteHistorico(conversationId);
    // Actions reaparecem ao reidratar (Etapa F.1) — mas nunca carregam
    // autorização própria: clicar numa é sempre revalidado no momento do
    // clique (o resolver chama código real do Crescer, que já respeita o
    // acesso ATUAL, nunca o de quando a mensagem foi salva).
    historico = data.mensagens.map((m) => ({
      papel: m.papel === "user" ? "usuario" : "agente", texto: m.texto, tools: m.tools ?? [], actions: m.actions ?? [],
    }));
  } catch {
    // Conversa não encontrada (expirou, trocou de unidade, id inválido) —
    // começa do zero silenciosamente, sem expor esse detalhe ao usuário.
    conversationId = null;
    sessionStorage.removeItem(CHAVE_CONVERSA);
  }
  renderizarTodasAsInstancias();
}

async function aoEnviar(instancia) {
  if (enviando) return; // trava clique duplo/Enter repetido enquanto uma resposta está em voo
  const campo = el("[data-agente-input]", instancia.root);
  const texto = campo.value.trim();
  if (!texto) return;

  // Page Context é lido AGORA (momento do envio), não no momento em que o
  // painel foi aberto — se o usuário navegou enquanto digitava, a pergunta
  // vai com o contexto da tela ATUAL (item 6 do pedido).
  const pageContext = instancia.opts.obterPageContext?.() ?? null;

  historico.push({ papel: "usuario", texto });
  historico.push({ papel: "carregando" });
  enviando = true;
  campo.value = "";
  renderizarTodasAsInstancias();

  try {
    const { data } = await agenteMensagem(texto, conversationId, pageContext);
    conversationId = data.conversationId;
    sessionStorage.setItem(CHAVE_CONVERSA, conversationId);
    historico.pop(); // remove "carregando"
    historico.push({ papel: "agente", texto: data.resposta, tools: data.metadata?.toolsUtilizadas ?? [], actions: data.actions ?? [] });
  } catch (err) {
    historico.pop();
    historico.push({ papel: "agente", texto: err.message || "Não foi possível falar com o Agente Crescer agora.", erro: true });
    toast("Erro ao consultar o Agente Crescer.");
  } finally {
    enviando = false;
    renderizarTodasAsInstancias();
    el("[data-agente-input]", instancia.root)?.focus();
  }
}

function limpar(instancia) {
  historico = [];
  conversationId = null;
  tentouHidratar = true; // não há o que reidratar de uma conversa nova
  sessionStorage.removeItem(CHAVE_CONVERSA);
  renderizarTodasAsInstancias();
  el("[data-agente-input]", instancia.root)?.focus();
}
