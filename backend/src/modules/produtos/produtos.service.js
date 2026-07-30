import { randomUUID } from "node:crypto";
import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import {
  carregarGrafo, componentesDiretos, custoTotalProduto, ingredientesExplodidos,
  produtosAfetadosPorInsumo, recalcularCache,
} from "./custo.js";
import {
  converterQuantidade, statusFicha, validarComponenteFicha, UNIDADES,
} from "../insumos/insumos.calc.js";

export async function listarProdutos({ organizacaoId, vendavel, tipo }) {
  let q = supabase
    .from("produtos")
    .select("id, nome, tipo, tamanho, vendavel, custo_cache, sku, codigo_pdv")
    .eq("organizacao_id", organizacaoId)
    .order("nome");
  if (vendavel !== undefined) q = q.eq("vendavel", vendavel);
  if (tipo) q = q.eq("tipo", tipo);
  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);
  return data;
}

// Produto + ficha técnica editável + ingredientes explodidos + preços + CMV/margem.
// Usa o grafo de custo compartilhado (custo.js) — mesma fonte do recálculo, sem
// duplicar fórmula. Isolamento por organização é garantido pelo grafo.
export async function obterProduto({ organizacaoId, id }) {
  const produtoId = v.uuid(id, "Produto");
  const { data: produto, error } = await supabase
    .from("produtos").select("*").eq("organizacao_id", organizacaoId).eq("id", produtoId).single();
  if (error || !produto) throw ApiError.notFound("Produto não encontrado");

  const [grafo, precosRes] = await Promise.all([
    carregarGrafo(organizacaoId),
    supabase.from("produto_precos").select("canal, tabela, preco, desatualizado").eq("produto_id", produtoId).order("canal"),
  ]);
  if (precosRes.error) throw ApiError.internal(precosRes.error.message);
  const precos = precosRes.data ?? [];

  const ficha = componentesDiretos(produtoId, grafo);            // 1 nível, editável
  const ingredientes = ingredientesExplodidos(produtoId, grafo); // até o insumo cru (compat modal)
  const custoCalculado = custoTotalProduto(produtoId, grafo);
  const custoManual = produto.custo_manual != null ? Number(produto.custo_manual) : null;
  const custo = custoManual != null ? custoManual : custoCalculado;

  const temPreco = precos.some((p) => Number(p.preco) > 0);
  const status = statusFicha({
    componentes: ficha.map((c) => ({ custoUnitarioBase: c.custo_unitario_base, insumoAtivo: c.insumo_ativo })),
    temPreco,
  });

  // Componentes no formato legado (mantém o modal atual funcionando).
  const componentes = ficha.map((c) => ({
    tipo: c.tipo, nome: c.nome, quantidade: c.quantidade, unidade: c.tipo === "insumo" ? c.unidade : null,
  }));

  return {
    ...produto,
    custo, custo_calculado: custoCalculado, custo_manual: custoManual,
    ingredientes, componentes, ficha, precos,
    qtd_componentes: ficha.length,
    status_ficha: status,
    unidades: UNIDADES,
  };
}

