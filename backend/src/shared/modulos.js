// Catálogo de módulos e módulos habilitados por empresa.
//
// Mesmo espírito de permissoes.js: fonte única das constantes, usadas tanto
// pelo backend (rotas, sessão) quanto — indiretamente — pelo frontend
// (frontend/src/config.js#MENU replica os mesmos ids nas entradas gateadas).
//
// Diferença de permissoes.js: permissão é POR PAPEL (fixa em código); módulo
// é POR EMPRESA (dado, vive em `organizacao_modulos`). O catálogo de ids e
// nomes, porém, é fixo em código — não dá para uma empresa "inventar" um
// módulo novo, só habilitar/desabilitar os que existem.

import { supabase } from "../config/supabase.js";
import { ApiError } from "./ApiError.js";

/** Identificadores estáveis. Use estas constantes em vez de string solta. */
export const MODULOS = {
  DASHBOARD: "dashboard",
  PRODUTOS_CMV: "products_cmv",
  INGREDIENTS: "ingredients",
  INVENTORY: "inventory",
  SALES: "sales",
  IFOOD_DASHBOARD: "ifood_dashboard",
  MONTHLY_BONUS: "monthly_bonus",
  DISTRIBUTORS: "distributors",
  MARTIN_BROWER: "martin_brower",
  SWFAST: "swfast",
  IFOOD: "ifood",
  COCA_COLA: "coca_cola",
  HORTIFRUTI: "hortifruti",
};

/**
 * Catálogo completo — espelha o seed da migration 030. `categoria` alimenta
 * o agrupamento do checklist de módulos no painel (OPERAÇÃO/INTEGRAÇÕES).
 * @type {Array<{id: string, nome: string, categoria: 'operacao'|'integracao', ordem: number}>}
 */
export const CATALOGO_MODULOS = [
  { id: MODULOS.DASHBOARD, nome: "Dashboard", categoria: "operacao", ordem: 1 },
  { id: MODULOS.PRODUTOS_CMV, nome: "Produtos / CMV", categoria: "operacao", ordem: 2 },
  { id: MODULOS.INGREDIENTS, nome: "Insumos", categoria: "operacao", ordem: 3 },
  { id: MODULOS.INVENTORY, nome: "Estoque", categoria: "operacao", ordem: 4 },
  { id: MODULOS.SALES, nome: "Vendas", categoria: "operacao", ordem: 5 },
  { id: MODULOS.IFOOD_DASHBOARD, nome: "Dashboard iFood", categoria: "operacao", ordem: 6 },
  { id: MODULOS.MONTHLY_BONUS, nome: "Bonificação Mensal", categoria: "operacao", ordem: 7 },
  { id: MODULOS.DISTRIBUTORS, nome: "Distribuidoras", categoria: "operacao", ordem: 8 },
  { id: MODULOS.MARTIN_BROWER, nome: "Martin Brower", categoria: "integracao", ordem: 9 },
  { id: MODULOS.SWFAST, nome: "SWFast / PDV", categoria: "integracao", ordem: 10 },
  { id: MODULOS.IFOOD, nome: "iFood", categoria: "integracao", ordem: 11 },
  { id: MODULOS.COCA_COLA, nome: "Coca-Cola", categoria: "integracao", ordem: 12 },
  { id: MODULOS.HORTIFRUTI, nome: "Cláudia Hortifruti", categoria: "integracao", ordem: 13 },
];

const IDS_VALIDOS = new Set(CATALOGO_MODULOS.map((m) => m.id));

/** @param {string} id */
export function rotuloModulo(id) {
  return CATALOGO_MODULOS.find((m) => m.id === id)?.nome ?? id;
}

/**
 * Módulos habilitados de uma empresa. Alimenta a sessão no momento da
 * seleção de contexto — é o que `requireModulo` acaba checando.
 * @param {string} organizacaoId
 * @returns {Promise<string[]>}
 */
export async function modulosDaEmpresa(organizacaoId) {
  const { data, error } = await supabase
    .from("organizacao_modulos").select("modulo_id").eq("organizacao_id", organizacaoId);
  if (error) throw ApiError.internal(error.message);
  return (data ?? []).map((r) => r.modulo_id);
}

