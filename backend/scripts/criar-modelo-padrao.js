// =====================================================================
// CRIAR MODELO PADRÃO — snapshot ESTÁTICO de uma empresa, uma única vez
// =====================================================================
// Roda UMA VEZ (depois da migration 030). Cria uma nova organização marcada
// `eh_modelo = true` (não aparece na lista normal de Empresas — só no
// seletor "Modelo inicial" do assistente de criação) e clona para dentro
// dela, com IDs NOVOS, o catálogo atual da empresa de origem — a lógica de
// clonagem em si mora em src/shared/clonarCatalogo.js (mesmo código que o
// Painel SuperAdmin usa ao criar uma empresa a partir de um modelo).
//
// A cópia é ESTÁTICA DE PROPÓSITO: depois de rodar, o Modelo Padrão não tem
// nenhum vínculo com a empresa de origem. Editar preço, ficha técnica ou
// qualquer coisa na empresa de origem NÃO muda o modelo — e vice-versa. É
// exatamente o "só uma vez e pronto" pedido: se quiser atualizar o modelo
// mais tarde, rode de novo contra um modelo NOVO (este script recusa rodar
// duas vezes para o MESMO nome de modelo, para nunca duplicar).
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
import ws from "ws";
import { clonarCatalogo } from "../src/shared/clonarCatalogo.js";
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
  // 3. Cria a organização-modelo (vazia — o catálogo entra no passo seguinte).
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
  // 4. Clona o catálogo (categorias -> insumos -> produtos -> ficha técnica -> preços).
  // ---------------------------------------------------------------------
  passo(4, "Clonando o catálogo");
  const r = await clonarCatalogo(sb, { origemId: origem.id, destinoId: modelo.id });
  log(`  ✓ ${r.categorias} categoria(s), ${r.insumos} insumo(s), ${r.produtos} produto(s)/sub-montagem(ns),`);
  log(`    ${r.fichaTecnica} linha(s) de ficha técnica${r.fichaIgnorada ? ` (${r.fichaIgnorada} ignorada(s) por referência órfã)` : ""}, ${r.precos} preço(s).`);

  // ---------------------------------------------------------------------
  // 5. Auditoria (imutável — fica registrado quem/quando/de onde).
  // ---------------------------------------------------------------------
  await sb.from("plataforma_auditoria").insert({
    ator_tipo: "sistema", acao: "modelo_padrao.criado",
    entidade: "organizacao", entidade_id: modelo.id, organizacao_id: modelo.id,
    detalhes: { nome: modelo.nome, origem: origem.nome, origemId: origem.id, ...r },
  });

  // ---------------------------------------------------------------------
  log("\n=== CONCLUÍDO ===");
  log(`Modelo Padrão : ${modelo.nome} (${modelo.id})`);
  log(`Origem        : ${origem.nome} — cópia estática, não muda mais com a origem`);
  log(`Categorias    : ${r.categorias}`);
  log(`Insumos       : ${r.insumos}`);
  log(`Produtos      : ${r.produtos}`);
  log(`Ficha técnica : ${r.fichaTecnica}${r.fichaIgnorada ? ` (${r.fichaIgnorada} ignorada)` : ""}`);
  log(`Preços        : ${r.precos}`);
  log('\nJá aparece em "Modelo inicial" no assistente de Nova Empresa do Painel SuperAdmin.');
}

main().catch((e) => {
  console.error(`\n✗ FALHOU: ${e.message}`);
  console.error("  A organização do modelo pode ter ficado parcialmente criada. Verifique no painel");
  console.error("  (Empresas -> filtre por modelo) e, se preciso, apague-a antes de rodar de novo.");
  process.exit(1);
});
