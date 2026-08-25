// PAGE CONTEXT — o que a TELA do frontend informa sobre onde o usuário
// estava ao abrir/usar o Agente Crescer.
//
// REGRA DE OURO: isto é PURAMENTE INFORMATIVO para o system prompt. Nunca
// decide tenant, módulo ou permissão — essas continuam vindo exclusivamente
// de req.tenant/req.acesso (Context Token, resolvidos por requireContexto em
// middlewares/auth.js), nunca deste objeto. E nunca é "prova de dado": se o
// usuário perguntar um número, a tool correspondente é sempre consultada —
// o pageContext só ajuda o modelo a não perguntar "qual produto?" quando a
// tela já deixa isso implícito.
//
// LISTA BRANCA: `sanitizarPageContext` só aceita as poucas chaves abaixo,
// com validação de forma em cada uma. Qualquer chave fora da lista —
// inclusive organizacaoId/unidadeId/userId/role/permissions, mandada por
// engano ou por um cliente malicioso tentando forjar contexto — é
// descartada nesta fronteira e nunca chega ao prompt nem a chamada alguma.
// Entrada malformada ou com módulo desconhecido não lança erro: vira `null`
// (silenciosamente "sem contexto de página"), porque isto é um extra de UX,
// nunca algo que possa derrubar a mensagem do usuário.

/**
 * Catálogo de páginas com integração real do Agente (Etapa F) — só os
 * módulos que já têm tools (ver agente.tools.js/REGISTRO). Deliberadamente
 * NÃO inclui Vendas/Bonificação/Martin Brower (Etapa E: não elegíveis ainda)
 * nem a própria página do Agente ("ia") — pageContext é sobre ONDE o usuário
 * estava antes/enquanto conversa, nunca sobre a tela do próprio chat.
 *
 * As chaves são deliberadamente DESACOPLADAS de `shared/modulos.js#MODULOS`
 * — pageContext não concede nem depende de acesso a módulo nenhum, então
 * usa um vocabulário só seu, estável mesmo que o id interno do módulo mude.
 * @type {Record<string, string>}
 */
const PAGINAS = {
  dashboard_executivo: "Dashboard Executivo",
  products_cmv: "Produtos / CMV",
  ingredients: "Insumos",
  parser_food_delivery: "Parser Food Delivery",
};

/** `view`/filtro: só um token simples (letras/números/traço/underscore) — nunca texto livre. */
const RE_VIEW = /^[a-z0-9_-]{1,40}$/i;

/** Nome de produto/insumo/nº de pedido: texto curto, capado — nunca usado como id em query alguma. */
const MAX_NOME = 120;

/**
 * Etapa H — pontos de atenção que são achados REAIS do motor determinístico
 * (dashboardExecutivo.diagnostico.js#ANALISADORES/`achado.categoria`) hoje.
 * Lista fechada de propósito: CMV agregado e cancelamentos NÃO entram aqui
 * porque não existe achado determinístico pra eles em nenhum motor (CMV só
 * existe por produto; Parser não tem motor de diagnóstico) — investigação
 * desses continua só pelo chat livre/botões contextuais já existentes,
 * nunca por um "ponto de atenção" que a tela não gerou de verdade.
 */
const ATTENTION_POINTS = [
  "taxas_comissoes", "servicos_promocoes", "taxas_entregadores",
  "total_deducoes", "faturamento", "dias_pendentes", "detalhamento_financeiro_ausente",
];

const ROTULO_ATTENTION_POINT = {
  taxas_comissoes: "Taxas e Comissões",
  servicos_promocoes: "Serviços e Promoções",
  taxas_entregadores: "Taxas de Entregadores",
  total_deducoes: "Total de Deduções",
  faturamento: "Faturamento",
  dias_pendentes: "Lançamentos pendentes",
  detalhamento_financeiro_ausente: "Detalhamento financeiro",
};

/**
 * Defesa em profundidade: mesmo que o catálogo de campos aceitos abaixo
 * ganhe uma chave por engano no futuro, nada que pareça tenant/identidade/
 * permissão sobrevive a este filtro final.
 */
const CAMPOS_PROIBIDOS = new Set([
  "organizacaoid", "organizacao_id", "unidadeid", "unidade_id",
  "userid", "usuarioid", "usuario_id", "id",
  "role", "papel", "permissao", "permissoes", "permissions",
  "sessionid", "sessiontoken", "token",
]);

/** Campo texto simples: string não vazia após trim, capada em MAX_NOME. */
function textoCurtoOpcional(v) {
  if (typeof v !== "string") return undefined;
  const s = v.trim().slice(0, MAX_NOME);
  return s || undefined;
}

/**
 * Sanitiza `req.body.pageContext` (nunca confiável — vem do frontend) numa
 * lista branca de campos. Devolve `null` quando ausente, malformado, ou com
 * `module` fora do catálogo conhecido — nunca lança.
 *
 * @param {unknown} bruto
 * @returns {{
 *   module: string, rotulo: string, view?: string, year?: number, month?: number,
 *   productName?: string, ingredientName?: string, orderNumber?: string,
 *   channel?: 'balcao'|'ifood', viewedTable?: string, comparisonMode?: boolean,
 *   attentionPoint?: string,
 * }|null}
 */
