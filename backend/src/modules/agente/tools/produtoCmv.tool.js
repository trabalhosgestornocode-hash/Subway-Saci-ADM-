// Tool "consultar_produto_cmv" — busca UM produto pelo nome e devolve custo,
// preço e CMV oficiais (Fase 2A).
//
// REGRA DE OURO (código calcula, IA interpreta): reaproveita
// cmv.service.js#margemProduto (a mesma view vw_produto_margem que alimenta
// a tela "Produtos/CMV" hoje) para preço/custo/CMV%, e
// produtos.service.js#obterProduto (junto com insumos.calc.js#statusFicha,
// já existente) só para saber se a ficha técnica está completa. Nenhuma
// fórmula nova.
//
// ARMADILHA REAL DO DADO: `vw_produto_margem.custo` SEMPRE usa o cálculo
// automático da ficha (fn_custo_produto) — nunca respeita `custo_manual`
// (um override que produtos.service.js#atualizarProduto permite configurar).
// Por isso o retorno usa o custo da VIEW (consistente com o cmv_pct/lucro
// que ela mesma calcula) e só sinaliza `custoManualConfigurado` quando
// existe um override — nunca mistura os dois números.
import { ApiError } from "../../../shared/ApiError.js";
import { MODULOS } from "../../../shared/modulos.js";
import { PERMISSOES } from "../../../shared/permissoes.js";
import { garantirAcessoModulo, garantirPermissao } from "../agenteAcesso.js";
import { supabase } from "../../../config/supabase.js";
import * as cmvService from "../../cmv/cmv.service.js";
import * as produtosService from "../../produtos/produtos.service.js";
import { escolherCandidato } from "./produtosCmvBusca.js";
import { resolverTabelasComerciaisUnidade } from "../../../shared/tabelaComercial.js";

export const definicao = {
  name: "consultar_produto_cmv",
  description:
    "Busca UM produto do catálogo (Produtos/CMV) pelo nome e devolve seu custo, preço de venda, CMV% oficiais (por canal de venda) e a FICHA TÉCNICA (lista de insumos/submontagens que compõem o produto, com quantidade, unidade, custo aplicado em R$ e participação percentual no custo total do produto — já ordenada do que mais pesa para o que menos pesa). Use também para perguntas como \"o que tem no BMT?\", \"qual a ficha técnica do X?\", \"quais insumos vão no Y?\", \"o que mais pesa no custo do X?\", \"quais insumos da ficha do X representam maior custo?\". Aceita nome parcial ou com pequenos erros de grafia (ex.: \"BMT\", \"frango teriaki\", \"cookie\"). Se houver mais de um produto plausível para o nome informado (ex.: vários tipos de cookie), a ferramenta devolve a lista de candidatos em vez de escolher um sozinho — nesse caso, pergunte ao usuário qual ele quis dizer antes de responder. Nunca confunda custo (o que custa produzir) com preço de venda (o que o cliente paga) — são campos diferentes no retorno. O retorno traz TODAS as combinações canal/tabela cadastradas para o produto em `precos[]`, cada uma marcada com `oficial: true/false` — `oficial: true` é a tabela comercial configurada na unidade atual (`tabelasOficiais`, também no retorno) para aquele canal. Se o usuário perguntar o preço/CMV \"no balcão\" ou \"no iFood\" sem citar uma tabela específica, responda com a linha `oficial: true` daquele canal — nunca a primeira da lista. Só use uma linha `oficial: false` se o usuário pedir explicitamente para comparar outra tabela, e deixe claro que é uma comparação, não a tabela oficial.",
  input_schema: {
    type: "object",
    properties: {
      produto: { type: "string", description: "Nome (completo ou parcial) do produto, como o usuário escreveu — ex.: \"BMT\", \"Frango Teriyaki\", \"cookie\"." },
    },
    required: ["produto"],
    additionalProperties: false,
  },
};

/**
 * @param {{produto?: string}} input — só o que o MODELO controla.
 * @param {{organizacaoId: string, unidadeId: string|null, acesso: object}} contexto — sempre do backend.
 * @param {{buscarCandidatos: Function, margemProduto: typeof cmvService.margemProduto, obterProduto: typeof produtosService.obterProduto, resolverTabelas: typeof resolverTabelasComerciaisUnidade}} [deps] injeção para teste.
 */
