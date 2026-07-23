// Repositório da integração Martin Brower (Supabase).
//
// ISOLAMENTO — regra inegociável deste arquivo:
//   TODA query filtra organizacao_id E unidade_id. O backend usa service_role
//   (ignora RLS), então esta camada É o isolamento efetivo. Nenhuma função
//   aqui aceita ser chamada sem os dois ids; `exigirTenant` falha alto se
//   faltar, em vez de rodar sem filtro e vazar dados entre lojas.
//
// Os ids vêm SEMPRE de req.tenant (resolvido e validado pelo requireAuth
// contra os vínculos do usuário), nunca do corpo da requisição.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { MB_LOTE_UPSERT } from "./martinbrower.constants.js";
import { sanitizarTermoBusca } from "./martinbrower.validators.js";

const T = {
  integracoes: "martin_brower_integracoes",
  produtos: "martin_brower_produtos",
  historico: "martin_brower_precos_historico",
  sincronizacoes: "martin_brower_sincronizacoes",
  filtros: "martin_brower_filtros",
  vinculos: "martin_brower_vinculos",
};

function exigirTenant(organizacaoId, unidadeId) {
  if (!organizacaoId || !unidadeId) {
    throw ApiError.internal("Escopo de tenant ausente na consulta Martin Brower.");
  }
}

const ok = (res) => {
  if (res.error) throw ApiError.internal(res.error.message);
  return res.data;
};

// --- integração / configuração -------------------------------------------

export async function obterIntegracao({ organizacaoId, unidadeId }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.integracoes)
    .select("*")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("ativo", true)
    .maybeSingle());
}

export async function listarIntegracoesDaOrganizacao({ organizacaoId, unidadeIds }) {
  if (!organizacaoId) throw ApiError.internal("Organização ausente.");
  let q = supabase.from(T.integracoes)
    .select("id, unidade_id, client_id, unidade_nome, ativo, status, ultimo_order_id, ultima_sincronizacao, ultimo_erro")
    .eq("organizacao_id", organizacaoId);
  // Usuário comum só enxerga as unidades às quais tem vínculo.
  if (Array.isArray(unidadeIds)) q = q.in("unidade_id", unidadeIds.length ? unidadeIds : ["00000000-0000-0000-0000-000000000000"]);
  return ok(await q);
}

export async function salvarIntegracao({ organizacaoId, unidadeId, clientId, unidadeNome, ativo = true }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.integracoes)
    .upsert({
      organizacao_id: organizacaoId, unidade_id: unidadeId,
      client_id: clientId, unidade_nome: unidadeNome ?? null,
      ativo, status: "pronto",
    }, { onConflict: "organizacao_id,unidade_id,client_id" })
    .select().single());
}

export async function atualizarStatusIntegracao({ organizacaoId, unidadeId, campos }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.integracoes)
    .update(campos)
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .select().maybeSingle());
}

// --- filtros configuráveis ------------------------------------------------

// Regras da unidade + regras que valem para a organização inteira (unidade_id null).
export async function listarFiltros({ organizacaoId, unidadeId }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.filtros)
    .select("id, tipo, valor, acao, motivo, unidade_id")
    .eq("organizacao_id", organizacaoId).eq("ativo", true)
    .or(`unidade_id.eq.${unidadeId},unidade_id.is.null`));
}

// --- sincronizações -------------------------------------------------------

export async function criarSincronizacao({ organizacaoId, unidadeId, clientId, criadoPor, origem = "worker", status = "aguardando" }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.sincronizacoes)
    .insert({
      organizacao_id: organizacaoId, unidade_id: unidadeId,
      client_id: clientId ?? null, origem, status, criado_por: criadoPor ?? null,
    })
    .select().single());
}

export async function atualizarSincronizacao({ organizacaoId, unidadeId, sincronizacaoId, campos }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.sincronizacoes)
    .update(campos)
    .eq("id", sincronizacaoId).eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .select().maybeSingle());
}

export async function listarSincronizacoes({ organizacaoId, unidadeId, limite = 50 }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.sincronizacoes)
    .select("*")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .order("iniciado_em", { ascending: false })
    .limit(Math.min(Math.max(Number(limite) || 50, 1), 200)));
}

