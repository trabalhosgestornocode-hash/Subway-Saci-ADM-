// Decisões PURAS da tela de integração iFood — sem DOM, sem browser, sem
// imports de rede. Mesmo padrão de agentePageContext.js / contextoEscopo.js:
// a view (ifood.js) coleta o retrato do estado real e passa para cá; estas
// funções só decidem. É isto que os testes exercitam.

/** Rótulos amigáveis dos dois aplicativos distribuídos. */
export const APP_ROTULO = Object.freeze({
  analytics: "Desempenho / Analytics",
  financial: "Financeiro / Merchant",
});

const META_ESTADO = Object.freeze({
  nao_conectado: { rotulo: "Não conectado", classe: "muted" },
  parcial: { rotulo: "Parcialmente conectado", classe: "warn" },
  conectado: { rotulo: "Conectado", classe: "ok" },
  reauth: { rotulo: "Reconexão necessária", classe: "bad" },
});

function estadoDeApp(app = {}) {
  if (app.status === "reauth_required") return { conectado: false, rotulo: "Reconexão necessária", classe: "bad" };
  if (app.conectado) return { conectado: true, rotulo: "Conectado", classe: "ok", expiraEm: app.expiraEm ?? null };
  return { conectado: false, rotulo: "Não conectado", classe: "muted" };
}

/**
 * Traduz a resposta de GET /status para o estado visual da tela.
 * @param {object|null} status resposta sanitizada do backend
 * @returns {{
 *   chave: 'nao_conectado'|'parcial'|'conectado'|'reauth',
 *   rotulo: string, classe: string,
 *   apps: { analytics: object, financial: object },
 *   merchant: {idMascarado, nome, razaoSocial}|null,
 *   podeConectarAnalytics: boolean, podeConectarFinancial: boolean,
 *   precisaReconectar: boolean, podeDesconectar: boolean,
 *   conectadaEm: string|null,
 * }}
 */
export function derivarEstadoIntegracao(status) {
  const s = status ?? {};
  const apps = s.apps ?? {};
  const analytics = estadoDeApp(apps.analytics);
  const financial = estadoDeApp(apps.financial);
  const merchant = s.merchant ?? null;

  const algumReauth = s.status === "reauth_required"
    || apps.analytics?.status === "reauth_required"
    || apps.financial?.status === "reauth_required";

  const nada = !analytics.conectado && !financial.conectado && !merchant && !algumReauth
    && (!s.status || s.status === "nao_conectado" || s.status === "revogada");

  let chave;
  if (algumReauth) chave = "reauth";
  else if (nada) chave = "nao_conectado";
  else if (analytics.conectado && financial.conectado && merchant) chave = "conectado";
  else chave = "parcial";

  return {
    chave,
    ...META_ESTADO[chave],
    apps: { analytics, financial },
    merchant,
    podeConectarAnalytics: !analytics.conectado || apps.analytics?.status === "reauth_required",
    podeConectarFinancial: !financial.conectado || apps.financial?.status === "reauth_required",
    precisaReconectar: chave === "reauth",
    podeDesconectar: chave !== "nao_conectado",
    conectadaEm: s.conectadaEm ?? null,
  };
}

/**
 * Prepara a etapa de seleção de merchant a partir da lista de GET /merchants.
 * NUNCA vincula sozinho — até com 1 loja pede confirmação.
 * @param {Array<{id, idMascarado, nome, razaoSocial}>} merchants
 * @returns {{modo: 'vazio'|'unico'|'lista', merchants: object[], mensagem: string}}
 */
export function prepararSelecaoMerchant(merchants) {
  const lista = Array.isArray(merchants) ? merchants.filter((m) => m && m.id) : [];
  if (lista.length === 0) {
    return {
      modo: "vazio", merchants: [],
      mensagem: "Esta conta iFood não possui acesso a nenhuma loja. Confira no Portal do Parceiro se o aplicativo foi autorizado para alguma loja e tente de novo.",
    };
  }
  if (lista.length === 1) {
    return { modo: "unico", merchants: lista, mensagem: "Encontramos uma loja. Confirme que é a loja desta unidade antes de vincular." };
  }
  return { modo: "lista", merchants: lista, mensagem: "Selecione a loja do iFood correspondente a esta unidade." };
}

