// ACTION REGISTRY — únicos alvos de navegação que o Agente Crescer pode
// sugerir (Etapa F.1). Puro, sem I/O — testável sem banco.
//
// REGRA DE OURO (a mais importante deste arquivo): Claude NUNCA gera uma URL
// nem uma rota livre. Ele só escolhe um `target` de um enum fechado (ver
// tools/navegacao.tool.js#definicao.input_schema) — este arquivo é quem
// decide se esse target é válido, se o usuário tem acesso a ele, e monta o
// `label` (sempre nosso, nunca do texto do Claude) e os `params` (lista
// branca POR target — nunca um objeto livre).
//
// Isto NÃO é uma tool de escrita: `resolverAcao` nunca muda nada no banco,
// só decide "esta sugestão de navegação é válida para este usuário?".
import { MODULOS } from "../../shared/modulos.js";
import { PERMISSOES, temPermissao } from "../../shared/permissoes.js";

const MAX_PARAM = 120;

/** Texto curto: string não vazia após trim, capada — nunca usado como id em query alguma (mesmo padrão de agente.pageContext.js). */
function textoCurtoOpcional(v) {
  if (typeof v !== "string") return undefined;
  const s = v.trim().slice(0, MAX_PARAM);
  return s || undefined;
}

/**
 * @typedef {{
 *   modulo: string, permissao: string,
 *   paramsPermitidos: string[], paramsObrigatorios: string[],
 *   rotulo: (params: Record<string,string>) => string,
 * }} DefinicaoAcao
 */

/** @type {Record<string, DefinicaoAcao>} */
export const ACOES_NAVEGACAO = {
  dashboard_executivo: {
    modulo: MODULOS.IFOOD_DASHBOARD, permissao: PERMISSOES.DASHBOARD_EXECUTIVO_VER,
    paramsPermitidos: [], paramsObrigatorios: [],
    rotulo: () => "Abrir Dashboard Executivo",
  },
  products_cmv: {
    modulo: MODULOS.PRODUTOS_CMV, permissao: PERMISSOES.CMV_VER,
    paramsPermitidos: [], paramsObrigatorios: [],
    rotulo: () => "Abrir Produtos / CMV",
  },
  product_detail: {
    modulo: MODULOS.PRODUTOS_CMV, permissao: PERMISSOES.CMV_VER,
    paramsPermitidos: ["productName"], paramsObrigatorios: ["productName"],
    rotulo: (p) => `Abrir ${p.productName}`,
  },
  ingredients: {
    modulo: MODULOS.INGREDIENTS, permissao: PERMISSOES.INSUMOS_VER,
    paramsPermitidos: [], paramsObrigatorios: [],
    rotulo: () => "Abrir Insumos",
  },
  ingredient_detail: {
    modulo: MODULOS.INGREDIENTS, permissao: PERMISSOES.INSUMOS_VER,
    paramsPermitidos: ["ingredientName"], paramsObrigatorios: ["ingredientName"],
    rotulo: (p) => `Abrir ${p.ingredientName}`,
  },
  parser: {
    modulo: MODULOS.PARSER_FOOD_DELIVERY, permissao: PERMISSOES.PARSER_FD_VER,
    paramsPermitidos: [], paramsObrigatorios: [],
    rotulo: () => "Abrir Parser Food Delivery",
  },
  parser_cancelamentos: {
    modulo: MODULOS.PARSER_FOOD_DELIVERY, permissao: PERMISSOES.PARSER_FD_VER,
    paramsPermitidos: [], paramsObrigatorios: [],
    rotulo: () => "Abrir Cancelamentos",
  },
  parser_order: {
    modulo: MODULOS.PARSER_FOOD_DELIVERY, permissao: PERMISSOES.PARSER_FD_VER,
    paramsPermitidos: ["orderNumber"], paramsObrigatorios: ["orderNumber"],
    rotulo: (p) => `Abrir Pedido #${p.orderNumber}`,
  },
};

/** Nomes válidos de target — usado no enum do input_schema da tool. */
export const TARGETS_VALIDOS = Object.keys(ACOES_NAVEGACAO);

/**
 * Resolve uma sugestão de navegação — ou devolve `null` (nunca lança) quando
 * o target não existe, o usuário não tem módulo/permissão pro destino, ou um
 * parâmetro obrigatório está ausente. Silencioso de propósito: uma sugestão
 * inválida/sem acesso é o mesmo que "não sugerir nada", nunca um erro que
 * derruba a interação.
 *
 * @param {{target: unknown, params?: Record<string, unknown>, acesso: import('../../middlewares/auth.js').AcessoContexto|undefined}} p
 * @returns {{type: 'navigate', target: string, label: string, params: Record<string,string>}|null}
 */
export function resolverAcao({ target, params, acesso }) {
  const alvo = String(target ?? "");
  const def = ACOES_NAVEGACAO[alvo];
  if (!def) return null;

  if (!acesso) return null;
  if (!acesso.impersonando) {
    if (!acesso.modulos.includes(def.modulo)) return null;
    if (!temPermissao(acesso.permissoes, def.permissao)) return null;
  }

  // Lista branca POR TARGET — um orderNumber mandado num target que só
  // aceita productName nunca sobrevive, mesmo que o modelo mande os três.
  const paramsFiltrados = {};
  for (const chave of def.paramsPermitidos) {
    const valor = textoCurtoOpcional(params?.[chave]);
    if (valor) paramsFiltrados[chave] = valor;
  }
  for (const obrigatorio of def.paramsObrigatorios) {
    if (!paramsFiltrados[obrigatorio]) return null; // parâmetro essencial ausente -> não sugere
  }

  return { type: "navigate", target: alvo, label: def.rotulo(paramsFiltrados), params: paramsFiltrados };
}
