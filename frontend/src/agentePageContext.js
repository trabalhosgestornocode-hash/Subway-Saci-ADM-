// PAGE CONTEXT do Agente Crescer — deriva, de forma CENTRALIZADA, em que
// tela o usuário está para o backend usar como texto informativo (nunca
// prova de dado, nunca influencia tenant/permissão — ver
// backend/src/modules/agente/agente.pageContext.js).
//
// `derivarPageContext` é PURA (recebe um "retrato" já coletado do estado
// real, nunca lê `state`/DOM sozinha) — testável sem navegador, mesmo
// espírito das funções puras do backend. `obterPageContextAtual` é a única
// função que de fato lê o estado da aplicação; é ela que qualquer chamador
// real usa.
//
// NUNCA adicione aqui um campo de tenant/identidade (organizacaoId,
// unidadeId, userId, role, permissões) — o backend já rejeita isso na
// sanitização, mas o princípio é nem tentar mandar.
//
// Lê SÓ de `state` (nunca importa dashboardExecutivo.js/parserFoodDelivery.js
// diretamente) — essas telas importam agentePainel.js (botão contextual), que
// importa este arquivo; importar as telas de volta daqui criaria um ciclo.
// `state` é a ponte deliberada (cada view escreve o que é dela, ver
// dashboardExecutivo.js#carregarConteudo / parserFoodDelivery.js#irParaAba).
import { state, tabelaAtiva, emComparacao } from "./state.js";

/** Mapa ÚNICO rota -> módulo do Page Context — nunca espalhar `if (rota === ...)` por outros arquivos. */
const ROTA_PARA_MODULO = {
  "dashboard-executivo": "dashboard_executivo",
  "produtos": "products_cmv",
  "insumos": "ingredients",
  "parser-food-delivery": "parser_food_delivery",
};

/** Rótulos amigáveis (indicador visual do painel) — mesmo vocabulário do backend (agente.pageContext.js#PAGINAS). */
export const ROTULO_MODULO = {
  dashboard_executivo: "Dashboard Executivo",
  products_cmv: "Produtos / CMV",
  ingredients: "Insumos",
  parser_food_delivery: "Parser Food Delivery",
};

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const capitalizar = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Rótulo do indicador visual — mesmo vocabulário do backend (agente.pageContext.js#ROTULO_ATTENTION_POINT). */
const ROTULO_ATTENTION_POINT = {
  taxas_comissoes: "Taxas e Comissões", servicos_promocoes: "Serviços e Promoções",
  taxas_entregadores: "Taxas de Entregadores", total_deducoes: "Total de Deduções",
  faturamento: "Faturamento", dias_pendentes: "Lançamentos pendentes",
  detalhamento_financeiro_ausente: "Detalhamento financeiro",
};

/**
 * Monta o pageContext a partir de um retrato já coletado — pura, testável.
 * @param {{
 *   rota: string,
 *   detalheAberto?: {produto?: string|null, insumo?: string|null, pedido?: string|null, attentionPoint?: string|null},
 *   periodoDashboard?: {ano?: number, mes?: number}|null,
 *   contextoParser?: {aba?: string, ano?: number|null, mes?: number|null}|null,
 *   tabelaTela?: {canal?: string, tabela?: string|null, comparando?: boolean}|null,
 * }} retrato
 * @returns {object|null} no formato aceito por POST /agente/mensagem, ou null (sem contexto integrado nesta tela)
 */
export function derivarPageContext({ rota, detalheAberto, periodoDashboard, contextoParser, tabelaTela } = {}) {
  const module = ROTA_PARA_MODULO[rota];
  if (!module) return null;

  if (module === "dashboard_executivo") {
    const p = periodoDashboard || {};
    const ctx = { module, view: "mes" };
    if (p.ano) ctx.year = p.ano;
    if (p.mes) ctx.month = p.mes;
    // Etapa H — só marca a INTENÇÃO de investigar um ponto de atenção
    // (botão "✦ Diagnosticar..." no Plano de Ação); o backend nunca trata
    // isto como prova de dado (ver agente.pageContext.js#ATTENTION_POINTS).
    if (detalheAberto?.attentionPoint) {
      ctx.view = "diagnostico";
      ctx.attentionPoint = detalheAberto.attentionPoint;
    }
    return ctx;
  }

  if (module === "products_cmv") {
    // channel/viewedTable/comparisonMode: SÓ informativo (o backend nunca
    // confia nisso pra saber qual é a tabela oficial — ele sempre resolve
    // sozinho, ver agente.pageContext.js). Ajuda o modelo a saber que tabela
    // o usuário está OLHANDO agora, e se é uma comparação.
    const t = tabelaTela || {};
    const base = { module };
    if (t.canal) base.channel = t.canal;
    if (t.tabela) base.viewedTable = t.tabela;
    if (typeof t.comparando === "boolean") base.comparisonMode = t.comparando;

    if (detalheAberto?.produto) return { ...base, view: "produto", productName: detalheAberto.produto };
    return { ...base, view: "lista" };
  }

  if (module === "ingredients") {
    if (detalheAberto?.insumo) return { module, view: "insumo", ingredientName: detalheAberto.insumo };
    return { module, view: "lista" };
  }

  if (module === "parser_food_delivery") {
    const c = contextoParser || {};
    const ctx = { module };
    if (c.ano) ctx.year = c.ano;
    if (c.mes) ctx.month = c.mes;
    if (detalheAberto?.pedido) return { ...ctx, view: "pedido", orderNumber: detalheAberto.pedido };
    ctx.view = c.aba === "cancelamentos" ? "cancelamentos" : "geral";
    return ctx;
  }

  return { module };
}

/** Lê o estado REAL da aplicação e monta o pageContext atual. Única função que qualquer chamador de produção deve usar. */
export function obterPageContextAtual() {
  return derivarPageContext({
    rota: state.rota,
    detalheAberto: state.detalheAberto,
    periodoDashboard: state.periodoDashboardExecutivo,
    contextoParser: state.contextoParser,
    tabelaTela: { canal: state.canal, tabela: tabelaAtiva(), comparando: emComparacao() },
  });
}

/**
 * Texto curto do indicador visual do painel ("Analisando: X · MM/AAAA" /
 * "Contexto: Y"). `null` quando a tela atual não tem integração — o painel
 * simplesmente não mostra indicador nesse caso (nunca "Contexto geral").
 * @param {ReturnType<typeof derivarPageContext>} pageContext
 */
export function descreverContextoPainel(pageContext) {
  if (!pageContext?.module) return null;
  const rotulo = ROTULO_MODULO[pageContext.module] ?? pageContext.module;
  const periodo = pageContext.year && pageContext.month ? ` · ${capitalizar(MESES[pageContext.month - 1])}/${pageContext.year}` : "";

  if (pageContext.attentionPoint) return `Diagnosticando: ${ROTULO_ATTENTION_POINT[pageContext.attentionPoint] ?? pageContext.attentionPoint}${periodo}`;
  if (pageContext.productName) return `Contexto: ${pageContext.productName}`;
  if (pageContext.ingredientName) return `Contexto: ${pageContext.ingredientName}`;
  if (pageContext.orderNumber) return `Contexto: Pedido #${pageContext.orderNumber}`;
  if (pageContext.view === "cancelamentos") return `Contexto: Cancelamentos${periodo}`;
  return `Analisando: ${rotulo}${periodo}`;
}
