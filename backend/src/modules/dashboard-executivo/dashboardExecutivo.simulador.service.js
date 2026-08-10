// Simulação de preço Balcão/iFood + tabela dentro do Dashboard iFood.
//
// Objetivo: mostrar ao franqueado como a TABELA escolhida afeta a
// rentabilidade de um produto de referência (hoje: Churrasco 15cm), sem
// nunca inventar dado.
//
//   * Preço  -> produto_precos (mesma tabela que o catálogo/produtoModal usa).
//   * Custo  -> custo.js (mesmo grafo/fórmula do CMV do catálogo — nunca
//               duplicado, nunca hardcoded).
//   * Taxa do iFood -> o percentual de Taxas e Comissões REALMENTE apurado
//               no Financeiro deste mês, desta unidade (o mesmo indicador já
//               mostrado na Visão Geral). Não existe uma "taxa configurada"
//               confiável no sistema hoje (ver auditoria) — usar o dado real
//               observado é mais honesto que inventar um percentual fixo.
//               Sem indicador disponível no mês -> não calcula margem/receita
//               após taxas, mostra só o que dá pra saber com confiança
//               (preço, custo, CMV).
//   * Balcão -> não tem taxa de canal nenhuma (a comparação Balcão x iFood
//               só faz sentido se o Balcão não carregar uma taxa que não existe).

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { carregarGrafo, resumoProduto } from "../produtos/custo.js";
import { resolverUnidadeAlvo, obterMes } from "./dashboardExecutivo.service.js";
import { hojeIsoBrasil } from "./dashboardExecutivo.calc.js";

// Nota de rodapé — a mesma para qualquer unidade/mês, por isso fica fora do
// resultado calculado (não é dado, é texto de interface).
export const NOTA_MARGEM_IFOOD = "Margem estimada após o custo da ficha técnica e as Taxas e Comissões do iFood — não é lucro líquido: ainda existem outros custos operacionais da loja (Serviços e Promoções, aluguel, folha etc.) que não entram nesta conta.";
export const NOTA_MARGEM_BALCAO = "Margem estimada antes de demais despesas operacionais da loja.";

const CANAIS_SIMULADOR = ["balcao", "ifood"];

/**
 * Localiza o produto de referência pelo NOME (nunca por id fixo — cada
 * organização tem seu próprio catálogo). Tolerante à grafia ("Churrasco
 * 15cm" vs "Churrasco 15 cm"): tenta primeiro pela coluna `tamanho`, que é
 * o dado estruturado, e só then pelo nome como texto livre.
 * @param {string} organizacaoId @param {string} nomeBusca
 */
async function localizarProdutoReferencia(organizacaoId, nomeBusca) {
  const termo = nomeBusca.replace(/\s+/g, "");
  const { data, error } = await supabase
    .from("produtos")
    .select("id, nome, tamanho, custo_manual, ativo")
    .eq("organizacao_id", organizacaoId)
    .eq("ativo", true)
    .ilike("nome", `%${nomeBusca.split(" ")[0]}%`); // 1º termo (ex.: "Churrasco") — filtro amplo, refinado abaixo
  if (error) throw ApiError.internal(error.message);

  const candidatos = data ?? [];
  const alvo = candidatos.find((p) => p.nome.replace(/\s+/g, "").toLowerCase() === termo.toLowerCase())
    ?? candidatos.find((p) => p.tamanho === "15cm" && /churrasco/i.test(p.nome))
    ?? candidatos.find((p) => /15\s*cm/i.test(p.nome));
  if (!alvo) {
    throw ApiError.notFound(`Produto de referência "${nomeBusca}" não encontrado no catálogo desta empresa. Cadastre-o em Produtos/CMV para habilitar a simulação.`);
  }
  return alvo;
}

/**
 * @param {{organizacaoId: string, unidadeIdSessao: string|null, unidadeIdSolicitado: unknown, canal: unknown, tabela: unknown, produto?: string, mes?: unknown, ano?: unknown}} p
 */