export function sanitizarPageContext(bruto) {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;

  const modulo = typeof bruto.module === "string" ? bruto.module.trim() : "";
  if (!Object.prototype.hasOwnProperty.call(PAGINAS, modulo)) return null;

  const contexto = { module: modulo, rotulo: PAGINAS[modulo] };

  if (typeof bruto.view === "string" && RE_VIEW.test(bruto.view.trim())) {
    contexto.view = bruto.view.trim();
  }

  const ano = Number(bruto.year);
  if (Number.isInteger(ano) && ano >= 2000 && ano <= 2100) contexto.year = ano;

  const mes = Number(bruto.month);
  if (Number.isInteger(mes) && mes >= 1 && mes <= 12) contexto.month = mes;

  // Só o campo do módulo correspondente é aceito (ex.: "orderNumber" não faz
  // sentido para "products_cmv") — nunca uma mistura, mesmo que o cliente
  // mande os três juntos por engano ou de propósito.
  if (modulo === "products_cmv") {
    const p = textoCurtoOpcional(bruto.productName);
    if (p) contexto.productName = p;

    // canal/tabela VISUALIZADOS na tela — só contexto informativo, nunca a
    // tabela OFICIAL (essa o backend sempre resolve sozinho, via
    // resolverTabelaComercialUnidade — um frontend malicioso ou desalinhado
    // não pode declarar "minha tabela oficial é X" e ser levado a sério; por
    // isso `officialTable` nem está na lista branca abaixo).
    if (bruto.channel === "balcao" || bruto.channel === "ifood") contexto.channel = bruto.channel;
    const t = textoCurtoOpcional(bruto.viewedTable);
    if (t && t.length <= 20) contexto.viewedTable = t;
    if (typeof bruto.comparisonMode === "boolean") contexto.comparisonMode = bruto.comparisonMode;
  } else if (modulo === "ingredients") {
    const i = textoCurtoOpcional(bruto.ingredientName);
    if (i) contexto.ingredientName = i;
  } else if (modulo === "parser_food_delivery") {
    const o = textoCurtoOpcional(bruto.orderNumber);
    if (o) contexto.orderNumber = o;
  } else if (modulo === "dashboard_executivo") {
    // Etapa H — só indica QUAL ponto de atenção o usuário quer investigar;
    // nunca é prova de valor (o prompt reforça: sempre consultar_diagnostico
    // pros números reais). Fora da whitelist -> descartado, nunca inventa.
    if (typeof bruto.attentionPoint === "string" && ATTENTION_POINTS.includes(bruto.attentionPoint)) {
      contexto.attentionPoint = bruto.attentionPoint;
    }
  }

  // Última linha de defesa — nunca deveria disparar dado o catálogo acima,
  // mas garante que uma mudança futura descuidada não abre brecha.
  for (const chave of Object.keys(contexto)) {
    if (CAMPOS_PROIBIDOS.has(chave.toLowerCase())) delete contexto[chave];
  }

  return contexto;
}

/**
 * Texto curto para o system prompt, a partir de um pageContext JÁ
 * sanitizado. Nunca inclui nada além do que `sanitizarPageContext` devolveu.
 * @param {ReturnType<typeof sanitizarPageContext>} ctx
 * @returns {string|null}
 */
export function descreverPageContext(ctx) {
  if (!ctx) return null;
  const partes = [`Página atual: ${ctx.rotulo}.`];
  if (ctx.year && ctx.month) partes.push(`Período selecionado na tela: ${String(ctx.month).padStart(2, "0")}/${ctx.year}.`);
  else if (ctx.year) partes.push(`Ano selecionado na tela: ${ctx.year}.`);
  if (ctx.view) partes.push(`Visão/filtro atual: ${ctx.view}.`);
  if (ctx.productName) partes.push(`Produto aberto na tela: "${ctx.productName}".`);
  if (ctx.channel && ctx.viewedTable) {
    const canalRotulo = ctx.channel === "ifood" ? "iFood" : "balcão";
    partes.push(
      ctx.comparisonMode
        ? `A tela está em MODO DE COMPARAÇÃO: o usuário está visualizando a Tabela ${ctx.viewedTable} (${canalRotulo}) só para comparar — isso NÃO é a tabela oficial da unidade. Se for responder sobre preço/CMV "aqui"/"nesta tabela", deixe claro que é a tabela em comparação (${ctx.viewedTable}), e use a tool para saber qual é a oficial se o usuário perguntar.`
        : `Canal/tabela na tela: ${canalRotulo} · Tabela ${ctx.viewedTable} (tabela oficial da unidade neste canal — não é comparação).`,
    );
  }
  if (ctx.ingredientName) partes.push(`Insumo aberto na tela: "${ctx.ingredientName}".`);
  if (ctx.orderNumber) partes.push(`Pedido aberto na tela: número "${ctx.orderNumber}" (use este número ao chamar consultar_cancelamento, campo numeroPedido).`);
  if (ctx.attentionPoint) {
    partes.push(`O usuário clicou para investigar o ponto de atenção "${ROTULO_ATTENTION_POINT[ctx.attentionPoint] ?? ctx.attentionPoint}" do diagnóstico do Dashboard — isto só indica a INTENÇÃO; consulte consultar_diagnostico para os dados/severidade reais antes de responder, nunca assuma o valor a partir do nome do ponto de atenção.`);
  }
  return partes.join(" ");
}

/** Exportado só para testes/documentação — nunca use para decidir acesso. */
export const PAGINAS_CONHECIDAS = Object.freeze({ ...PAGINAS });
/** Idem — whitelist de pontos de atenção investigáveis (Etapa H). */
export const ATTENTION_POINTS_CONHECIDOS = Object.freeze([...ATTENTION_POINTS]);