// Atualiza campos do produto e/ou preços (upsert por canal/tabela).
// `usuario` = { id, nome, email } (vem do JWT via requireAuth) — usado na auditoria.
export async function atualizarProduto({ organizacaoId, id, dados, usuario }) {
  // Carrega o estado ATUAL (para diff da auditoria e checagem de existência).
  const { data: antes } = await supabase
    .from("produtos")
    .select("id, nome, tipo, tamanho, ativo")
    .eq("organizacao_id", organizacaoId)
    .eq("id", id)
    .single();
  if (!antes) throw ApiError.notFound("Produto não encontrado");

  const ROTULO_CAMPO = { nome: "Nome", tipo: "Categoria", tamanho: "Tamanho", ativo: "Status" };
  const mudancas = [];

  // 1) Campos básicos do produto
  const campos = {};
  for (const k of ["nome", "tipo", "tamanho", "ativo"]) if (dados[k] !== undefined) campos[k] = dados[k];
  if (campos.nome !== undefined && !String(campos.nome).trim()) throw ApiError.badRequest("Nome não pode ser vazio.");
  if (Object.keys(campos).length) {
    const { error } = await supabase.from("produtos").update(campos).eq("id", id).eq("organizacao_id", organizacaoId);
    if (error) throw ApiError.badRequest(error.message);
    // Diff dos campos básicos
    for (const k of Object.keys(campos)) {
      const de = antes[k];
      const para = campos[k];
      const igual = k === "ativo" ? !!de === !!para : String(de ?? "") === String(para ?? "");
      if (!igual) {
        mudancas.push({
          campo: k,
          rotulo: ROTULO_CAMPO[k] ?? k,
          valor_anterior: de === null || de === undefined ? null : String(de),
          valor_novo: para === null || para === undefined ? null : String(para),
        });
      }
    }
  }

  // 2) Preços (upsert por produto/canal/tabela)
  if (Array.isArray(dados.precos)) {
    const rows = dados.precos
      .filter((p) => p.canal && p.preco !== "" && Number(p.preco) >= 0)
      .map((p) => ({ produto_id: id, canal: p.canal, tabela: p.tabela ?? null, preco: Number(p.preco), desatualizado: !!p.desatualizado }));
    if (rows.length) {
      // Preços atuais (antes do upsert) para o diff da auditoria
      const { data: precosAntes } = await supabase
        .from("produto_precos").select("canal, tabela, preco").eq("produto_id", id);
      const antesMap = new Map((precosAntes ?? []).map((p) => [`${p.canal}|${p.tabela ?? ""}`, Number(p.preco)]));

      const { error } = await supabase.from("produto_precos").upsert(rows, { onConflict: "produto_id,canal,tabela" });
      if (error) throw ApiError.badRequest(error.message);

      for (const r of rows) {
        const de = antesMap.get(`${r.canal}|${r.tabela ?? ""}`);
        const para = Number(r.preco);
        if (de === undefined || Number(de) !== para) {
          const canalTxt = r.canal.charAt(0).toUpperCase() + r.canal.slice(1);
          mudancas.push({
            campo: "preco",
            rotulo: `Preço · ${canalTxt}${r.tabela ? ` (${r.tabela})` : ""}`,
            valor_anterior: de === undefined ? null : String(de),
            valor_novo: String(para),
          });
        }
      }
    }
  }

  // 3) Custo manual (override do custo calculado). '' ou null volta ao automático.
  //    Best-effort: se a coluna custo_manual não existir (migration 004 não rodada),
  //    ignora sem quebrar o restante do salvar.
  if (dados.custo !== undefined) {
    let custoManual = null;
    if (dados.custo !== "" && dados.custo !== null) {
      const n = Number(dados.custo);
      if (Number.isNaN(n) || n < 0) throw ApiError.badRequest("Custo inválido.");
      custoManual = n;
    }
    const { data: cAntes, error: eRead } = await supabase
      .from("produtos").select("custo_manual").eq("id", id).eq("organizacao_id", organizacaoId).single();
    const colunaAusente = eRead && /custo_manual|does not exist|schema cache|could not find/i.test(eRead.message);
    if (!colunaAusente) {
      const antesCusto = cAntes?.custo_manual != null ? Number(cAntes.custo_manual) : null;
      const { error } = await supabase.from("produtos").update({ custo_manual: custoManual })
        .eq("id", id).eq("organizacao_id", organizacaoId);
      if (error) throw ApiError.badRequest(error.message);
      if (antesCusto !== custoManual) {
        mudancas.push({
          campo: "custo", rotulo: "Custo",
          valor_anterior: antesCusto == null ? null : String(antesCusto),
          valor_novo: custoManual == null ? null : String(custoManual),
        });
      }
    }
  }

  // 4) Auditoria (best-effort: nunca derruba o salvar se a tabela não existir)
  await registrarHistorico({ organizacaoId, produtoId: id, usuario, mudancas });

  return obterProduto({ organizacaoId, id });
}

