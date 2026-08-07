// Permissões efetivas por papel, POR EMPRESA.
//
// O papel não pertence ao usuário global: pertence ao vínculo usuário<->empresa
// (usuarios_organizacoes.papel). O mesmo João pode ser organization_admin na
// Subway Saci e finance na Subway Fortaleza — e é este mapa que traduz cada
// um desses papéis em permissões concretas.
//
// As permissões são gravadas na sessão (sessoes_contexto.permissoes) no momento
// da seleção da empresa, e é a linha da sessão que o middleware relê. Mudar um
// papel no painel, portanto, exige revogar as sessões daquele vínculo — o
// módulo de plataforma faz isso.

/**
 * @typedef {'platform_superadmin'|'organization_admin'|'unit_manager'|'finance'|'operations'|'viewer'} PapelAcesso
 */

/** Todas as permissões conhecidas. Fonte única — use estas constantes. */
export const PERMISSOES = {
  DASHBOARD_VER: "dashboard.ver",
  PRODUTOS_VER: "produtos.ver",
  PRODUTOS_EDITAR: "produtos.editar",
  INSUMOS_VER: "insumos.ver",
  INSUMOS_EDITAR: "insumos.editar",
  CMV_VER: "cmv.ver",
  VENDAS_VER: "vendas.ver",
  VENDAS_IMPORTAR: "vendas.importar",
  VENDAS_EDITAR: "vendas.editar",
  INTEGRACOES_VER: "integracoes.ver",
  INTEGRACOES_GERENCIAR: "integracoes.gerenciar",
  USUARIOS_VER: "usuarios.ver",
  USUARIOS_GERENCIAR: "usuarios.gerenciar",
  CONFIG_VER: "configuracoes.ver",
  CONFIG_GERENCIAR: "configuracoes.gerenciar",
  FINANCEIRO_VER: "financeiro.ver",
  // Dashboard Executivo (lançamento financeiro diário por unidade).
  DASHBOARD_EXECUTIVO_VER: "dashboard_executivo.ver",
  // Criar lançamento novo + editar livremente enquanto status = 'rascunho'.
  DASHBOARD_EXECUTIVO_LANCAR: "dashboard_executivo.lancar",
  // Editar um lançamento JÁ FINALIZADO (sempre com motivo + auditoria) e
  // lançar valor negativo em "outras deduções" (ajuste a favor da unidade).
  DASHBOARD_EXECUTIVO_CORRIGIR: "dashboard_executivo.corrigir",
  // Trocar o modelo logístico do iFood da unidade (Marketplace/Full Service).
  // unit_manager NÃO tem — só vê o modelo (via DASHBOARD_EXECUTIVO_VER).
  DASHBOARD_EXECUTIVO_CONFIGURAR: "dashboard_executivo.configurar",
  // Resetar (excluir de verdade) o lançamento de um dia — SÓ funciona em
  // unidade marcada como `eh_teste = true` (o service revalida isso sempre,
  // mesmo com a permissão concedida). Nunca disponível em unidade real.
  DASHBOARD_EXECUTIVO_RESETAR_TESTE: "dashboard_executivo.resetar_teste",
};

const P = PERMISSOES;

/** Só leitura — a base de todos os papéis. */
const LEITURA = [
  P.DASHBOARD_VER, P.PRODUTOS_VER, P.INSUMOS_VER, P.CMV_VER, P.VENDAS_VER,
  P.INTEGRACOES_VER, P.DASHBOARD_EXECUTIVO_VER,
];

/** @type {Record<string, string[]>} */
const POR_PAPEL = {
  organization_admin: Object.values(P),

  unit_manager: [
    ...LEITURA,
    P.PRODUTOS_EDITAR, P.INSUMOS_EDITAR, P.VENDAS_IMPORTAR, P.VENDAS_EDITAR,
    P.INTEGRACOES_GERENCIAR, P.USUARIOS_VER, P.CONFIG_VER,
    P.DASHBOARD_EXECUTIVO_LANCAR,
  ],

  finance: [...LEITURA, P.FINANCEIRO_VER, P.CONFIG_VER, P.DASHBOARD_EXECUTIVO_LANCAR, P.DASHBOARD_EXECUTIVO_CORRIGIR, P.DASHBOARD_EXECUTIVO_CONFIGURAR, P.DASHBOARD_EXECUTIVO_RESETAR_TESTE],

  operations: [...LEITURA, P.PRODUTOS_EDITAR, P.INSUMOS_EDITAR, P.VENDAS_IMPORTAR, P.DASHBOARD_EXECUTIVO_LANCAR, P.DASHBOARD_EXECUTIVO_CORRIGIR, P.DASHBOARD_EXECUTIVO_CONFIGURAR, P.DASHBOARD_EXECUTIVO_RESETAR_TESTE],

  viewer: [...LEITURA],
};

/** Papéis atribuíveis a um vínculo. `platform_superadmin` NÃO está aqui: é global. */
export const PAPEIS_VINCULO = Object.keys(POR_PAPEL);

/** Rótulos em pt-BR — usados no painel e nas telas de seleção. */
export const PAPEIS_ROTULO = {
  platform_superadmin: "SuperAdmin da Plataforma",
  organization_admin: "Administrador",
  unit_manager: "Gestor de Unidade",
  finance: "Financeiro",
  operations: "Operação",
  viewer: "Consulta",
};

/**
 * Permissões efetivas de um papel de vínculo.
 * Papel desconhecido cai em `viewer` — na dúvida, o mínimo.
 * @param {string} papel
 * @returns {string[]}
 */
export function permissoesDoPapel(papel) {
  return [...(POR_PAPEL[papel] ?? POR_PAPEL.viewer)];
}

/**
 * @param {string[]|undefined|null} permissoes
 * @param {string} necessaria
 * @returns {boolean}
 */
export function temPermissao(permissoes, necessaria) {
  return Array.isArray(permissoes) && permissoes.includes(necessaria);
}

/** @param {string} papel */
export function papelValido(papel) {
  return PAPEIS_VINCULO.includes(papel);
}

/** @param {string} papel */
export function rotuloPapel(papel) {
  return PAPEIS_ROTULO[papel] ?? papel;
}
