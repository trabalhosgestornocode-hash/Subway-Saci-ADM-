// Estado global do app. Único ponto de verdade da UI.

/**
 * @typedef {object} Sessao
 * @property {{id: string, nome: string, email: string, superadmin: boolean}|null} usuario
 * @property {boolean} superadmin
 * @property {Array<object>} acessos           empresas/unidades disponíveis
 * @property {{id: string, nome: string, logoUrl: string|null, status: string}|null} empresa
 * @property {{id: string, nome: string}|null} unidade
 * @property {string|null} papel
 * @property {string|null} papelRotulo
 * @property {string[]} permissoes
 * @property {boolean} impersonando
 */

export const state = {
  // Sessão e contexto. O `usuario` é a identidade (login); `empresa`/`unidade`
  // são o contexto escolhido depois. Antes, `usuario` era um e-mail solto e
  // `unidade` era a string fixa "Matriz" — as duas coisas viraram estado real.
  /** @type {Sessao} */
  sessao: {
    usuario: null,
    superadmin: false,
    acessos: [],
    empresa: null,
    unidade: null,
    papel: null,
    papelRotulo: null,
    permissoes: [],
    impersonando: false,
  },

  // Compatibilidade: views antigas leem state.usuario / state.unidade. São
  // espelhos preenchidos no boot — a fonte é state.sessao.
  usuario: null,
  unidade: "—",

  // navegação
  rota: "dashboard",
  telaAdmin: "dashboard",

  // filtros globais
  canal: "balcao",
  tabela: "A",

  // filtros da tabela de produtos (client-side)
  busca: "",
  filtroStatus: "todos", // todos | saudavel | atencao | critico

  // dados
  linhas: [],           // linhas de CMV mescladas com categoria
  carregando: false,
  erro: null,
  atualizadoEm: null,
};

// Retorna as linhas aplicando busca + filtro de status (não altera o estado)
export function linhasFiltradas() {
  const termo = state.busca.trim().toLowerCase();
  return state.linhas.filter((r) => {
    const passaBusca = !termo || String(r.nome ?? "").toLowerCase().includes(termo);
    if (!passaBusca) return false;
    if (state.filtroStatus === "todos") return true;
    return r._status?.chave === state.filtroStatus;
  });
}
