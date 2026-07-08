// Estado global do app. Único ponto de verdade da UI.
export const state = {
  // sessão
  usuario: null,
  unidade: "Matriz",

  // navegação
  rota: "dashboard",

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