export async function simularPrecoProduto({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, canal, tabela, produto: nomeProduto, mes: mesRaw, ano: anoRaw }) {
  const canalValido = v.umDe(canal, "Canal", CANAIS_SIMULADOR);
  const tabelaValida = v.texto(tabela, "Tabela", { min: 1, max: 20 });
  const nome = v.textoOpcional(nomeProduto, "Produto", { max: 200 }) ?? "Churrasco 15cm";
  // O simulador tem que olhar o MESMO mês/ano que o franqueado está vendo na
  // Visão Geral — nunca "hoje" por padrão. Era exatamente aqui que estava o
  // bug: a taxa era sempre buscada no mês corrente do calendário, mesmo com
  // o usuário olhando um mês diferente (ex.: Julho, com dados completos,
  // enquanto "hoje" cai em Agosto, ainda sem lançamento nenhum).
  const hojeIso = hojeIsoBrasil();
  const [anoAtualNum, mesAtualNum] = hojeIso.split("-").map(Number);
  const mes = v.numeroOpcionalNulo(mesRaw, "Mês") ?? mesAtualNum;
  const ano = v.numeroOpcionalNulo(anoRaw, "Ano") ?? anoAtualNum;

  // Simulação é sempre de UMA unidade (a taxa real do iFood é por unidade) —
  // mesma regra das demais leituras do Dashboard Executivo.
  const unidadeId = await resolverUnidadeAlvo({ organizacaoId, unidadeIdSessao, unidadeIdSolicitado, exigirEspecifica: true });

  const produtoRow = await localizarProdutoReferencia(organizacaoId, nome);

  const { data: precoRow, error: ePreco } = await supabase
    .from("produto_precos").select("preco, desatualizado")
    .eq("produto_id", produtoRow.id).eq("canal", canalValido).eq("tabela", tabelaValida).maybeSingle();
  if (ePreco) throw ApiError.internal(ePreco.message);

  const grafo = await carregarGrafo(organizacaoId);
  const preco = precoRow ? Number(precoRow.preco) : null;
  const resumo = resumoProduto({ produtoId: produtoRow.id, grafo, precoVenda: preco, custoManual: produtoRow.custo_manual });

  const resultado = {
    produto: { id: produtoRow.id, nome: produtoRow.nome, tamanho: produtoRow.tamanho },
    canal: canalValido, tabela: tabelaValida, periodo: { mes, ano },
    preco, precoDesatualizado: precoRow?.desatualizado ?? null,
    custo: resumo.custo,
    cmvPct: resumo.cmv_pct,
    statusFicha: resumo.status_ficha,
    taxaEstimadaPct: null,
    taxaEstimadaReais: null,
    taxaEstimadaFonte: null,
    receitaAposTaxas: null,
    margemEstimada: null,
    margemEstimadaPct: null,
    margemNota: null,
    indisponivel: null,
  };

  if (!precoRow) {
    resultado.indisponivel = `Nenhum preço cadastrado para ${produtoRow.nome} no canal/tabela selecionado.`;
    return resultado;
  }
  if (resumo.status_ficha?.chave === "insumo_sem_custo") {
    resultado.indisponivel = "Há insumo sem custo na ficha técnica deste produto — não é possível calcular a margem com confiança.";
    return resultado;
  }

  if (canalValido === "balcao") {
    // Sem taxa de canal no balcão — a comparação com o iFood só é honesta se
    // o balcão não carregar uma dedução que não existe de verdade. Margem
    // aqui = preço - custo, ainda ANTES de qualquer despesa operacional.
    resultado.receitaAposTaxas = preco;
    resultado.margemEstimada = preco - resumo.custo;
    resultado.margemEstimadaPct = preco > 0 ? (resultado.margemEstimada / preco) * 100 : null;
    resultado.margemNota = NOTA_MARGEM_BALCAO;
    return resultado;
  }

  // canal === "ifood": taxa = % real de Taxas e Comissões já apurado no
  // Financeiro do MÊS/ANO selecionados nesta unidade — o mesmo indicador (e
  // a mesma função, obterMes) que alimenta o card "Taxas e Comissões" da
  // Visão Geral. Fonte única: nunca duas contas divergentes para o mesmo
  // número. Não inventa um percentual fixo — se o mês não tem dado
  // suficiente ainda, devolve só preço/custo/CMV (já preenchidos acima).
  const mesDados = await obterMes({ organizacaoId, unidadeIdSessao: unidadeId, unidadeIdSolicitado: undefined, mes, ano });
  const indicadorTaxas = mesDados?.indicadoresRentabilidade?.taxas_comissoes;
  const taxaPct = indicadorTaxas && !indicadorTaxas.naoAplicavel ? indicadorTaxas.atual : null;

  if (taxaPct == null) {
    resultado.indisponivel = "Ainda não há Taxas e Comissões suficientes apuradas no Financeiro deste mês para estimar a margem no iFood — mostrando só preço, custo e CMV.";
    return resultado;
  }

  // Precisão interna (taxaPct vem em ponto flutuante cheio, sem o
  // arredondamento de exibição) — só a interface arredonda, nunca a conta.
  resultado.taxaEstimadaPct = taxaPct;
  resultado.taxaEstimadaReais = (preco * taxaPct) / 100;
  resultado.taxaEstimadaFonte = "Percentual real de Taxas e Comissões apurado no Financeiro deste mês, nesta unidade (mesma fonte do card Taxas e Comissões da Visão Geral).";
  resultado.receitaAposTaxas = preco - resultado.taxaEstimadaReais;
  resultado.margemEstimada = resultado.receitaAposTaxas - resumo.custo;
  resultado.margemEstimadaPct = preco > 0 ? (resultado.margemEstimada / preco) * 100 : null;
  resultado.margemNota = NOTA_MARGEM_IFOOD;
  return resultado;
}