// Grava as mudanças na tabela de auditoria. Falhas são apenas logadas (best-effort).
async function registrarHistorico({ organizacaoId, produtoId, usuario, mudancas }) {
  if (!mudancas?.length) return;
  const alteracaoId = randomUUID();
  const linhas = mudancas.map((mc) => ({
    organizacao_id: organizacaoId,
    produto_id: produtoId,
    alteracao_id: alteracaoId,
    campo: mc.campo,
    rotulo: mc.rotulo,
    valor_anterior: mc.valor_anterior,
    valor_novo: mc.valor_novo,
    usuario_id: usuario?.id ?? null,
    usuario_nome: usuario?.nome ?? null,
    usuario_email: usuario?.email ?? null,
  }));
  try {
    const { error } = await supabase.from("produto_historico").insert(linhas);
    if (error) console.warn("[historico] não registrado:", error.message);
  } catch (e) {
    console.warn("[historico] exceção ao registrar:", e.message);
  }
}

// Lista o histórico de alterações de um produto, agrupado por "Salvar" (alteracao_id).
export async function listarHistoricoProduto({ organizacaoId, produtoId }) {
  const { data: prod } = await supabase
    .from("produtos").select("id, nome")
    .eq("organizacao_id", organizacaoId).eq("id", produtoId).single();
  if (!prod) throw ApiError.notFound("Produto não encontrado");

  const { data, error } = await supabase
    .from("produto_historico")
    .select("alteracao_id, campo, rotulo, valor_anterior, valor_novo, usuario_nome, usuario_email, created_at")
    .eq("organizacao_id", organizacaoId)
    .eq("produto_id", produtoId)
    .order("created_at", { ascending: false })
    .limit(300);

  if (error) {
    // Tabela ainda não criada (migration 002 não executada) → responde vazio + pendente
    if (/does not exist|schema cache|could not find the table/i.test(error.message)) {
      return { produto: prod.nome, pendente: true, alteracoes: [] };
    }
    throw ApiError.internal(error.message);
  }

  const grupos = new Map();
  for (const r of data ?? []) {
    if (!grupos.has(r.alteracao_id)) {
      grupos.set(r.alteracao_id, {
        alteracao_id: r.alteracao_id,
        created_at: r.created_at,
        usuario_nome: r.usuario_nome,
        usuario_email: r.usuario_email,
        mudancas: [],
      });
    }
    grupos.get(r.alteracao_id).mudancas.push({
      campo: r.campo, rotulo: r.rotulo,
      valor_anterior: r.valor_anterior, valor_novo: r.valor_novo,
    });
  }
  return { produto: prod.nome, pendente: false, alteracoes: [...grupos.values()] };
}

