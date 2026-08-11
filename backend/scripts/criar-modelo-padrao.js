// =====================================================================
// CRIAR MODELO PADRÃO — snapshot ESTÁTICO de uma empresa, uma única vez
// =====================================================================
// Roda UMA VEZ (depois da migration 030). Cria uma nova organização marcada
// `eh_modelo = true` (não aparece na lista normal de Empresas — só no
// seletor "Modelo inicial" do assistente de criação) e clona para dentro
// dela, com IDs NOVOS, o catálogo atual da empresa de origem:
//
//   categorias -> insumos -> produtos -> ficha_tecnica -> produto_precos
//
// A cópia é ESTÁTICA DE PROPÓSITO: depois de rodar, o Modelo Padrão não tem
// nenhum vínculo com a empresa de origem. Editar preço, ficha técnica ou
// qualquer coisa na empresa de origem NÃO muda o modelo — e vice-versa. É
// exatamente o "só uma vez e pronto" pedido: se quiser atualizar o modelo
// mais tarde, rode de novo contra um modelo NOVO (este script recusa rodar
// duas vezes para o MESMO nome de modelo, para nunca duplicar).
//
// O QUE NÃO É CLONADO (fora do escopo pedido — só catálogo):
//   * fornecedores (insumos ficam com fornecedor_id = null no modelo);
//   * canais_venda (comissão por canal é configuração da empresa, não do
//     catálogo);
//   * unidades, usuários, vendas, estoque, integrações — o modelo é só
//     Produtos/Insumos/Ficha técnica/Categorias, como pedido.
//   * módulos habilitados — o modelo não é uma empresa operável, não entra
//     na lista normal, não precisa de módulos.
//
// A clonagem em si (produto por produto, ficha por ficha) usa a MESMA
// estrutura de tabelas que já existe — nenhuma tabela nova além do que a
// migration 030 já criou (organizacoes.eh_modelo/modelo_origem_id).
//
// PRÉ-REQUISITO: migration 030 aplicada.
// IDEMPOTENTE quanto a duplicar: se já existe uma organização com
// eh_modelo=true e o mesmo nome de modelo, o script recusa e não faz nada.
//
// USO:
//   npm --prefix backend run modelo:padrao
//   (equivale a: node --env-file=.env scripts/criar-modelo-padrao.js)
//
// Parâmetros (variáveis de ambiente, todas opcionais):
//   ORIGEM_ORGANIZACAO_ID  id exato da empresa de origem (pula a busca por nome)
//   ORIGEM_EMPRESA_NOME    termo de busca pelo nome (default: "Subway Saci")
//   MODELO_NOME            nome do Modelo Padrão criado (default: "Subway Padrão")
// =====================================================================

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import ws from "ws";
if (!globalThis.WebSocket) globalThis.WebSocket = ws; // Node < 22

const ORIGEM_ORGANIZACAO_ID = process.env.ORIGEM_ORGANIZACAO_ID || null;
const ORIGEM_EMPRESA_NOME = process.env.ORIGEM_EMPRESA_NOME || "Subway Saci";
const MODELO_NOME = process.env.MODELO_NOME || "Subway Padrão";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no ambiente. Rode com --env-file=.env.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const log = (...a) => console.log(...a);
const passo = (n, t) => console.log(`\n[${n}] ${t}`);

/** Insere em lotes — evita um único INSERT gigante se o catálogo for grande. */
async function inserirEmLotes(tabela, linhas, tamanhoLote = 500) {
  for (let i = 0; i < linhas.length; i += tamanhoLote) {
    const lote = linhas.slice(i, i + tamanhoLote);
    const { error } = await sb.from(tabela).insert(lote);
    if (error) throw new Error(`insert ${tabela} (lote ${i}-${i + lote.length}): ${error.message}`);
  }
}

