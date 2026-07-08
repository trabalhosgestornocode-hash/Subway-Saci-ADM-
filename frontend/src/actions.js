import { toast } from "./utils.js";
import { abrirProdutoModal } from "./produtoModal.js";
import { abrirSimulador } from "./simuladorModal.js";
import { abrirEditarModal } from "./editarModal.js";

// Ações da tabela de produtos. Placeholders organizados — prontos para ligar ao backend.
// Cada função recebe a linha (produto) correspondente.
export const acoes = {
  ver: (row) => {
    if (row.produto_id) abrirProdutoModal(row.produto_id);
    else toast(`Produto "${row.nome}" sem identificador.`);
  },
  editar: (row) => {
    if (row.produto_id) abrirEditarModal(row.produto_id);
    else toast(`Produto "${row.nome}" sem identificador.`);
  },
  historico: (row) => {
    // Futuro: histórico de preço/custo do produto
    toast(`Histórico de "${row.nome}" — em breve.`);
  },
  simular: (row) => {
    abrirSimulador(row);
  },
};

export const ACOES_TABELA = [
  { chave: "ver", icon: "👁️", titulo: "Ver detalhes" },
  { chave: "editar", icon: "✏️", titulo: "Editar" },
  { chave: "historico", icon: "🕑", titulo: "Histórico" },
  { chave: "simular", icon: "🧮", titulo: "Simular preço" },
];
