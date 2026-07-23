// Sincronização do catálogo Martin Brower.
//
// Recebe o payload CRU do loadItens (venha ele do worker Playwright ou da
// importação manual administrativa) e faz: normalizar -> filtrar -> comparar
// preços -> gravar. Não sabe nada sobre navegador, login ou credenciais —
// é por isso que dá para testá-lo inteiro sem rede.
//
// O que esta fase deliberadamente NÃO faz: mexer em ficha_tecnica ou CMV.
// O gancho existe (emitirEventoCatalogoAtualizado) mas não propaga custo.

import { normalizarCatalogo } from "./martinbrower.normalizer.js";
import { aplicarFiltros } from "./martinbrower.filtros.js";
import { mbErro, MB_ERROS } from "./martinbrower.errors.js";
import { mbLog } from "./martinbrower.logsafe.js";

// O repositório real é carregado sob demanda, não no topo do módulo. Assim
// este arquivo pode ser importado (e testado) sem exigir as variáveis do
// Supabase — a lógica de normalizar/filtrar/comparar não depende de infra.
let repositorioReal = null;
async function repositorioPadrao() {
  repositorioReal ??= await import("./martinbrower.repository.js");
  return repositorioReal;
}

// Preços iguais até o centavo não geram histórico. Comparar float direto
// registraria "mudança" de 486.01 para 486.009999.
const MESMO_PRECO = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
};

/**
 * Diff de preço entre o que está no banco e o que veio do portal.
 * @returns {null | {precoAnterior, precoNovo, alteracaoValor, alteracaoPercentual}}
 */
export function calcularAlteracaoPreco(precoAnterior, precoNovo) {
  if (precoNovo == null) return null;                    // item sem preço: nada a registrar
  if (MESMO_PRECO(precoAnterior, precoNovo)) return null; // preço igual: nada a registrar

  const anterior = precoAnterior == null ? null : Number(precoAnterior);
  const novo = Number(precoNovo);
  const valor = anterior == null ? null : Number((novo - anterior).toFixed(2));
  // Percentual sobre preço anterior zero seria divisão por zero — fica null.
  const percentual = anterior == null || anterior === 0
    ? null
    : Number((((novo - anterior) / anterior) * 100).toFixed(4));

  return { precoAnterior: anterior, precoNovo: novo, alteracaoValor: valor, alteracaoPercentual: percentual };
}

// Produto normalizado + classificação -> linha da tabela.
function montarLinha({ organizacaoId, unidadeId, clientId, orderId, p, existente, agora }) {
  return {
    organizacao_id: organizacaoId,
    unidade_id: unidadeId,
    client_id: clientId,
    order_id: orderId ?? p.orderId ?? null,
    client_product_id: p.clientProductId,
    product_id: p.productId,
    codigo: p.codigo,
    codigo_interno: p.codigoInterno,
    descricao: p.descricao,
    preco: p.preco,
    peso: p.peso,
    volume: p.volume,
    unidade: p.unidade,
    unidade_descricao: p.unidadeDescricao,
    familia: p.familia,
    familia_descricao: p.familiaDescricao,
    grupo_id: p.grupoId,
    grupo_descricao: p.grupoDescricao,
    multiplo: p.multiplo,
    quantidade_media: p.quantidadeMedia,
    quantidade_pedido: p.quantidadePedido,
    status_item_id: p.statusItemId,
    tipo_produto: p.tipoProduto,
    ativo: true,
    visto_na_ultima_sincronizacao: true,
    // Classificação manual do administrador VENCE o filtro automático.
    ignorado: existente?.classificacao_manual ? existente.ignorado : p.ignorado,
    motivo_ignorado: existente?.classificacao_manual ? undefined : p.motivoIgnorado,
    regra_ignorado: existente?.classificacao_manual ? undefined : p.regraIgnorado,
    // primeira_sincronizacao é preservada; só o registro novo a define.
    primeira_sincronizacao: existente?.primeira_sincronizacao ?? agora,
    ultima_sincronizacao: agora,
  };
}

/**
 * Processa um catálogo cru e persiste o resultado.
 *
 * @param {object} params
 * @param {string} params.organizacaoId  de req.tenant — nunca do corpo
 * @param {string} params.unidadeId      de req.tenant — nunca do corpo
 * @param {number} params.clientId       da configuração da unidade
 * @param {number} params.orderId        do findProxPedidoV2 — nunca fixo
 * @param {object} params.payload        resposta crua do loadItens
 * @param {string} params.sincronizacaoId
 * @param {Function} [params.aoProgredir] callback de etapa (progresso na UI)
 * @param {object} [params.repo] repositório injetável — o padrão é o real;
 *        os testes passam um em memória e rodam sem Supabase nenhum.
 */