// Sincronização em andamento — base do controle de concorrência persistido.
// O lock em memória (sessions.js) é a primeira barreira; esta é a segunda,
// que sobrevive a um restart do processo no Render.
export async function sincronizacaoEmAndamento({ organizacaoId, unidadeId }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.sincronizacoes)
    .select("id, status, etapa_atual, iniciado_em, criado_por")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .not("status", "in", "(concluido,erro,cancelado,expirado)")
    .order("iniciado_em", { ascending: false })
    .limit(1).maybeSingle());
}

// --- produtos -------------------------------------------------------------

// Mapa codigo -> linha existente. Uma leitura só antes do upsert: evita N+1 e
// dá a base para o diff de preço.
export async function mapearProdutosExistentes({ organizacaoId, unidadeId, clientId }) {
  exigirTenant(organizacaoId, unidadeId);
  const linhas = ok(await supabase.from(T.produtos)
    .select("id, codigo, preco, ignorado, classificacao_manual, primeira_sincronizacao")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("client_id", clientId));
  return new Map((linhas ?? []).map((l) => [l.codigo, l]));
}

// Upsert em lotes pela chave organizacao+unidade+client+codigo.
export async function upsertProdutos({ organizacaoId, unidadeId, linhas }) {
  exigirTenant(organizacaoId, unidadeId);
  const salvos = [];
  const erros = [];

  for (let i = 0; i < linhas.length; i += MB_LOTE_UPSERT) {
    const lote = linhas.slice(i, i + MB_LOTE_UPSERT);
    const res = await supabase.from(T.produtos)
      .upsert(lote, { onConflict: "organizacao_id,unidade_id,client_id,codigo" })
      .select("id, codigo, preco");

    if (res.error) {
      // Um lote quebrado não cancela o catálogo inteiro: reprocessa item a
      // item para isolar quem falhou (regra 12 da spec).
      for (const linha of lote) {
        const r = await supabase.from(T.produtos)
          .upsert(linha, { onConflict: "organizacao_id,unidade_id,client_id,codigo" })
          .select("id, codigo, preco").maybeSingle();
        if (r.error) erros.push({ codigo: linha.codigo, motivo: r.error.message });
        else if (r.data) salvos.push(r.data);
      }
      continue;
    }
    salvos.push(...(res.data ?? []));
  }

  return { salvos, erros };
}

// Produtos que sumiram do catálogo: marca como não vistos. NUNCA exclui —
// só sinaliza para revisão humana (regra 13 da spec).
//
// A diferença é calculada EM MEMÓRIA de propósito. A versão anterior montava
// um filtro `not.in.("a","b")` concatenando string: um código contendo aspas
// — e os códigos vêm do portal, fonte que não controlamos — quebraria o
// filtro e marcaria os produtos errados. Aqui os ids passam pelo `.in()` do
// supabase-js, que faz o encoding.
export async function marcarNaoVistos({ organizacaoId, unidadeId, clientId, codigosVistos }) {
  exigirTenant(organizacaoId, unidadeId);
  const vistos = new Set(codigosVistos);

  const linhas = ok(await supabase.from(T.produtos)
    .select("id, codigo")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).eq("client_id", clientId)
    .eq("visto_na_ultima_sincronizacao", true));

  const sumiram = (linhas ?? []).filter((l) => !vistos.has(l.codigo)).map((l) => l.id);
  if (!sumiram.length) return [];

  const atualizados = [];
  for (let i = 0; i < sumiram.length; i += MB_LOTE_UPSERT) {
    atualizados.push(...(ok(await supabase.from(T.produtos)
      .update({ visto_na_ultima_sincronizacao: false })
      .in("id", sumiram.slice(i, i + MB_LOTE_UPSERT))
      .select("id")) ?? []));
  }
  return atualizados;
}

