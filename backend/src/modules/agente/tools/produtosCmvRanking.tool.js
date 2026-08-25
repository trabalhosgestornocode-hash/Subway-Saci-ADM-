// Tool "listar_produtos_cmv" — ranking/listagem de produtos por CMV, custo,
// margem ou preço (Fase 2A). Read-only, sem N+1: 1 consulta na view oficial
// (vw_produto_margem, via cmv.service.js) + 1 consulta em `produtos` para
// categoria/ativo (a view não expõe esses campos) — nunca 1 consulta por
// produto do ranking.
//
// IMPORTANTE (causalidade — ver system prompt): esta tool NÃO tem volume
// vendido. Um produto no topo do ranking de CMV% é um FATO sobre a ficha
// dele, não uma prova de que ele é o maior responsável pelo CMV total da
// operação — isso a description da tool já avisa Claude explicitamente.
import { ApiError } from "../../../shared/ApiError.js";
import { MODULOS } from "../../../shared/modulos.js";
import { PERMISSOES } from "../../../shared/permissoes.js";
import { garantirAcessoModulo, garantirPermissao } from "../agenteAcesso.js";
import { supabase } from "../../../config/supabase.js";
import * as cmvService from "../../cmv/cmv.service.js";
import { resolverTabelaComercialUnidade } from "../../../shared/tabelaComercial.js";

/** Trava contra o modelo pedir uma lista gigante — nunca mais que isto, mesmo se solicitado. */
export const MAX_PRODUTOS_TOOL = 50;
const LIMITE_PADRAO = 10;

const TIPOS_PRODUTO = ["sanduiche", "salada", "bebida", "sobremesa", "chips", "adicional", "acompanhamento", "combo", "submontagem", "outro"];
const CANAIS_VALIDOS = ["balcao", "ifood", "uber", "app", "outro"];
/** Só estes 4 campos são ordenáveis — nenhum nome de coluna vindo do modelo chega perto de uma query. */
const CAMPOS_ORDENACAO = { cmv_percentual: "cmvPercentual", custo: "custoTotal", margem_reais: "margemReais", preco: "precoVenda" };

export const definicao = {
  name: "listar_produtos_cmv",
  description:
    "Lista/ranqueia produtos do catálogo (Produtos/CMV) por CMV%, custo, margem ou preço de venda — use para perguntas de comparação ou ranking (ex.: \"quais produtos têm maior CMV\", \"os 5 mais críticos\", \"qual produto tem maior custo\"). Por padrão retorna só produtos ATIVOS, ordenados por CMV% do maior para o menor, limitado a 10. Os dados vêm da mesma fonte oficial que já alimenta o dashboard Produtos/CMV — nunca é recalculado aqui. IMPORTANTE: esta ferramenta NÃO tem informação de volume vendido — um produto aparecer no topo do ranking de CMV NÃO prova que ele seja o maior responsável pelo CMV total da operação (isso depende também de quanto dele foi vendido, que esta ferramenta não sabe).",
  input_schema: {
    type: "object",
    properties: {
      categoria: { type: "string", enum: TIPOS_PRODUTO, description: "Filtra por categoria/tipo do produto. Omitir para todas as categorias." },
      ativo: { type: "boolean", description: "true (padrão) = só produtos ativos. false = só inativos." },
      canal: { type: "string", enum: CANAIS_VALIDOS, description: "Canal de venda usado para preço/CMV. Padrão: balcao (sem comissão de canal — CMV mais 'puro', só custo/preço)." },
      ordenarPor: { type: "string", enum: Object.keys(CAMPOS_ORDENACAO), description: "Campo de ordenação. Padrão: cmv_percentual." },
      ordem: { type: "string", enum: ["asc", "desc"], description: "Direção. Padrão: desc (maior primeiro)." },
      limite: { type: "integer", description: `Quantos produtos retornar (máximo ${MAX_PRODUTOS_TOOL}). Padrão: ${LIMITE_PADRAO}.` },
    },
    additionalProperties: false,
  },
};

/**
 * @param {{categoria?: string, ativo?: boolean, canal?: string, ordenarPor?: string, ordem?: string, limite?: number}} input
 * @param {{organizacaoId: string, unidadeId: string|null, acesso: object}} contexto
 * @param {{listarMargens: typeof cmvService.listarMargens, listarProdutosMeta: Function, resolverTabela: Function}} [deps] injeção para teste.
 */