async function main() {
  log("=== CRIAR MODELO PADRÃO — Crescer com Delivery ===");
  log(`Modelo a criar : ${MODELO_NOME}`);

  // ---------------------------------------------------------------------
  // 0. Confirma que a migration 030 foi aplicada antes de mexer em qualquer coisa.
  // ---------------------------------------------------------------------
  const schemaErr = (await sb.from("modulos").select("id").limit(1)).error;
  if (schemaErr) {
    console.error(`\n✗ A tabela "modulos" não respondeu (${schemaErr.message}).`);
    console.error("  Aplique a migration 030 no Supabase (SQL Editor) ANTES de rodar este script.");
    process.exit(1);
  }

  // ---------------------------------------------------------------------
  // 1. Recusa duplicar: já existe um modelo com este nome?
  // ---------------------------------------------------------------------
  passo(1, "Verificando se o Modelo Padrão já existe");
  const { data: existente, error: eExistente } = await sb
    .from("organizacoes").select("id, created_at").eq("eh_modelo", true).eq("nome", MODELO_NOME).maybeSingle();
  if (eExistente) throw new Error(`organizacoes(select existente): ${eExistente.message}`);
  if (existente) {
    console.error(`\n✗ Já existe um Modelo Padrão chamado "${MODELO_NOME}" (id ${existente.id}, criado em ${existente.created_at}).`);
    console.error("  Este script não roda duas vezes para o mesmo nome — para atualizar, apague o modelo antigo");
    console.error("  no painel SuperAdmin ou rode com outro MODELO_NOME.");
    process.exit(1);
  }
  log("  ✓ Nenhum modelo com este nome ainda. Prosseguindo.");

  // ---------------------------------------------------------------------
  // 2. Localiza a empresa de origem.
  // ---------------------------------------------------------------------
  passo(2, "Localizando a empresa de origem");
  let origem;
  if (ORIGEM_ORGANIZACAO_ID) {
    const { data, error } = await sb.from("organizacoes").select("id, nome").eq("id", ORIGEM_ORGANIZACAO_ID).maybeSingle();
    if (error) throw new Error(`organizacoes(por id): ${error.message}`);
    if (!data) throw new Error(`Nenhuma organização com id ${ORIGEM_ORGANIZACAO_ID}.`);
    origem = data;
  } else {
    const { data, error } = await sb.from("organizacoes").select("id, nome").ilike("nome", `%${ORIGEM_EMPRESA_NOME}%`);
    if (error) throw new Error(`organizacoes(busca por nome): ${error.message}`);
    if (!data?.length) {
      // Nenhuma bateu com o termo — lista TODAS as organizações cadastradas
      // para o operador identificar o nome exato de uma vez, sem precisar
      // adivinhar numa segunda rodada.
      const { data: todas, error: eTodas } = await sb.from("organizacoes").select("id, nome, eh_modelo").order("nome");
      console.error(`\n✗ Nenhuma organização com nome contendo "${ORIGEM_EMPRESA_NOME}".`);
      if (eTodas) {
        console.error(`  (Também falhou ao listar as organizações existentes: ${eTodas.message})`);
      } else if (!todas?.length) {
        console.error("  Aliás, não há NENHUMA organização cadastrada ainda — crie a empresa de origem antes.");
      } else {
        console.error("  Organizações cadastradas:");
        todas.forEach((o) => console.error(`    - ${o.nome} (${o.id})${o.eh_modelo ? "  [já é um modelo]" : ""}`));
      }
      console.error(`  Rode de novo com ORIGEM_EMPRESA_NOME="<parte do nome certo>" ou ORIGEM_ORGANIZACAO_ID=<id>.`);
      process.exit(1);
    }
    if (data.length > 1) {
      console.error(`\n✗ Mais de uma organização encontrada para "${ORIGEM_EMPRESA_NOME}":`);
      data.forEach((o) => console.error(`    - ${o.nome} (${o.id})`));
      console.error("  Defina ORIGEM_ORGANIZACAO_ID explicitamente para escolher uma.");
      process.exit(1);
    }
    origem = data[0];
  }
  log(`  ✓ Origem: ${origem.nome} (${origem.id})`);

  // ---------------------------------------------------------------------
  // 3. Cria a organização-modelo (vazia — o catálogo entra nos passos seguintes).
  // ---------------------------------------------------------------------
  passo(3, "Criando a organização do Modelo Padrão");
  const { data: modelo, error: eModelo } = await sb.from("organizacoes").insert({
    nome: MODELO_NOME,
    status: "ativa",
    ativo: true,
    eh_modelo: true,
    observacoes:
      `Modelo Padrão gerado a partir de "${origem.nome}" em ${new Date().toISOString().slice(0, 10)}. ` +
      "Cópia estática: alterações na empresa de origem, feitas depois desta data, NÃO afetam este modelo.",
  }).select("id, nome").single();
  if (eModelo) throw new Error(`organizacoes(insert modelo): ${eModelo.message}`);
  log(`  ✓ Modelo criado: ${modelo.nome} (${modelo.id})`);

  // ---------------------------------------------------------------------
  // 4. Categorias
  // ---------------------------------------------------------------------
  passo(4, "Clonando categorias");
  const { data: categoriasOrigem, error: eCatSel } = await sb
    .from("categorias").select("*").eq("organizacao_id", origem.id);
  if (eCatSel) throw new Error(`categorias(select): ${eCatSel.message}`);

  const mapaCategorias = new Map(); // id antigo -> id novo
  const categoriasNovas = (categoriasOrigem ?? []).map((c) => {
    const novoId = randomUUID();
    mapaCategorias.set(c.id, novoId);
    return { id: novoId, organizacao_id: modelo.id, nome: c.nome, tipo: c.tipo, ordem: c.ordem, ativo: c.ativo };
  });
  await inserirEmLotes("categorias", categoriasNovas);
  log(`  ✓ ${categoriasNovas.length} categoria(s) clonada(s).`);

  // ---------------------------------------------------------------------
  // 5. Insumos (fornecedor_id fica null — fornecedores não fazem parte do modelo)
  // ---------------------------------------------------------------------
  passo(5, "Clonando insumos");
  const { data: insumosOrigem, error: eInsSel } = await sb
    .from("insumos").select("*").eq("organizacao_id", origem.id);
  if (eInsSel) throw new Error(`insumos(select): ${eInsSel.message}`);

  const mapaInsumos = new Map();
  const insumosNovos = (insumosOrigem ?? []).map((i) => {
    const novoId = randomUUID();
    mapaInsumos.set(i.id, novoId);
    return {
      id: novoId, organizacao_id: modelo.id,
      categoria_id: i.categoria_id ? (mapaCategorias.get(i.categoria_id) ?? null) : null,
      fornecedor_id: null,
      codigo: i.codigo, nome: i.nome, tipo: i.tipo, unidade_medida: i.unidade_medida,
      preco_caixa: i.preco_caixa, rendimento: i.rendimento, fator_correcao: i.fator_correcao,
      preco_unitario: i.preco_unitario, estoque_minimo: i.estoque_minimo, validade_dias: i.validade_dias,
      ativo: i.ativo, descricao: i.descricao, forma_compra: i.forma_compra,
    };
  });
  await inserirEmLotes("insumos", insumosNovos);
  log(`  ✓ ${insumosNovos.length} insumo(s) clonado(s).`);

  // ---------------------------------------------------------------------
  // 6. Produtos (inclui sub-montagens: vendavel=false também é "produto")
  // ---------------------------------------------------------------------
  passo(6, "Clonando produtos");
  const { data: produtosOrigem, error: eProdSel } = await sb
    .from("produtos").select("*").eq("organizacao_id", origem.id);
  if (eProdSel) throw new Error(`produtos(select): ${eProdSel.message}`);

  const mapaProdutos = new Map();
  const produtosNovos = (produtosOrigem ?? []).map((p) => {
    const novoId = randomUUID();
    mapaProdutos.set(p.id, novoId);
    return {
      id: novoId, organizacao_id: modelo.id,
      categoria_id: p.categoria_id ? (mapaCategorias.get(p.categoria_id) ?? null) : null,
      tipo: p.tipo, nome: p.nome, sku: p.sku, codigo_pdv: p.codigo_pdv, tamanho: p.tamanho,
      vendavel: p.vendavel, custo_manual: p.custo_manual, imagem_url: p.imagem_url, ativo: p.ativo,
      // custo_cache fica null de propósito — é recalculado ao vivo pela ficha técnica
      // (ver backend/src/modules/produtos/custo.js), não precisa ser "adivinhado" aqui.
    };
  });
  await inserirEmLotes("produtos", produtosNovos);
  log(`  ✓ ${produtosNovos.length} produto(s)/sub-montagem(ns) clonado(s).`);

  // ---------------------------------------------------------------------
  // 7. Ficha técnica — remapeia produto_id, insumo_id e subproduto_id.
  //    Como TODOS os produtos já foram clonados no passo 6, referências
  //    produto->produto (subproduto_id) resolvem sem depender de ordem.
  // ---------------------------------------------------------------------
  passo(7, "Clonando fichas técnicas");
  const idsProdutosOrigem = (produtosOrigem ?? []).map((p) => p.id);
  let fichaOrigem = [];
  if (idsProdutosOrigem.length) {
    const { data, error } = await sb.from("ficha_tecnica").select("*").in("produto_id", idsProdutosOrigem);
    if (error) throw new Error(`ficha_tecnica(select): ${error.message}`);
    fichaOrigem = data ?? [];
  }

  let fichaIgnorada = 0;
  const fichaNova = fichaOrigem.flatMap((f) => {
    const novoProdutoId = mapaProdutos.get(f.produto_id);
    const novoInsumoId = f.insumo_id ? mapaInsumos.get(f.insumo_id) : null;
    const novoSubprodutoId = f.subproduto_id ? mapaProdutos.get(f.subproduto_id) : null;
    // Linha órfã (aponta pra insumo/produto que sumiu do mapa) não é inventada — pulada e contada.
    if (!novoProdutoId || (f.insumo_id && !novoInsumoId) || (f.subproduto_id && !novoSubprodutoId)) {
      fichaIgnorada++;
      return [];
    }
    return [{
      id: randomUUID(), produto_id: novoProdutoId, insumo_id: novoInsumoId, subproduto_id: novoSubprodutoId,
      quantidade: f.quantidade, observacao: f.observacao,
      unidade_uso: f.unidade_uso, quantidade_informada: f.quantidade_informada,
      ordem: f.ordem, ativo: f.ativo,
    }];
  });
  await inserirEmLotes("ficha_tecnica", fichaNova);
  log(`  ✓ ${fichaNova.length} linha(s) de ficha técnica clonada(s).${fichaIgnorada ? ` (${fichaIgnorada} ignorada(s) por referência órfã)` : ""}`);

  // ---------------------------------------------------------------------
  // 8. Preços por canal/tabela
  // ---------------------------------------------------------------------
  passo(8, "Clonando preços");
  let precosOrigem = [];
  if (idsProdutosOrigem.length) {
    const { data, error } = await sb.from("produto_precos").select("*").in("produto_id", idsProdutosOrigem);
    if (error) throw new Error(`produto_precos(select): ${error.message}`);
    precosOrigem = data ?? [];
  }
  const precosNovos = precosOrigem.flatMap((pr) => {
    const novoProdutoId = mapaProdutos.get(pr.produto_id);
    if (!novoProdutoId) return [];
    return [{
      id: randomUUID(), produto_id: novoProdutoId, canal: pr.canal, tabela: pr.tabela,
      preco: pr.preco, desatualizado: pr.desatualizado,
    }];
  });
  await inserirEmLotes("produto_precos", precosNovos);
  log(`  ✓ ${precosNovos.length} preço(s) clonado(s).`);

  // ---------------------------------------------------------------------
  // 9. Auditoria (imutável — fica registrado quem/quando/de onde).
  // ---------------------------------------------------------------------
  await sb.from("plataforma_auditoria").insert({
    ator_tipo: "sistema", acao: "modelo_padrao.criado",
    entidade: "organizacao", entidade_id: modelo.id, organizacao_id: modelo.id,
    detalhes: {
      nome: modelo.nome, origem: origem.nome, origemId: origem.id,
      categorias: categoriasNovas.length, insumos: insumosNovos.length,
      produtos: produtosNovos.length, fichaTecnica: fichaNova.length, precos: precosNovos.length,
      fichaIgnorada,
    },
  });

  // ---------------------------------------------------------------------
  log("\n=== CONCLUÍDO ===");
  log(`Modelo Padrão : ${modelo.nome} (${modelo.id})`);
  log(`Origem        : ${origem.nome} — cópia estática, não muda mais com a origem`);
  log(`Categorias    : ${categoriasNovas.length}`);
  log(`Insumos       : ${insumosNovos.length}`);
  log(`Produtos      : ${produtosNovos.length}`);
  log(`Ficha técnica : ${fichaNova.length}${fichaIgnorada ? ` (${fichaIgnorada} ignorada)` : ""}`);
  log(`Preços        : ${precosNovos.length}`);
  log('\nJá aparece em "Modelo inicial" no assistente de Nova Empresa do Painel SuperAdmin.');
}

main().catch((e) => {
  console.error(`\n✗ FALHOU: ${e.message}`);
  console.error("  A organização do modelo pode ter ficado parcialmente criada. Verifique no painel");
  console.error("  (Empresas -> filtre por modelo) e, se preciso, apague-a antes de rodar de novo.");
  process.exit(1);
});