// Alterações mais recentes de TODA a organização (para o painel do Dashboard).
// Agrupa por "Salvar" (alteracao_id) e devolve os últimos `limite` eventos.
export async function listarHistoricoRecente({ organizacaoId, limite = 8 }) {
  const { data, error } = await supabase
    .from("produto_historico")
    .select("produto_id, alteracao_id, campo, rotulo, valor_anterior, valor_novo, usuario_nome, usuario_email, created_at")
    .eq("organizacao_id", organizacaoId)
    .order("created_at", { ascending: false })
    .limit(limite * 6); // sobra p/ agrupar várias mudanças num mesmo evento

  if (error) {
    if (/does not exist|schema cache|could not find the table/i.test(error.message)) {
      return { pendente: true, eventos: [] };
    }
    throw ApiError.internal(error.message);
  }

  const grupos = new Map();
  for (const r of data ?? []) {
    if (!grupos.has(r.alteracao_id)) {
      grupos.set(r.alteracao_id, {
        alteracao_id: r.alteracao_id, produto_id: r.produto_id, created_at: r.created_at,
        usuario_nome: r.usuario_nome, usuario_email: r.usuario_email, mudancas: [],
      });
    }
    grupos.get(r.alteracao_id).mudancas.push({
      campo: r.campo, rotulo: r.rotulo, valor_anterior: r.valor_anterior, valor_novo: r.valor_novo,
    });
  }
  let eventos = [...grupos.values()].slice(0, limite);

  // Nomes dos produtos envolvidos
  const ids = [...new Set(eventos.map((e) => e.produto_id))];
  if (ids.length) {
    const { data: prods } = await supabase
      .from("produtos").select("id, nome").eq("organizacao_id", organizacaoId).in("id", ids);
    const nomeById = Object.fromEntries((prods ?? []).map((p) => [p.id, p.nome]));
    eventos = eventos.map((e) => ({ ...e, produto_nome: nomeById[e.produto_id] ?? "Produto" }));
  }
  return { pendente: false, eventos };
}

// ===========================================================================
// FICHA TÉCNICA EDITÁVEL — adicionar / editar / remover componente
//
// Toda mutação: (1) valida o acesso do produto à organização; (2) valida o
// insumo/unidade; (3) grava a quantidade SEMPRE na unidade-base do insumo
// (mantendo fn_custo_produto e a baixa de estoque intactos); (4) recalcula em
// cascata o custo_cache do produto e de quem o usa como submontagem.
// ===========================================================================

const RE_COL_FICHA = /does not exist|schema cache|could not find/i;

/** Garante que o produto existe e pertence à organização. */
async function garantirProduto(organizacaoId, produtoId) {
  const { data } = await supabase
    .from("produtos").select("id, custo_manual").eq("organizacao_id", organizacaoId).eq("id", produtoId).single();
  if (!data) throw ApiError.notFound("Produto não encontrado");
  return data;
}

/** Recalcula em cascata e devolve o produto já atualizado + quantos recalcularam. */
async function recalcularEObter(organizacaoId, produtoId) {
  const grafo = await carregarGrafo(organizacaoId);
  const afetados = produtosAfetadosPorProduto(produtoId, grafo);
  const recalculados = await recalcularCache({ organizacaoId, produtoIds: afetados, grafo });
  const produto = await obterProduto({ organizacaoId, id: produtoId });
  return { produto, recalculados };
}

export async function adicionarComponente({ organizacaoId, produtoId, dados, usuario }) {
  const pid = v.uuid(produtoId, "Produto");
  await garantirProduto(organizacaoId, pid);
  const b = v.corpo(dados);
  const insumoId = v.uuid(b.insumo_id, "Insumo");

  // Insumo precisa ser DESTA organização e estar ativo.
  const { data: insumo } = await supabase
    .from("insumos").select("id, unidade_medida, ativo").eq("organizacao_id", organizacaoId).eq("id", insumoId).single();
  if (!insumo) throw ApiError.notFound("Insumo não encontrado nesta empresa.");
  if (insumo.ativo === false) throw ApiError.badRequest("Não é possível adicionar um insumo inativo à ficha.");

  const unidadeUso = v.umDe(b.unidade ?? insumo.unidade_medida, "Unidade utilizada", UNIDADES);
  const quantidade = v.numero(b.quantidade, "Quantidade utilizada", { min: 0 });
  const erro = validarComponenteFicha({ quantidade, unidadeUso, unidadeBase: insumo.unidade_medida });
  if (erro) throw ApiError.badRequest(erro);

  const qtdBase = converterQuantidade(quantidade, unidadeUso, insumo.unidade_medida);
  const linha = {
    produto_id: pid, insumo_id: insumoId, quantidade: qtdBase,
    unidade_uso: unidadeUso, quantidade_informada: quantidade,
    observacao: v.textoOpcional(b.observacao, "Observação", { max: 300 }),
    created_by: usuario?.id ?? null,
  };

  let res = await supabase.from("ficha_tecnica").insert(linha).select("id").single();
  if (res.error && RE_COL_FICHA.test(res.error.message)) {
    res = await supabase.from("ficha_tecnica")
      .insert({ produto_id: pid, insumo_id: insumoId, quantidade: qtdBase, observacao: linha.observacao })
      .select("id").single();
  }
  if (res.error) {
    if (/duplicate key|unique/i.test(res.error.message)) {
      throw ApiError.badRequest("Este insumo já está na ficha. Edite a quantidade em vez de duplicar.");
    }
    throw ApiError.badRequest(res.error.message);
  }
  return recalcularEObter(organizacaoId, pid);
}