export async function processarCatalogo({
  organizacaoId, unidadeId, clientId, orderId, payload,
  sincronizacaoId, aoProgredir = () => {}, repo,
}) {
  const repositorio = repo ?? await repositorioPadrao();
  const agora = new Date().toISOString();
  const t0 = Date.now();

  // 1) Normalizar
  aoProgredir("Normalizando produtos");
  const { produtos: normalizados, rejeitados, totalBruto, grupos } = normalizarCatalogo(payload);
  if (!totalBruto) throw mbErro(MB_ERROS.MARTIN_BROWER_CATALOG_INVALID, { detalhes: { motivo: "catálogo vazio" } });

  // 2) Filtrar (nada é removido — só classificado)
  aoProgredir("Filtrando itens ignorados");
  const regrasCustom = await repositorio.listarFiltros({ organizacaoId, unidadeId });
  const { produtos: classificados, validos, ignorados } = aplicarFiltros(normalizados, regrasCustom);

  // 3) Comparar preços contra o estado atual
  aoProgredir("Comparando preços");
  const existentes = await repositorio.mapearProdutosExistentes({ organizacaoId, unidadeId, clientId });

  const linhas = [];
  const alteracoesPendentes = []; // {codigo, diff} — vira histórico após o upsert
  let criados = 0;
  let atualizados = 0;

  for (const p of classificados) {
    const existente = existentes.get(p.codigo);
    if (existente) atualizados += 1; else criados += 1;

    const diff = calcularAlteracaoPreco(existente?.preco ?? null, p.preco);
    // Produto novo sem preço anterior não conta como "preço alterado":
    // é a linha de base, não uma mudança.
    if (diff && existente) alteracoesPendentes.push({ codigo: p.codigo, diff });

    linhas.push(montarLinha({ organizacaoId, unidadeId, clientId, orderId, p, existente, agora }));
  }

  // 4) Gravar (lotes; erro individual não cancela o catálogo)
  aoProgredir("Atualizando banco");
  const { salvos, erros } = await repositorio.upsertProdutos({ organizacaoId, unidadeId, linhas });
  const idPorCodigo = new Map(salvos.map((s) => [s.codigo, s.id]));

  // 5) Histórico — só das mudanças reais, e só de quem foi gravado com sucesso
  const registrosHistorico = alteracoesPendentes
    .filter((a) => idPorCodigo.has(a.codigo))
    .map((a) => ({
      organizacao_id: organizacaoId, unidade_id: unidadeId,
      produto_id: idPorCodigo.get(a.codigo), client_id: clientId, codigo: a.codigo,
      preco_anterior: a.diff.precoAnterior, preco_novo: a.diff.precoNovo,
      alteracao_valor: a.diff.alteracaoValor, alteracao_percentual: a.diff.alteracaoPercentual,
      coletado_em: agora, sincronizacao_id: sincronizacaoId ?? null,
    }));
  await repositorio.inserirHistoricoPrecos({ organizacaoId, unidadeId, registros: registrosHistorico });

  // 6) Produtos que sumiram: sinalizados, NUNCA excluídos
  await repositorio.marcarNaoVistos({
    organizacaoId, unidadeId, clientId,
    codigosVistos: salvos.map((s) => s.codigo),
  });

  aoProgredir("Finalizando sincronização");

  const resumo = {
    produtosEncontrados: totalBruto,
    produtosValidos: validos,
    produtosIgnorados: ignorados,
    produtosCriados: criados,
    produtosAtualizados: atualizados,
    precosAlterados: registrosHistorico.length,
    produtosComErro: erros.length + rejeitados.length,
    rejeitados,
    errosGravacao: erros,
    grupos,
    duracaoMs: Date.now() - t0,
  };

  mbLog("info", "catalogo.processado", { organizacaoId, unidadeId, orderId, ...resumo, rejeitados: rejeitados.length, errosGravacao: erros.length });

  // Gancho para o futuro (insumos / ficha técnica / CMV). Nesta fase apenas
  // registra: NENHUM custo é propagado automaticamente.
  emitirEventoCatalogoAtualizado({ organizacaoId, unidadeId, clientId, orderId, resumo });

  return resumo;
}

// Ponto de extensão da Fase 5. Hoje é só um log — de propósito.
// Quando o vínculo produto MB -> insumo estiver maduro, é daqui que sai o
// recálculo de custo, sempre com confirmação humana no meio.
function emitirEventoCatalogoAtualizado(evento) {
  mbLog("info", "catalogo.evento", {
    organizacaoId: evento.organizacaoId, unidadeId: evento.unidadeId,
    orderId: evento.orderId, precosAlterados: evento.resumo.precosAlterados,
    nota: "gancho para insumos/CMV — sem propagação automática nesta fase",
  });
}
