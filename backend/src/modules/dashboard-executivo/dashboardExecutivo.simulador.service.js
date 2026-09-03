// Simulação de preço Balcão/iFood + tabela dentro do Dashboard iFood.
//
// Objetivo: mostrar ao franqueado como a TABELA escolhida afeta a
// rentabilidade de um produto de referência (hoje: Churrasco 15cm), sem
// nunca inventar dado.
//
//   * Preço  -> produto_precos (mesma tabela que o catálogo/produtoModal usa).
//   * Custo  -> custo.js (mesmo grafo/fórmula do CMV do catálogo — nunca
//               duplicado, nunca hardcoded).
//   * Deduções do iFood -> os percentuais de Taxas e Comissões E Serviços e
//               Promoções REALMENTE apurados no Financeiro deste mês, desta
//               unidade (os mesmos indicadores já mostrados na Visão Geral —
//               `indicadoresRentabilidade`, ver dashboardExecutivo.service.js).
//               Auditoria de 19/08: a margem do iFood só descontava Taxas e
//               Comissões; Serviços e Promoções (investimento em campanhas)
//               também é dedução real do mês e passou a entrar na conta —
//               ver margemEstimadaIfood() em dashboardExecutivo.calc.js.
//               Taxas de entregadores e ajustes contra a loja NÃO entram (por
//               isso NOTA_MARGEM_IFOOD nunca chama isso de lucro líquido). Sem os
//               dois indicadores disponíveis no mês -> não calcula margem,
//               mostra só o que dá pra saber com confiança (preço, custo, CMV).
//   * Meta/limite de cada dedução -> mesma `metas_indicadores` e mesma
//               `statusIndicador()` da Visão Geral — nunca uma regra paralela.
//   * Referência do modelo -> soma das metas ideais de Taxas e Comissões e
//               Serviços e Promoções (`referenciaModeloPct()`), NUNCA lida de
//               uma linha `total_deducoes` separada — assim não pode divergir
//               do que a margem realmente desconta. É régua de compensação de
//               custos do canal, não teto de preço.
//   * Limite combinado -> soma dos LIMITES (teto real) das mesmas duas
//               deduções (`limiteCombinadoPct()`) — diferente da referência
//               acima, que soma metas ideais.
//   * Balcão -> não tem taxa de canal nenhuma (a comparação Balcão x iFood
//               só faz sentido se o Balcão não carregar uma taxa que não existe).

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import { carregarGrafo, resumoProduto } from "../produtos/custo.js";
import { resolverUnidadeAlvo, obterMes } from "./dashboardExecutivo.service.js";
import { hojeIsoBrasil, margemEstimadaIfood, referenciaModeloPct, limiteCombinadoPct } from "./dashboardExecutivo.calc.js";
import { obterModeloLogistico, resolverMetas } from "./dashboardExecutivo.metas.service.js";