export async function listarProdutos({ organizacaoId, unidadeId, filtros = {} }) {
  exigirTenant(organizacaoId, unidadeId);
  let q = supabase.from(T.produtos)
    .select("*, martin_brower_vinculos(id, insumo_id, insumos(id, nome))")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId);

  // A busca entra num filtro PostgREST montado como string, onde vírgula,
  // parêntese e ponto são SINTAXE. Sanitiza antes para que o termo digitado
  // não consiga acrescentar condições à consulta.
  const busca = sanitizarTermoBusca(filtros.busca);
  if (busca) q = q.or(`codigo.ilike.%${busca}%,descricao.ilike.%${busca}%`);
  if (filtros.grupo) q = q.eq("grupo_descricao", filtros.grupo);
  if (filtros.familia) q = q.eq("familia", filtros.familia);
  if (filtros.ignorado === "true") q = q.eq("ignorado", true);
  if (filtros.ignorado === "false") q = q.eq("ignorado", false);
  if (filtros.ativo === "true") q = q.eq("ativo", true);
  if (filtros.ativo === "false") q = q.eq("ativo", false);

  const ordem = { descricao: "descricao", codigo: "codigo", preco: "preco", atualizacao: "ultima_sincronizacao" }[filtros.ordem] ?? "descricao";
  q = q.order(ordem, { ascending: filtros.direcao !== "desc" });

  return ok(await q.limit(Math.min(Number(filtros.limite) || 500, 2000)));
}

// --- histórico de preços --------------------------------------------------

export async function inserirHistoricoPrecos({ organizacaoId, unidadeId, registros }) {
  exigirTenant(organizacaoId, unidadeId);
  if (!registros.length) return [];
  const salvos = [];
  for (let i = 0; i < registros.length; i += MB_LOTE_UPSERT) {
    salvos.push(...(ok(await supabase.from(T.historico).insert(registros.slice(i, i + MB_LOTE_UPSERT)).select("id")) ?? []));
  }
  return salvos;
}

export async function listarHistoricoPrecos({ organizacaoId, unidadeId, codigo, limite = 200 }) {
  exigirTenant(organizacaoId, unidadeId);
  let q = supabase.from(T.historico)
    .select("*")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .order("coletado_em", { ascending: false });
  if (codigo) q = q.eq("codigo", codigo);
  return ok(await q.limit(Math.min(Math.max(Number(limite) || 200, 1), 1000)));
}

// --- vínculo com insumo interno (sempre confirmado por humano) ------------

export async function listarSemVinculo({ organizacaoId, unidadeId }) {
  exigirTenant(organizacaoId, unidadeId);
  const produtos = ok(await supabase.from(T.produtos)
    .select("id, codigo, descricao, preco, unidade, grupo_descricao")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .eq("ignorado", false).eq("ativo", true).order("descricao"));

  const vinculados = new Set((ok(await supabase.from(T.vinculos)
    .select("mb_produto_id")
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)) ?? []).map((v) => v.mb_produto_id));

  return (produtos ?? []).filter((p) => !vinculados.has(p.id));
}

export async function criarVinculo({ organizacaoId, unidadeId, mbProdutoId, insumoId, confirmadoPor, observacao }) {
  exigirTenant(organizacaoId, unidadeId);
  // Confere que AMBOS os lados pertencem ao tenant antes de ligar um no outro.
  const prod = ok(await supabase.from(T.produtos).select("id")
    .eq("id", mbProdutoId).eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId).maybeSingle());
  if (!prod) throw ApiError.notFound("Produto Martin Brower não encontrado nesta loja.");

  const insumo = ok(await supabase.from("insumos").select("id")
    .eq("id", insumoId).eq("organizacao_id", organizacaoId).maybeSingle());
  if (!insumo) throw ApiError.notFound("Insumo não encontrado nesta organização.");

  return ok(await supabase.from(T.vinculos)
    .upsert({
      organizacao_id: organizacaoId, unidade_id: unidadeId,
      mb_produto_id: mbProdutoId, insumo_id: insumoId,
      origem: "manual", observacao: observacao ?? null,
      confirmado_por: confirmadoPor ?? null, confirmado_em: new Date().toISOString(),
    }, { onConflict: "mb_produto_id" })
    .select().single());
}

export async function removerVinculo({ organizacaoId, unidadeId, mbProdutoId }) {
  exigirTenant(organizacaoId, unidadeId);
  return ok(await supabase.from(T.vinculos).delete()
    .eq("mb_produto_id", mbProdutoId)
    .eq("organizacao_id", organizacaoId).eq("unidade_id", unidadeId)
    .select("id"));
}
