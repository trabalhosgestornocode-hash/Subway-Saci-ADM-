// Sugestões contextuais do Agente Crescer — catálogo CENTRAL por módulo/
// view (nunca espalhado pelas telas). Máximo 4 por contexto — item explícito
// do pedido: não virar uma parede de chips.
import { ROTULO_MODULO } from "./agentePageContext.js";

export const MAX_SUGESTOES = 4;

const GENERICAS = ["Como estou este mês?", "Me dê um diagnóstico completo", "Quais produtos têm maior CMV?"];

/**
 * Por módulo: array (mesma lista pra qualquer view) OU objeto { view: [...] },
 * com `_padrao` como fallback quando a view específica não tem lista própria.
 */
const POR_MODULO = {
  dashboard_executivo: {
    _padrao: ["Analise meu mês", "Quais pontos merecem atenção?", "Compare com o mês anterior", "Como está minha projeção?"],
    // Etapa H — só aparece quando o usuário clicou "✦ Diagnosticar..." num
    // ponto de atenção específico do Plano de Ação (view "diagnostico").
    diagnostico: [
      "Por que esse indicador está ruim?", "O que mais está causando isso?",
      "O que devo fazer primeiro?", "Quais dados sustentam esse diagnóstico?",
    ],
    // Reformulação do Plano de Ação — quando o card clicado é HEALTHY, o
    // indicador está DENTRO da meta: nada de "por que está ruim?". Sugestões
    // de preservação (o backend nunca deixa o Agente afirmar uma causa que os
    // dados não provam — ver agente.prompt.js#44).
    diagnostico_saudavel: [
      "O que pode estar contribuindo para esse resultado?",
      "O que devo acompanhar para preservar isso?",
      "Quais dados sustentam esse diagnóstico?",
      "Esse resultado pode ser replicado em outras áreas?",
    ],
  },
  products_cmv: {
    lista: ["Quais produtos têm maior CMV?", "Quais produtos merecem atenção?", "Qual produto tem maior custo?"],
    produto: ["Analise este produto", "O que mais pesa no custo?", "Qual é a ficha técnica?", "Compare com outro produto"],
  },
  ingredients: {
    lista: ["Quais insumos têm maior custo?", "Quais insumos estão sem custo cadastrado?", "Quais insumos estão inativos?"],
    insumo: ["Quais produtos usam este insumo?", "O que este insumo impacta?", "Esse insumo ficou mais caro?"],
  },
  parser_food_delivery: {
    cancelamentos: ["Analise meus cancelamentos", "Quais precisam de revisão?", "Quanto está envolvido em taxas?", "Quais têm confiança muito alta?"],
    pedido: ["Por que este pedido recebe taxa?", "Explique este cancelamento"],
    geral: ["Analise meus cancelamentos", "Quanto está envolvido em taxas?"],
  },
};

/**
 * @param {{module?: string, view?: string}|null} pageContext já derivado (ver agentePageContext.js)
 * @returns {string[]} até MAX_SUGESTOES sugestões
 */
export function obterSugestoes(pageContext) {
  if (!pageContext?.module) return GENERICAS.slice(0, MAX_SUGESTOES);
  const entrada = POR_MODULO[pageContext.module];
  if (!entrada) return GENERICAS.slice(0, MAX_SUGESTOES);
  // Card HEALTHY do Plano de Ação -> sugestões de preservação, nunca de problema.
  const view = pageContext.view === "diagnostico" && pageContext.attentionTipo === "HEALTHY"
    ? "diagnostico_saudavel"
    : pageContext.view;
  const lista = Array.isArray(entrada) ? entrada : (entrada[view] ?? entrada._padrao ?? GENERICAS);
  return lista.slice(0, MAX_SUGESTOES);
}

/** Rótulo curto do botão contextual por módulo/view — usado pelas telas (ver views.js/insumos.js/etc.). */
export function rotuloBotaoContextual(moduloOuView) {
  const rotulos = {
    dashboard_executivo: "Analisar com Agente Crescer",
    products_cmv_lista: "Analisar Produtos / CMV",
    products_cmv_produto: "Analisar este produto",
    ingredients_lista: "Analisar Insumos",
    ingredients_insumo: "Analisar este insumo",
    parser_food_delivery: "Investigar cancelamentos",
    dashboard_diagnostico: "Diagnosticar com Agente Crescer",
  };
  return rotulos[moduloOuView] ?? `Analisar com ${ROTULO_MODULO[moduloOuView] ?? "Agente Crescer"}`;
}