export async function atualizarComponente({ organizacaoId, produtoId, fichaId, dados }) {
  const pid = v.uuid(produtoId, "Produto");
  const fid = v.uuid(fichaId, "Item da ficha");
  await garantirProduto(organizacaoId, pid);

  const { data: linha } = await supabase
    .from("ficha_tecnica").select("id, produto_id, insumo_id, subproduto_id").eq("id", fid).single();
  if (!linha || linha.produto_id !== pid) throw ApiError.notFound("Item da ficha não encontrado.");

  const b = v.corpo(dados);
  const patch = {};

  if (linha.insumo_id) {
    const { data: insumo } = await supabase
      .from("insumos").select("unidade_medida").eq("organizacao_id", organizacaoId).eq("id", linha.insumo_id).single();
    if (!insumo) throw ApiError.notFound("Insumo não encontrado.");
    const unidadeUso = v.umDe(b.unidade ?? insumo.unidade_medida, "Unidade utilizada", UNIDADES);
    const quantidade = v.numero(b.quantidade, "Quantidade utilizada", { min: 0 });
    const erro = validarComponenteFicha({ quantidade, unidadeUso, unidadeBase: insumo.unidade_medida });
    if (erro) throw ApiError.badRequest(erro);
    patch.quantidade = converterQuantidade(quantidade, unidadeUso, insumo.unidade_medida);
    patch.unidade_uso = unidadeUso;
    patch.quantidade_informada = quantidade;
  } else {
    // Submontagem/combo: quantidade em unidades do subproduto.
    const quantidade = v.numero(b.quantidade, "Quantidade", { min: 0 });
    if (quantidade <= 0) throw ApiError.badRequest("A quantidade deve ser maior que zero.");
    patch.quantidade = quantidade;
  }
  if (b.ativo !== undefined) patch.ativo = v.booleano(b.ativo, true);

  let res = await supabase.from("ficha_tecnica").update(patch).eq("id", fid);
  if (res.error && RE_COL_FICHA.test(res.error.message)) {
    res = await supabase.from("ficha_tecnica").update({ quantidade: patch.quantidade }).eq("id", fid);
  }
  if (res.error) throw ApiError.badRequest(res.error.message);
  return recalcularEObter(organizacaoId, pid);
}

export async function removerComponente({ organizacaoId, produtoId, fichaId }) {
  const pid = v.uuid(produtoId, "Produto");
  const fid = v.uuid(fichaId, "Item da ficha");
  await garantirProduto(organizacaoId, pid);

  const { data: linha } = await supabase
    .from("ficha_tecnica").select("id, produto_id").eq("id", fid).single();
  if (!linha || linha.produto_id !== pid) throw ApiError.notFound("Item da ficha não encontrado.");

  // Remover da ficha NÃO exclui o insumo da unidade — só a linha da ficha.
  const { error } = await supabase.from("ficha_tecnica").delete().eq("id", fid);
  if (error) throw ApiError.badRequest(error.message);
  return recalcularEObter(organizacaoId, pid);
}
