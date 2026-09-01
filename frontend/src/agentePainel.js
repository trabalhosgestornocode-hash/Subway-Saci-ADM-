// Painel global do Agente Crescer — drawer PERSISTENTE, fora de #view (que é
// destruído a cada navegação — ver router.js). Montado UMA VEZ (idempotente)
// e nunca recriado: abrir/fechar só alterna uma classe CSS, então a
// conversa, o texto em digitação e o estado aberto/fechado sobrevivem a
// qualquer troca de rota.
//
// Mesmo padrão visual/técnico do drawer já usado em Bonificação Mensal e no
// Parser Food Delivery (.bm-drawer/.bm-drawer-overlay) — não copiado
// cegamente porque aqui o drawer NUNCA é removido do DOM ao fechar (ao
// contrário de abrirPfdDrawer/fecharPfdDrawer, que recriam a cada abertura:
// lá cada abertura é um conteúdo novo; aqui é a MESMA conversa persistente).
import { montarChatAgente } from "./agenteChat.js";
import { obterPageContextAtual } from "./agentePageContext.js";
import {
  botaoContextualHtml as construirBotaoContextual,
  botaoDiagnosticoHtml as construirBotaoDiagnostico,
  textoSementeDiagnostico,
} from "./agenteBotoes.js";
import { registrarResetDeContexto } from "./contextoEscopo.js";
import { state } from "./state.js";

let overlayEl = null;
let corpoEl = null;
let instancia = null;
let aberto = false;

/** Textos sugeridos (preenchem o input, NUNCA enviam sozinhos — item 9 do pedido) por botão contextual. */
const TEXTO_SUGERIDO = {
  dashboard_executivo: "Analise meu mês",
  products_cmv_lista: "Quais produtos têm maior CMV?",
  products_cmv_produto: "Analise este produto",
  ingredients_lista: "Quais insumos têm maior custo?",
  ingredients_insumo: "Quais produtos usam este insumo?",
  parser_food_delivery: "Analise meus cancelamentos",
  // Etapa H — texto genérico de propósito: o ponto de atenção específico já
  // vai no Page Context (attentionPoint), o modelo não precisa dele repetido
  // no texto pra investigar corretamente.
  dashboard_diagnostico: "Investigue este ponto de atenção e recomende as melhores ações.",
};

/** Monta o painel no shell do tenant. Idempotente — chamadas depois da primeira são no-op. */
export function montarPainelGlobal() {
  if (overlayEl) return;

  overlayEl = document.createElement("div");
  overlayEl.className = "agente-painel-overlay";
  overlayEl.innerHTML = `<aside class="agente-painel" role="dialog" aria-label="Agente Crescer"></aside>`;
  document.body.appendChild(overlayEl);
  corpoEl = overlayEl.querySelector(".agente-painel");

  instancia = montarChatAgente(corpoEl, {
    modo: "painel",
    obterPageContext: obterPageContextAtual,
    aoFechar: fecharPainel,
  });

  // Fecha ao clicar fora (só surte efeito onde o overlay realmente capta
  // clique — no desktop o overlay é transparente e não bloqueia a tela por
  // trás, ver styles.css; no mobile funciona como um overlay comum).
  overlayEl.addEventListener("click", (e) => { if (e.target === overlayEl) fecharPainel(); });
  document.addEventListener("keydown", (e) => { if (aberto && e.key === "Escape") fecharPainel(); });
}

/**
 * @param {{sugestaoChave?: string, textoSemente?: string}} [opts]
 *   `sugestaoChave` — chave de TEXTO_SUGERIDO pra pré-preencher o input.
 *   `textoSemente` — texto explícito (vence a chave); usado pelos cards do
 *   Plano de Ação, cujo texto-semente varia pela classificação. Nunca envia
 *   sozinho (mesma regra do item 9 / Etapa F).
 */
