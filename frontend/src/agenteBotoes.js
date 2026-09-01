// Construtores de HTML dos botões do Agente Crescer — funções PURAS (só
// string), sem tocar DOM/estado. Ficam num módulo próprio (fora de
// agentePainel.js, que arrasta o chat inteiro e só roda no navegador) para
// serem testáveis em Node e reutilizáveis por qualquer view — hoje
// dashboardExecutivoPlano.js e o próprio agentePainel.js (que reexporta).
import { rotuloBotaoContextual } from "./agenteSugestoes.js";

/**
 * HTML de um botão "✦ Analisar…" — usado pelas views no próprio cabeçalho.
 * `chave` é uma das chaves de rotuloBotaoContextual/TEXTO_SUGERIDO.
 * @param {string} chave
 */
export function botaoContextualHtml(chave) {
  return `<button type="button" class="btn btn-ghost btn-sm agente-btn-contextual" data-agente-contextual="${chave}">✦ ${rotuloBotaoContextual(chave)}</button>`;
}

/**
 * Botão "✦ Diagnosticar com Agente Crescer" de um card do Plano de Ação.
 * Carrega QUAL ponto de atenção foi clicado (`data-attention-point`) e, quando
 * conhecido, a classificação do card (`data-diagnostico-tipo`) — lidos por
 * `ligarBotoesContextuais` antes de abrir o painel, para escolher o
 * texto-semente certo. Nada disso é inventado no backend.
 * @param {string} attentionPoint categoria do achado (ex.: "taxas_entregadores")
 * @param {string} [tipo] classificação do card: CRITICAL | WARNING | HEALTHY | DATA_PENDING
 */
export function botaoDiagnosticoHtml(attentionPoint, tipo) {
  const attrTipo = tipo ? ` data-diagnostico-tipo="${tipo}"` : "";
  return `<button type="button" class="btn btn-ghost btn-sm agente-btn-contextual" data-agente-contextual="dashboard_diagnostico" data-attention-point="${attentionPoint}"${attrTipo}>✦ ${rotuloBotaoContextual("dashboard_diagnostico")}</button>`;
}

/**
 * Texto que PRÉ-PREENCHE o campo do Agente ao clicar em "✦ Diagnosticar…"
 * (nunca envia sozinho — mesma regra da Etapa F). Varia pela classificação do
 * card para nunca pedir "por que está ruim?" num indicador saudável.
 * @param {string} [tipo] CRITICAL | WARNING | HEALTHY | DATA_PENDING
 * @returns {string}
 */
export function textoSementeDiagnostico(tipo) {
  switch (tipo) {
    case "CRITICAL":
      return "Investigue por que este indicador está acima do limite, quais dados disponíveis ajudam a explicar o resultado e quais ações são possíveis.";
    case "WARNING":
      return "Analise por que este indicador saiu da faixa ideal, quanto falta para atingir o limite e quais cuidados podem evitar que piore.";
    case "HEALTHY":
      return "Este indicador está dentro da meta. Analise os dados disponíveis buscando entender o que pode estar contribuindo para esse resultado e o que devemos acompanhar para preservá-lo.";
    case "DATA_PENDING":
      return "Explique como os lançamentos pendentes afetam as médias, projeções e comparações deste mês e o que priorizar para regularizar.";
    default:
      return "Investigue este ponto de atenção e recomende as melhores ações.";
  }
}
