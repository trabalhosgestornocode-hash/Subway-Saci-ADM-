import { randomUUID } from "node:crypto";
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
  // Insumos, produtos e preços já saem escopados ao tenant. A ficha técnica não
  // tem organizacao_id próprio (herda via produto_id), então a escopamos pelos
  // produtos DESTA organização — nunca carregar a ficha de todos os tenants.
  const [insumosRes, produtosRes, precosRes] = await Promise.all([
    supabase.from("insumos").select("id, nome, unidade_medida, preco_unitario").eq("organizacao_id", organizacaoId),
    supabase.from("produtos").select("id, nome").eq("organizacao_id", organizacaoId),
    supabase.from("produto_precos").select("canal, tabela, preco, desatualizado").eq("produto_id", id).order("canal"),
  ]);
  for (const r of [insumosRes, produtosRes, precosRes]) {
    if (r.error) throw ApiError.internal(r.error.message);
  }

  // Ficha técnica APENAS dos produtos desta organização (isolamento por tenant).
  const orgProdutoIds = (produtosRes.data ?? []).map((p) => p.id);
  const fichasRes = orgProdutoIds.length
    ? await supabase
        .from("ficha_tecnica")
        .select("produto_id, insumo_id, subproduto_id, quantidade")
        .in("produto_id", orgProdutoIds)
    : { data: [], error: null };
  if (fichasRes.error) throw ApiError.internal(fichasRes.error.message);

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

  const custoCalculado = ingredientes.reduce((s, r) => s + r.custo_total, 0);
  // Custo manual (override) vence o calculado quando definido.
  const custoManual = produto.custo_manual != null ? Number(produto.custo_manual) : null;
  const custo = custoManual != null ? custoManual : custoCalculado;

  return { ...produto, custo, custo_calculado: custoCalculado, custo_manual: custoManual, ingredientes, componentes, precos: precosRes.data ?? [] };
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