export function abrirPainel(opts = {}) {
  montarPainelGlobal();
  aberto = true;
  overlayEl.classList.add("aberto");
  document.body.classList.add("agente-painel-aberto");
  sincronizarContextoPainel();

  const sugestao = opts.textoSemente ?? (opts.sugestaoChave ? TEXTO_SUGERIDO[opts.sugestaoChave] : null);
  const campo = corpoEl.querySelector("[data-agente-input]");
  if (campo) {
    if (sugestao && !campo.value) campo.value = sugestao;
    requestAnimationFrame(() => campo.focus());
  }
}

export function fecharPainel() {
  aberto = false;
  overlayEl?.classList.remove("aberto");
  document.body.classList.remove("agente-painel-aberto");
}

export function alternarPainel() {
  if (aberto) fecharPainel(); else abrirPainel();
}

export function painelEstaAberto() {
  return aberto;
}

/**
 * Recalcula o Page Context (a partir do estado REAL da tela — nunca lê nada
 * daqui, delega a agentePageContext.js) e atualiza só o indicador visual +
 * sugestões — NUNCA recria o painel, nunca rehidrata histórico. Chamado após
 * toda navegação (router.js) e sempre que um detalhe (produto/insumo/pedido)
 * abre ou fecha.
 */
export function sincronizarContextoPainel() {
  instancia?.atualizarContexto();
}

/**
 * HTML de um botão "✦ Analisar..." — usado pelas views (dashboardExecutivo.js,
 * views.js, insumos.js, parserFoodDelivery.js) no próprio cabeçalho, sem
 * redesenhar a tela. `chave` é uma das chaves de rotuloBotaoContextual/
 * TEXTO_SUGERIDO (ex.: "products_cmv_produto").
 * @param {string} chave
 */
export function botaoContextualHtml(chave) {
  return construirBotaoContextual(chave);
}

/**
 * Etapa H — botão por ponto de atenção do Plano de Ação (dashboardExecutivoPlano.js#planoAcaoHtml).
 * Carrega QUAL ponto de atenção foi clicado (`data-attention-point`) e, quando
 * conhecido, a classificação do card (`data-diagnostico-tipo`), lidos por
 * `ligarBotoesContextuais` para escolher o texto-semente. Nunca inventado no backend.
 * @param {string} attentionPoint categoria do achado (ex.: "taxas_entregadores")
 * @param {string} [tipo] CRITICAL | WARNING | HEALTHY | DATA_PENDING
 */
export function botaoDiagnosticoHtml(attentionPoint, tipo) {
  return construirBotaoDiagnostico(attentionPoint, tipo);
}

/** Liga o(s) botão(ões) contextual(is) já renderizado(s) dentro de `root` (ou do documento, se omitido). */
export function ligarBotoesContextuais(root = document) {
  root.querySelectorAll("[data-agente-contextual]").forEach((btn) => {
    // Um botão pode já ter sido ligado numa renderização anterior do mesmo
    // container — evita empilhar listeners a cada re-render da tela.
    if (btn.dataset.agenteLigado) return;
    btn.dataset.agenteLigado = "1";
    btn.addEventListener("click", () => {
      // Etapa H — grava a INTENÇÃO no espelho de estado (state.js#detalheAberto)
      // antes de abrir, pra obterPageContextAtual() já ler o ponto certo.
      if (btn.dataset.attentionPoint) state.detalheAberto.attentionPoint = btn.dataset.attentionPoint;
      // Reformulação do Plano de Ação — a classificação do card decide o
      // texto-semente (nunca "por que está ruim?" num indicador saudável).
      const tipo = btn.dataset.diagnosticoTipo || null;
      state.detalheAberto.attentionTipo = tipo;
      abrirPainel({
        sugestaoChave: btn.dataset.agenteContextual,
        textoSemente: tipo ? textoSementeDiagnostico(tipo) : undefined,
      });
    });
  });
}

// Troca de organização/unidade: o painel continua existindo (não é um dado
// de negócio), mas fecha — reabrir já mostra a conversa nova (agenteChat.js
// já trata o reset da conversa em si). Sem isto, o usuário veria o painel
// aberto sobre a tela nova, ainda com o indicador de contexto da unidade
// anterior por um instante.
registrarResetDeContexto(fecharPainel);