// Nota de rodapé — a mesma para qualquer unidade/mês, por isso fica fora do
// resultado calculado (não é dado, é texto de interface).
export const NOTA_MARGEM_IFOOD = "Margem estimada após o custo da ficha técnica, as Taxas e Comissões e os Serviços e Promoções do iFood — não é lucro líquido: ainda existem outros custos operacionais da loja (taxas de entregadores, ajustes contra a loja, aluguel, folha etc.) que não entram nesta conta.";
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
    // Taxas e Comissões — dedução obrigatória do canal.
    taxaEstimadaPct: null,
    taxaEstimadaReais: null,
    taxaEstimadaMetaIdeal: null,
    taxaEstimadaLimite: null,
    taxaEstimadaStatus: null,
    // Serviços e Promoções — investimento em campanhas do mês (auditoria de
    // 19/08: passou a entrar na margem, antes só Taxas e Comissões entrava).
    servicosPromocoesPct: null,
    servicosPromocoesReais: null,
    servicosPromocoesMetaIdeal: null,
    servicosPromocoesLimite: null,
    servicosPromocoesStatus: null,
    taxaEstimadaFonte: null,
    deducoesConsideradasPct: null,
    receitaAposDeducoesConsideradas: null,
    margemEstimada: null,
    margemEstimadaPct: null,
    margemNota: null,
    // Referência do modelo logístico (Marketplace x Full Service) para a
    // diferença de preço Balcão x iFood — soma das metas ideais de Taxas e
    // Comissões e Serviços e Promoções, calculada ao vivo em
    // referenciaModeloPct() (dashboardExecutivo.calc.js), nunca lida de uma
    // linha separada. Vem de meta, não de lançamento do mês, por isso é
    // resolvida mesmo quando as deduções acima ficam null por falta de dado.
    modeloLogistico: null,
    modeloLogisticoRotulo: null,
    referenciaModeloPct: null,
    // Limite combinado — soma dos LIMITES (teto real) de Taxas e Comissões e
    // Serviços e Promoções, ver limiteCombinadoPct() em dashboardExecutivo.calc.js.
    // Diferente de referenciaModeloPct (soma das METAS IDEAIS): a meta é
    // aspiracional, o limite é o teto que statusIndicador usa pra "fora da meta".
    limiteCombinadoPct: null,
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
    resultado.margemEstimada = preco - resumo.custo;
    resultado.margemEstimadaPct = preco > 0 ? (resultado.margemEstimada / preco) * 100 : null;
    resultado.margemNota = NOTA_MARGEM_BALCAO;
    return resultado;
  }

  // Modelo logístico da unidade (Marketplace x Full Service) + as metas
  // (ideal/limite) de Taxas e Comissões e Serviços e Promoções configuradas
  // pra ele (ver metas_indicadores). Vem de meta, não de apuração do mês,
  // então resolve mesmo quando o mês ainda não tem indicadores suficientes.
  const modelo = await obterModeloLogistico({ unidadeId, organizacaoId });
  const metas = await resolverMetas({ organizacaoId, unidadeId, modeloLogistico: modelo.modeloLogistico });
  resultado.modeloLogistico = modelo.modeloLogistico;
  resultado.modeloLogisticoRotulo = modelo.modeloLogisticoRotulo;
  resultado.taxaEstimadaMetaIdeal = metas.taxas_comissoes?.metaIdeal ?? null;
  resultado.taxaEstimadaLimite = metas.taxas_comissoes?.limite ?? null;
  resultado.servicosPromocoesMetaIdeal = metas.servicos_promocoes?.metaIdeal ?? null;
  resultado.servicosPromocoesLimite = metas.servicos_promocoes?.limite ?? null;
  // Calculada ao vivo a partir das duas metas acima — nunca lida de uma linha
  // `total_deducoes` separada (ver comentário em referenciaModeloPct()).
  resultado.referenciaModeloPct = referenciaModeloPct({
    metaTaxasComissoes: resultado.taxaEstimadaMetaIdeal,
    metaServicosPromocoes: resultado.servicosPromocoesMetaIdeal,
  });
  resultado.limiteCombinadoPct = limiteCombinadoPct({
    limiteTaxasComissoes: resultado.taxaEstimadaLimite,
    limiteServicosPromocoes: resultado.servicosPromocoesLimite,
  });

  // Taxas e Comissões e Serviços e Promoções REAIS já apurados no Financeiro
  // do MÊS/ANO selecionados nesta unidade — os mesmos indicadores (e a mesma
  // função, obterMes) que alimentam os cards da Visão Geral. Fonte única:
  // nunca duas contas divergentes para o mesmo número. Não inventa
  // percentual fixo — se o mês não tem dado suficiente ainda, devolve só
  // preço/custo/CMV/modelo/metas (já preenchidos acima).
  const mesDados = await obterMes({ organizacaoId, unidadeIdSessao: unidadeId, unidadeIdSolicitado: undefined, mes, ano });
  const indicTaxas = mesDados?.indicadoresRentabilidade?.taxas_comissoes;
  const indicServicos = mesDados?.indicadoresRentabilidade?.servicos_promocoes;
  const taxaPct = indicTaxas && !indicTaxas.naoAplicavel ? indicTaxas.atual : null;
  const servicosPct = indicServicos && !indicServicos.naoAplicavel ? indicServicos.atual : null;
  // Status "dentro da meta / atenção / fora da meta" — MESMA função
  // (statusIndicador, já rodada dentro de obterMes) que os cards "Taxas e
  // Comissões" e "Serviços e Promoções" da Visão Geral usam. Nunca duplicada.
  resultado.taxaEstimadaStatus = indicTaxas?.status ?? null;
  resultado.servicosPromocoesStatus = indicServicos?.status ?? null;

  if (taxaPct == null || servicosPct == null) {
    const faltando = [taxaPct == null && "Taxas e Comissões", servicosPct == null && "Serviços e Promoções"].filter(Boolean).join(" e ");
    resultado.indisponivel = `Ainda não há ${faltando} suficientes apurados no Financeiro deste mês para estimar a margem no iFood — mostrando só preço, custo e CMV.`;
    return resultado;
  }

  // Precisão interna (percentuais vêm em ponto flutuante cheio, sem o
  // arredondamento de exibição) — só a interface arredonda, nunca a conta.
  const margem = margemEstimadaIfood({ preco, custo: resumo.custo, taxaComissoesPct: taxaPct, servicosPromocoesPct: servicosPct });
  resultado.taxaEstimadaPct = taxaPct;
  resultado.taxaEstimadaReais = margem.taxaComissoesReais;
  resultado.servicosPromocoesPct = servicosPct;
  resultado.servicosPromocoesReais = margem.servicosPromocoesReais;
  resultado.deducoesConsideradasPct = margem.deducoesConsideradasPct;
  resultado.taxaEstimadaFonte = "Percentuais reais de Taxas e Comissões e Serviços e Promoções apurados no Financeiro deste mês, nesta unidade (mesma fonte dos cards da Visão Geral).";
  resultado.receitaAposDeducoesConsideradas = margem.receitaAposDeducoesConsideradas;
  resultado.margemEstimada = margem.margemEstimada;
  resultado.margemEstimadaPct = margem.margemEstimadaPct;
  resultado.margemNota = NOTA_MARGEM_IFOOD;
  return resultado;
}