export async function executar(
  input,
  { organizacaoId, unidadeId, acesso },
  deps = {
    buscarCandidatos: buscarCandidatosPadrao, margemProduto: cmvService.margemProduto,
    obterProduto: produtosService.obterProduto, resolverTabelas: resolverTabelasComerciaisUnidade,
  },
) {
  garantirAcessoModulo(acesso, MODULOS.PRODUTOS_CMV);
  garantirPermissao(acesso, PERMISSOES.CMV_VER);

  const termoBusca = String(input?.produto ?? "").trim();
  if (!termoBusca) throw ApiError.badRequest("Informe o nome do produto a consultar.");

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
      candidatos: escolha.candidatos.map((c) => ({ nome: c.nome, tamanho: c.tamanho ?? null, categoria: c.tipo ?? null })),
    };
  }

  const { id: produtoId, nome, tipo, tamanho, ativo } = escolha.produto;
  const [linhasMargem, detalhe, tabelasOficiais] = await Promise.all([
    deps.margemProduto({ organizacaoId, produtoId }),
    deps.obterProduto({ organizacaoId, id: produtoId }),
    deps.resolverTabelas({ unidadeId }),
  ]);

  return {
    encontrado: true,
    produto: {
      nome,
      categoria: tipo ?? null,
      tamanho: tamanho ?? null,
      ativo: ativo !== false,
      quantidadeInsumos: detalhe.qtd_componentes ?? 0,
      possuiFichaTecnicaCompleta: detalhe.status_ficha?.ok === true,
      statusFicha: detalhe.status_ficha?.chave ?? null,
      custoManualConfigurado: detalhe.custo_manual != null,
      // Tabela comercial oficial da unidade atual, por canal — mesma fonte
      // que Dashboard/Produtos-CMV (resolverTabelaComercialUnidade). Null
      // quando a unidade não tem tabela configurada para o canal (ou nenhuma
      // unidade selecionada) — NUNCA "primeira tabela encontrada".
      tabelasOficiais: { balcao: tabelasOficiais.tabelaBalcao, ifood: tabelasOficiais.tabelaIfood },
      // Ficha técnica enxuta — já carregada por obterProduto acima, nenhuma
      // consulta nova. "insumo" = matéria-prima; "submontagem" = outro
      // produto usado como componente (ex.: um molho preparado à parte).
      //
      // COMPOSIÇÃO DE CUSTO (Etapa C — "o que mais pesa no custo do X"):
      // `custoAplicado` já vem calculado por componentesDiretos() (custo.js)
      // — nenhuma fórmula nova. `participacaoPctNoCusto` é só uma divisão
      // pura sobre dois números já calculados (custoAplicado / custo total
      // AUTOMÁTICO do produto — `detalhe.custo_calculado`, a MESMA base que
      // soma exatamente estes custoAplicado, por construção de
      // custoTotalProduto/componentesDiretos). Deliberadamente NUNCA contra
      // `detalhe.custo` (que pode ser custo_manual, um override que não bate
      // com a soma dos componentes — misturar os dois inventaria uma % sem
      // sentido). Só calculada para linhas ATIVAS (`ativo !== false`): uma
      // linha inativa não entra em custoTotalProduto, então sua participação
      // sobre esse total não existe — fica null, nunca uma % que não soma
      // com o resto. Ordenado do que mais pesa para o que menos pesa.
      fichaTecnica: (detalhe.ficha ?? [])
        .map((c) => {
          const custoAplicado = c.custo_aplicado != null ? Number(c.custo_aplicado) : null;
          const ativo = c.ativo !== false;
          const custoTotalAutomatico = Number(detalhe.custo_calculado);
          const participacaoPctNoCusto = ativo && custoAplicado != null && custoTotalAutomatico > 0
            ? Number(((custoAplicado / custoTotalAutomatico) * 100).toFixed(4))
            : null;
          return {
            nome: c.nome,
            tipo: c.tipo,
            quantidade: c.quantidade,
            unidade: c.unidade,
            ativo,
            custoAplicado,
            participacaoPctNoCusto,
          };
        })
        .sort((a, b) => (b.custoAplicado ?? -1) - (a.custoAplicado ?? -1)),
      // 1 entrada por canal/tabela de preço cadastrada — cada uma já vem com
      // custo/cmv_pct/lucro calculados pela MESMA view do dashboard oficial.
      precos: (linhasMargem ?? []).map((l) => ({
        canal: l.canal,
        tabela: l.tabela ?? null,
        // true só quando a linha bate com a tabela oficial DAQUELE canal —
        // nunca assume a primeira linha nem a ordem em que a view devolveu.
        oficial: l.canal === "balcao"
          ? (l.tabela ?? null) === tabelasOficiais.tabelaBalcao && tabelasOficiais.tabelaBalcao != null
          : l.canal === "ifood"
            ? (l.tabela ?? null) === tabelasOficiais.tabelaIfood && tabelasOficiais.tabelaIfood != null
            : false,
        custoTotal: l.custo != null ? Number(l.custo) : null,
        precoVenda: l.preco != null ? Number(l.preco) : null,
        comissaoPct: l.comissao_pct != null ? Number(l.comissao_pct) : null,
        margemReais: l.lucro_liquido != null ? Number(l.lucro_liquido) : null,
        cmvPercentual: l.cmv_pct != null ? Number(l.cmv_pct) : null,
        desatualizado: !!l.desatualizado,
      })),
    },
  };
}

/**
 * Candidatos amplos por nome (1º token via ilike, mesma técnica de
 * dashboardExecutivo.simulador.service.js#localizarProdutoReferencia) — o
 * refino/desambiguação acontece em produtosCmvBusca.js, não aqui.
 */
async function buscarCandidatosPadrao({ organizacaoId, termoBusca }) {
  const primeiroToken = termoBusca.split(/\s+/)[0] ?? termoBusca;
  const { data, error } = await supabase
    .from("produtos")
    .select("id, nome, tipo, tamanho, ativo")
    .eq("organizacao_id", organizacaoId)
    .ilike("nome", `%${primeiroToken}%`);
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}
