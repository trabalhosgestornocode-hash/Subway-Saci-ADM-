import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";

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

// Produto + ficha técnica EXPLODIDA (até o insumo cru) + preços.
export async function obterProduto({ organizacaoId, id }) {
  const { data: produto, error } = await supabase
    .from("produtos")
    .select("*")
    .eq("organizacao_id", organizacaoId)
    .eq("id", id)
    .single();
  if (error || !produto) throw ApiError.notFound("Produto não encontrado");

  // Datasets pequenos: carrega tudo e resolve a árvore em memória.
  const [fichasRes, insumosRes, produtosRes, precosRes] = await Promise.all([
    supabase.from("ficha_tecnica").select("produto_id, insumo_id, subproduto_id, quantidade"),
    supabase.from("insumos").select("id, nome, unidade_medida, preco_unitario").eq("organizacao_id", organizacaoId),
    supabase.from("produtos").select("id, nome").eq("organizacao_id", organizacaoId),
    supabase.from("produto_precos").select("canal, tabela, preco, desatualizado").eq("produto_id", id).order("canal"),
  ]);
  for (const r of [fichasRes, insumosRes, produtosRes, precosRes]) {
    if (r.error) throw ApiError.internal(r.error.message);
  }

  const insumoById = Object.fromEntries((insumosRes.data ?? []).map((i) => [i.id, i]));
  const nomeProdById = Object.fromEntries((produtosRes.data ?? []).map((p) => [p.id, p.nome]));
  const fichaByProd = {};
  for (const f of fichasRes.data ?? []) (fichaByProd[f.produto_id] ??= []).push(f);

  // Explode recursivamente acumulando quantidade por insumo cru.
  const acumulado = {};
  const explode = (pid, mult, prof = 0) => {
    if (prof > 10) return; // trava de segurança contra ciclo
    for (const f of fichaByProd[pid] ?? []) {
      const q = Number(f.quantidade) * mult;
      if (f.insumo_id) acumulado[f.insumo_id] = (acumulado[f.insumo_id] ?? 0) + q;
      else if (f.subproduto_id) explode(f.subproduto_id, q, prof + 1);
    }
  };
  explode(id, 1);

  const ingredientes = Object.entries(acumulado)
    .map(([iid, q]) => {
      const ins = insumoById[iid] ?? {};
      const custoUnit = Number(ins.preco_unitario ?? 0);
      return {
        nome: ins.nome ?? "?",
        unidade: ins.unidade_medida ?? null,
        quantidade: q,
        custo_unitario: custoUnit,
        custo_total: q * custoUnit,
      };
    })
    .sort((a, b) => b.custo_total - a.custo_total);

  // Componentes diretos (1 nível — mostra a estrutura: insumos + sub-montagens)
  const componentes = (fichaByProd[id] ?? []).map((f) =>
    f.insumo_id
      ? { tipo: "insumo", nome: insumoById[f.insumo_id]?.nome ?? "?", quantidade: Number(f.quantidade), unidade: insumoById[f.insumo_id]?.unidade_medida ?? null }
      : { tipo: "submontagem", nome: nomeProdById[f.subproduto_id] ?? "?", quantidade: Number(f.quantidade), unidade: null }
  );

  const custo = ingredientes.reduce((s, r) => s + r.custo_total, 0);

  return { ...produto, custo, ingredientes, componentes, precos: precosRes.data ?? [] };
}

// Atualiza campos do produto e/ou preços (upsert por canal/tabela).
export async function atualizarProduto({ organizacaoId, id, dados }) {
  const { data: existe } = await supabase
    .from("produtos")
    .select("id")
    .eq("organizacao_id", organizacaoId)
    .eq("id", id)
    .single();
  if (!existe) throw ApiError.notFound("Produto não encontrado");

  // 1) Campos básicos do produto
  const campos = {};
  for (const k of ["nome", "tipo", "tamanho", "ativo"]) if (dados[k] !== undefined) campos[k] = dados[k];
  if (campos.nome !== undefined && !String(campos.nome).trim()) throw ApiError.badRequest("Nome não pode ser vazio.");
  if (Object.keys(campos).length) {
    const { error } = await supabase.from("produtos").update(campos).eq("id", id).eq("organizacao_id", organizacaoId);
    if (error) throw ApiError.badRequest(error.message);
  }

  // 2) Preços (upsert por produto/canal/tabela)
  if (Array.isArray(dados.precos)) {
    const rows = dados.precos
      .filter((p) => p.canal && p.preco !== "" && Number(p.preco) >= 0)
      .map((p) => ({ produto_id: id, canal: p.canal, tabela: p.tabela ?? null, preco: Number(p.preco), desatualizado: !!p.desatualizado }));
    if (rows.length) {
      const { error } = await supabase.from("produto_precos").upsert(rows, { onConflict: "produto_id,canal,tabela" });
      if (error) throw ApiError.badRequest(error.message);
    }
  }

  return obterProduto({ organizacaoId, id });
}