/**
 * Contador de expiração do userCode (10 min). Puro — recebe o "agora".
 * @param {string} expiraEmIso
 * @param {number} [agoraMs]
 * @returns {{expirado: boolean, restanteMs: number, rotulo: string}}
 */
export function contadorExpiracao(expiraEmIso, agoraMs = Date.now()) {
  const alvo = new Date(expiraEmIso).getTime();
  if (!Number.isFinite(alvo)) return { expirado: true, restanteMs: 0, rotulo: "—" };
  const restanteMs = alvo - agoraMs;
  if (restanteMs <= 0) return { expirado: true, restanteMs: 0, rotulo: "expirado" };
  const totalSeg = Math.floor(restanteMs / 1000);
  const mm = String(Math.floor(totalSeg / 60)).padStart(2, "0");
  const ss = String(totalSeg % 60).padStart(2, "0");
  return { expirado: false, restanteMs, rotulo: `${mm}:${ss}` };
}

/**
 * Troca de merchant na mesma unidade: precisa de confirmação explícita
 * quando já há um merchant vinculado E o escolhido é OUTRO. Mesmo merchant
 * (idempotente) ou nenhum vinculado -> sem confirmação.
 *
 * Compara pelo idMascarado — é o único identificador que o /status expõe;
 * uma colisão de máscara só causaria uma confirmação a mais, nunca um vínculo
 * errado (o backend revalida na API de qualquer forma).
 * @param {object|null} status resposta de GET /status
 * @param {{idMascarado?: string}} merchantEscolhido
 * @returns {boolean}
 */
export function precisaConfirmarTrocaMerchant(status, merchantEscolhido) {
  const atual = status?.merchant?.idMascarado;
  if (!atual) return false;
  return atual !== (merchantEscolhido?.idMascarado ?? null);
}

/** Texto da confirmação de troca de merchant. */
export function textoConfirmacaoTroca(status, merchantEscolhido) {
  const de = status?.merchant?.nome || status?.merchant?.idMascarado || "a loja atual";
  const para = merchantEscolhido?.nome || merchantEscolhido?.idMascarado || "a nova loja";
  return `Esta unidade já está vinculada a "${de}". Deseja substituir pelo vínculo com "${para}"? O vínculo anterior deixará de valer.`;
}

/** Mensagem amigável para uma falha no fluxo de autorização. */
export function mensagemErroAutorizacao(err) {
  switch (err?.codigo) {
    case "IFOOD_OAUTH_SESSAO_EXPIRADA":
      return "O código de vínculo expirou. Gere outro código e tente novamente.";
    case "IFOOD_OAUTH_SESSAO_JA_USADA":
      return "Essa autorização já foi concluída ou cancelada. Gere um novo código se precisar reconectar.";
    case "IFOOD_OAUTH_CODIGO_INVALIDO":
      return "Não foi possível concluir a autorização. Confira o código de autorização fornecido pelo iFood e tente novamente, ou gere um novo código.";
    case "IFOOD_APP_SEM_CREDENCIAL":
      return "Este aplicativo iFood ainda não está configurado no sistema. Fale com o suporte da plataforma.";
    default:
      return err?.message || "Não foi possível concluir a autorização. Gere um novo código e tente novamente.";
  }
}

/** Aviso exibido ao desconectar — remoção local ≠ revogação no iFood. */
export function avisoDesconexao() {
  return "A desconexão remove o acesso apenas aqui no Crescer com Delivery: os tokens locais são descartados e a integração é desativada. "
    + "Isso não revoga necessariamente o acesso no iFood. Para revogação total, remova também o aplicativo no Portal do Parceiro iFood "
    + "(apenas quem autorizou pode revogar por lá).";
}
