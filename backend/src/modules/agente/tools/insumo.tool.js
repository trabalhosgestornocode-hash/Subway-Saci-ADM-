// Tool "consultar_insumo" — busca UM insumo (matéria-prima) pelo nome e
// devolve custo/unidade/status, além dos produtos que o utilizam.
//
// REGRA DE OURO (código calcula, IA interpreta): reaproveita
// produtos/custo.js#carregarGrafo (o MESMO grafo de custo que Produtos/CMV e
// o recálculo em cascata usam) e insumos.service.js#listarHistorico —
// nenhuma fórmula nova. Um único carregarGrafo() por consulta (nunca N+1): a
// partir dele calculamos tanto os produtos afetados (direta OU
// indiretamente, via submontagem — produtosAfetadosPorInsumo) quanto, para
// cada um, a linha DIRETA da ficha desse insumo quando ela existir
// (quantidade/unidade/custo aplicado — usoDiretoDeInsumo).
//
// "Quais produtos usam queijo?" e "consultar o queijo" são a MESMA pergunta
// nesta tool — por isso não existe uma tool separada "produtos por insumo":
// ela faria a mesma busca por nome e devolveria dado que este retorno já
// traz.
//
// SEGURANÇA DE TENANT: mesma regra das demais tools — organizacaoId vem
// SEMPRE de `contexto`, nunca de `input`.
import { ApiError } from "../../../shared/ApiError.js";
import { MODULOS } from "../../../shared/modulos.js";
import { PERMISSOES } from "../../../shared/permissoes.js";
import { garantirAcessoModulo, garantirPermissao } from "../agenteAcesso.js";
import { supabase } from "../../../config/supabase.js";
import { CATEGORIA_ROTULO, listarHistorico as listarHistoricoPadrao } from "../../insumos/insumos.service.js";
import { carregarGrafo, produtosAfetadosPorInsumo, custoTotalProduto, usoDiretoDeInsumo } from "../../produtos/custo.js";
import { escolherCandidato } from "./produtosCmvBusca.js";

/** Trava contra o modelo pedir a lista inteira de produtos afetados por um insumo muito usado (ex.: pão). */
export const MAX_PRODUTOS_TOOL = 30;

export const definicao = {
  name: "consultar_insumo",
  description:
    "Busca UM insumo (matéria-prima) do catálogo pelo nome e devolve seu custo por unidade-base, unidade de medida, categoria e status (ativo/inativo), além da lista de PRODUTOS que o utilizam (direta ou indiretamente, via submontagem) — use para perguntas como \"quanto custa o queijo?\", \"qual o custo atual do frango?\", \"quais insumos estão inativos?\" (chame uma vez por insumo suspeito, ou prefira listar_insumos para uma lista), \"quais produtos usam queijo?\", \"quais produtos são afetados por este insumo?\". Aceita nome parcial ou com pequenos erros de grafia (ex.: \"frango\", \"queijo chedar\"). Se houver mais de um insumo plausível para o nome informado, a ferramenta devolve a lista de candidatos em vez de escolher um sozinho — nesse caso, pergunte ao usuário qual ele quis dizer antes de responder.",
  input_schema: {
    type: "object",
    properties: {
      insumo: { type: "string", description: "Nome (completo ou parcial) do insumo, como o usuário escreveu — ex.: \"queijo\", \"frango\", \"pão\"." },
    },
    required: ["insumo"],
    additionalProperties: false,
  },
};

/**
 * @param {{insumo?: string}} input — só o que o MODELO controla.
 * @param {{organizacaoId: string, unidadeId: string|null, acesso: object}} contexto — sempre do backend.
 * @param {{buscarCandidatos: Function, carregarGrafo: typeof carregarGrafo, listarHistorico: typeof listarHistoricoPadrao}} [deps] injeção para teste.
 */