/**
 * Valida uma lista de ids de módulo vinda do cliente. Rejeita ids fora do
 * catálogo — uma empresa não pode ganhar acesso a um módulo que não existe.
 * @param {unknown} lista
 * @returns {string[]} ids únicos, validados
 */
export function validarModulos(lista) {
  if (!Array.isArray(lista)) throw ApiError.badRequest("Módulos deve ser uma lista.");
  const ids = [...new Set(lista.map((x) => String(x)))];
  const invalidos = ids.filter((id) => !IDS_VALIDOS.has(id));
  if (invalidos.length) {
    throw ApiError.badRequest(`Módulo(s) desconhecido(s): ${invalidos.join(", ")}.`);
  }
  return ids;
}

/**
 * Calcula quais módulos entram e quais saem, dado o estado atual e o
 * desejado. Função PURA (sem I/O) de propósito: separa a decisão (o quê
 * mudou) da escrita (`definirModulosEmpresa`), o que permite testar a lógica
 * do diff sem tocar o banco.
 * @param {string[]} atuais
 * @param {string[]} desejados
 * @returns {{habilitados: string[], desabilitados: string[]}}
 */
export function calcularDiffModulos(atuais, desejados) {
  const atuaisSet = new Set(atuais);
  const desejadosSet = new Set(desejados);
  return {
    habilitados: desejados.filter((id) => !atuaisSet.has(id)),
    desabilitados: atuais.filter((id) => !desejadosSet.has(id)),
  };
}

/**
 * Substitui os módulos habilitados de uma empresa pelo conjunto informado
 * (`moduloIds`), calculando o diff contra o estado atual.
 *
 * NÃO audita nem revoga sessões — isso é responsabilidade de quem chama
 * (plataforma.empresas.service.js), que sabe o ator e o motivo. Esta função
 * só aplica a escrita e devolve o que mudou, para o chamador decidir o que
 * logar.
 *
 * @param {string} organizacaoId
 * @param {string[]} moduloIds já validados (ver `validarModulos`)
 * @param {string|null} [habilitadoPor] id do superadmin, para auditoria futura na própria linha
 * @returns {Promise<{habilitados: string[], desabilitados: string[]}>}
 */
export async function definirModulosEmpresa(organizacaoId, moduloIds, habilitadoPor = null) {
  const atuais = await modulosDaEmpresa(organizacaoId);
  const { habilitados, desabilitados } = calcularDiffModulos(atuais, moduloIds);

  if (habilitados.length) {
    const { error } = await supabase.from("organizacao_modulos").insert(
      habilitados.map((modulo_id) => ({ organizacao_id: organizacaoId, modulo_id, habilitado_por: habilitadoPor }))
    );
    if (error) throw ApiError.internal(error.message);
  }
  if (desabilitados.length) {
    const { error } = await supabase.from("organizacao_modulos")
      .delete().eq("organizacao_id", organizacaoId).in("modulo_id", desabilitados);
    if (error) throw ApiError.internal(error.message);
  }

  return { habilitados, desabilitados };
}

/**
 * Insere de uma vez os módulos escolhidos na criação de uma empresa. Difere
 * de `definirModulosEmpresa` por não calcular diff (a empresa é nova — não
 * há "atual" para comparar) e por tolerar lista vazia (empresa criada sem
 * módulo nenhum, o SuperAdmin libera depois pela aba Acessos).
 * @param {string} organizacaoId
 * @param {string[]} moduloIds já validados
 * @param {string|null} [habilitadoPor]
 */
export async function provisionarModulosEmpresa(organizacaoId, moduloIds, habilitadoPor = null) {
  if (!moduloIds.length) return;
  const { error } = await supabase.from("organizacao_modulos").insert(
    moduloIds.map((modulo_id) => ({ organizacao_id: organizacaoId, modulo_id, habilitado_por: habilitadoPor }))
  );
  if (error) throw ApiError.internal(error.message);
}