export async function executar(
  input,
  { organizacaoId, unidadeId, acesso },
  deps = { listarMargens: cmvService.listarMargens, listarProdutosMeta: listarProdutosMetaPadrao, resolverTabela: resolverTabelaPadrao },
) {
  garantirAcessoModulo(acesso, MODULOS.PRODUTOS_CMV);
  garantirPermissao(acesso, PERMISSOES.CMV_VER);

  const categoria = TIPOS_PRODUTO.includes(input?.categoria) ? input.categoria : null;
  const canal = CANAIS_VALIDOS.includes(input?.canal) ? input.canal : "balcao";
  const apenasAtivos = input?.ativo !== false;

  const tabela = await deps.resolverTabela({ unidadeId, canal });
  const [linhasMargem, produtosMeta] = await Promise.all([
    deps.listarMargens({ organizacaoId, canal, tabela: tabela ?? undefined }),
    deps.listarProdutosMeta({ organizacaoId }),
  ]);

  const resultado = montarRanking({
    linhasMargem, produtosMeta, categoria, apenasAtivos,
    ordenarPor: input?.ordenarPor, ordem: input?.ordem, limite: input?.limite,
  });

  return { canal, tabelaResolvida: tabela ?? null, ...resultado };
}

/**
 * Agrupa por produto (1 linha por produto — nunca 1 por canal/tabela),
 * filtra, ordena e limita. Pura/testável — nenhum I/O aqui.
 * @param {{linhasMargem: any[], produtosMeta: any[], categoria?: string|null, apenasAtivos?: boolean, ordenarPor?: string, ordem?: string, limite?: number}} p
 */
export function montarRanking({ linhasMargem, produtosMeta, categoria = null, apenasAtivos = true, ordenarPor, ordem, limite }) {
  const metaPorId = new Map((produtosMeta ?? []).map((p) => [p.id, p]));
  const grupos = new Map();
  for (const l of linhasMargem ?? []) {
    if (!grupos.has(l.produto_id)) grupos.set(l.produto_id, []);
    grupos.get(l.produto_id).push(l);
  }

  let itens = [...grupos.entries()].map(([produtoId, linhas]) => {
    const meta = metaPorId.get(produtoId) ?? {};
    // Se o produto tem preço em mais de uma tabela, escolhe a de nome
    // "menor" (determinístico) e sinaliza — nunca finge que só existe uma.
    const ordenadas = [...linhas].sort((a, b) => String(a.tabela ?? "").localeCompare(String(b.tabela ?? "")));
    const escolhida = ordenadas[0];
    return {
      produtoId,
      nome: escolhida.nome,
      categoria: meta.tipo ?? null,
      ativo: meta.ativo !== false,
      tabelaUtilizada: escolhida.tabela ?? null,
      outrasTabelasDisponiveis: ordenadas.length > 1,
      custoTotal: escolhida.custo != null ? Number(escolhida.custo) : null,
      precoVenda: escolhida.preco != null ? Number(escolhida.preco) : null,
      margemReais: escolhida.lucro_liquido != null ? Number(escolhida.lucro_liquido) : null,
      cmvPercentual: escolhida.cmv_pct != null ? Number(escolhida.cmv_pct) : null,
    };
  });

  if (categoria) itens = itens.filter((i) => i.categoria === categoria);
  itens = itens.filter((i) => i.ativo === apenasAtivos);

  const campo = CAMPOS_ORDENACAO[ordenarPor] ?? "cmvPercentual";
  const dir = ordem === "asc" ? 1 : -1;
  itens.sort((a, b) => {
    const va = a[campo], vb = b[campo];
    // Sem dado NUNCA vira 0 — vai sempre pro fim, em qualquer direção.
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va - vb) * dir;
  });

  const limiteAplicado = Math.min(MAX_PRODUTOS_TOOL, Math.max(1, Number(limite) || LIMITE_PADRAO));
  return { itens: itens.slice(0, limiteAplicado), totalDisponivel: itens.length, limiteAplicado };
}

async function listarProdutosMetaPadrao({ organizacaoId }) {
  const { data, error } = await supabase.from("produtos").select("id, tipo, ativo").eq("organizacao_id", organizacaoId);
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

/**
 * Tabela de preço OFICIAL da unidade atual (nunca escolhida pelo modelo, nunca
 * "primeira encontrada"). Null se agregado/sem configuração. Delega ao
 * resolver central (backend/src/shared/tabelaComercial.js) — nenhuma lógica
 * de "qual coluna ler" duplicada aqui.
 */
async function resolverTabelaPadrao({ unidadeId, canal }) {
  const { tabelaOficial } = await resolverTabelaComercialUnidade({ unidadeId, canal });
  return tabelaOficial;
}