export async function executar(
  input,
  { organizacaoId, acesso },
  deps = { buscarCandidatos: buscarCandidatosPadrao, carregarGrafo, listarHistorico: listarHistoricoPadrao },
) {
  garantirAcessoModulo(acesso, MODULOS.INGREDIENTS);
  garantirPermissao(acesso, PERMISSOES.INSUMOS_VER);

  const termoBusca = String(input?.insumo ?? "").trim();
  if (!termoBusca) throw ApiError.badRequest("Informe o nome do insumo a consultar.");

  const candidatos = await deps.buscarCandidatos({ organizacaoId, termoBusca });
  const escolha = escolherCandidato(candidatos, termoBusca);

  if (escolha.status === "nao_encontrado") {
    return { encontrado: false, motivo: "nao_encontrado", termoBuscado: termoBusca };
  }
  if (escolha.status === "ambiguo") {
    return {
      encontrado: false,
      motivo: "ambiguo",
      termoBuscado: termoBusca,
      candidatos: escolha.candidatos.map((c) => ({ nome: c.nome, categoria: c.tipo ?? null })),
    };
  }

  // `escolherCandidato` é genérico (busca por nome) — o campo do resultado
  // se chama "produto" por ter nascido em produtoCmv.tool.js, mas serve para
  // qualquer entidade buscável por nome. Aqui é o insumo escolhido.
  const { id: insumoId } = escolha.produto;

  const [grafo, historico] = await Promise.all([
    deps.carregarGrafo(organizacaoId),
    deps.listarHistorico({ organizacaoId, insumoId }),
  ]);

  const ins = grafo.insumoById.get(insumoId);
  if (!ins) throw ApiError.notFound("Insumo não encontrado.");

  const custoUnitario = ins.preco_unitario != null ? Number(ins.preco_unitario) : null;
  // A mais recente alteração de preço com variação calculável (o histórico já
  // vem ordenado do mais novo para o mais antigo — ver insumos.service.js).
  const ultimaAlteracao = (historico.itens ?? []).find((h) => h.variacao_pct != null) ?? null;

  const afetadosIds = produtosAfetadosPorInsumo(insumoId, grafo);
  const produtosOrdenados = afetadosIds
    .map((pid) => {
      const uso = usoDiretoDeInsumo(pid, insumoId, grafo);
      return {
        nome: grafo.nomeProdById.get(pid) ?? "Produto",
        usoDireto: uso != null,
        quantidade: uso?.quantidade ?? null,
        unidade: uso?.unidade ?? null,
        custoAplicado: uso?.custoAplicado ?? null,
        custoTotalProduto: custoTotalProduto(pid, grafo),
      };
    })
    // Maior impacto em R$ primeiro — sem custo aplicado (uso só indireto) vai pro fim.
    .sort((a, b) => (b.custoAplicado ?? -1) - (a.custoAplicado ?? -1));

  return {
    encontrado: true,
    insumo: {
      nome: ins.nome,
      categoria: ins.tipo ?? null,
      categoriaRotulo: CATEGORIA_ROTULO[ins.tipo] ?? ins.tipo ?? null,
      unidadeBase: ins.unidade_medida ?? "un",
      custoUnitario,
      semCusto: custoUnitario == null || custoUnitario <= 0,
      ativo: ins.ativo !== false,
      // Só existe quando há uma alteração de preço REAL registrada
      // (insumo_historico). Se a tabela/migration ainda não estiver
      // disponível no ambiente (historico.pendente) ou não houver nenhuma
      // alteração com variação calculável, vem null — nunca inventa uma
      // tendência de preço sem dado real.
      ultimaAlteracaoPreco: historico.pendente || !ultimaAlteracao ? null : {
        data: ultimaAlteracao.created_at,
        variacaoPct: ultimaAlteracao.variacao_pct != null ? Number(ultimaAlteracao.variacao_pct) : null,
        custoAnterior: ultimaAlteracao.custo_anterior != null ? Number(ultimaAlteracao.custo_anterior) : null,
        custoNovo: ultimaAlteracao.custo_novo != null ? Number(ultimaAlteracao.custo_novo) : null,
      },
    },
    produtosAfetados: {
      total: produtosOrdenados.length,
      itens: produtosOrdenados.slice(0, MAX_PRODUTOS_TOOL),
      truncado: produtosOrdenados.length > MAX_PRODUTOS_TOOL,
    },
  };
}

/**
 * Candidatos amplos por nome (1º token via ilike, mesma técnica de
 * produtoCmv.tool.js) — o refino/desambiguação acontece em produtosCmvBusca.js.
 */
async function buscarCandidatosPadrao({ organizacaoId, termoBusca }) {
  const primeiroToken = termoBusca.split(/\s+/)[0] ?? termoBusca;
  const { data, error } = await supabase
    .from("insumos")
    .select("id, nome, tipo, ativo")
    .eq("organizacao_id", organizacaoId)
    .ilike("nome", `%${primeiroToken}%`);
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}
