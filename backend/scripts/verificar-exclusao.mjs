// Verificação da exclusão de produto/insumo. NÃO apaga dado real:
//  - caminho BLOQUEADO: testado contra registros reais (a operação recusa).
//  - caminho PERMITIDO: cria um registro temporário e o exclui.
import { supabase as sb } from "../src/config/supabase.js";
import { excluirInsumo } from "../src/modules/insumos/insumos.service.js";
import { excluirProduto } from "../src/modules/produtos/produtos.service.js";
const ORG = process.env.DEFAULT_ORG_ID;
const ok = (s) => console.log("  ✓", s);
const bad = (s) => { console.log("  ✗", s); process.exitCode = 1; };

console.log("1) Insumo EM USO em ficha deve ser BLOQUEADO");
const { data: emUso } = await sb.from("ficha_tecnica").select("insumo_id").not("insumo_id", "is", null).limit(1);
const alvo = emUso?.[0]?.insumo_id;
if (!alvo) console.log("  (sem ficha para testar)");
else {
  try { await excluirInsumo({ organizacaoId: ORG, id: alvo }); bad("excluiu um insumo em uso!"); }
  catch (e) {
    if (e.statusCode === 409 && /ficha técnica/i.test(e.message)) ok(`bloqueado corretamente: "${e.message.slice(0, 90)}…"`);
    else bad(`erro inesperado: ${e.message}`);
    const { data } = await sb.from("insumos").select("id").eq("id", alvo).maybeSingle();
    data ? ok("o insumo continua existindo (nada foi apagado)") : bad("o insumo sumiu!");
  }
}

console.log("\n2) Produto usado como COMPONENTE de outro deve ser BLOQUEADO");
const { data: sub } = await sb.from("ficha_tecnica").select("subproduto_id").not("subproduto_id", "is", null).limit(1);
if (!sub?.length) console.log("  (nenhuma submontagem em uso — cenário não aplicável)");
else {
  try { await excluirProduto({ organizacaoId: ORG, id: sub[0].subproduto_id }); bad("excluiu um produto usado como componente!"); }
  catch (e) { e.statusCode === 409 ? ok(`bloqueado: "${e.message.slice(0, 80)}…"`) : bad(`inesperado: ${e.message}`); }
}

console.log("\n3) Insumo LIVRE deve ser EXCLUÍDO (registro temporário)");
const { data: novo, error: eIns } = await sb.from("insumos")
  .insert({ organizacao_id: ORG, nome: "__TESTE EXCLUSAO__", tipo: "outro", unidade_medida: "un", preco_unitario: 1, ativo: true })
  .select("id").single();
if (eIns) bad("não criou o insumo de teste: " + eIns.message);
else {
  await excluirInsumo({ organizacaoId: ORG, id: novo.id });
  const { data } = await sb.from("insumos").select("id").eq("id", novo.id).maybeSingle();
  data ? bad("o insumo temporário NÃO foi excluído") : ok("insumo livre excluído com sucesso");
}

console.log("\n4) Produto LIVRE deve ser EXCLUÍDO junto com ficha e preços (temporário)");
const { data: p, error: eP } = await sb.from("produtos")
  .insert({ organizacao_id: ORG, nome: "__TESTE EXCLUSAO PROD__", tipo: "outro", vendavel: true, ativo: true })
  .select("id").single();
if (eP) bad("não criou o produto de teste: " + eP.message);
else {
  const { data: algum } = await sb.from("insumos").select("id").eq("organizacao_id", ORG).limit(1);
  await sb.from("ficha_tecnica").insert({ produto_id: p.id, insumo_id: algum[0].id, quantidade: 1 });
  await sb.from("produto_precos").insert({ produto_id: p.id, canal: "balcao", tabela: "TESTE", preco: 9.9 });
  await excluirProduto({ organizacaoId: ORG, id: p.id });
  const [{ data: dp }, { data: df }, { data: dpr }] = await Promise.all([
    sb.from("produtos").select("id").eq("id", p.id).maybeSingle(),
    sb.from("ficha_tecnica").select("id").eq("produto_id", p.id),
    sb.from("produto_precos").select("id").eq("produto_id", p.id),
  ]);
  dp ? bad("o produto NÃO foi excluído") : ok("produto excluído");
  (df ?? []).length ? bad("a ficha ficou órfã") : ok("ficha removida em cascade");
  (dpr ?? []).length ? bad("os preços ficaram órfãos") : ok("preços removidos em cascade");
}

console.log("\n5) Isolamento: excluir com organização errada deve dar 404");
const { data: qualquer } = await sb.from("insumos").select("id").eq("organizacao_id", ORG).limit(1);
try { await excluirInsumo({ organizacaoId: "00000000-0000-0000-0000-0000000000ff", id: qualquer[0].id }); bad("excluiu insumo de outra organização!"); }
catch (e) { e.statusCode === 404 ? ok("recusado (404) — isolamento por organização preservado") : bad(`inesperado: ${e.message}`); }

console.log(process.exitCode ? "\nFALHOU" : "\nTODAS AS VERIFICAÇÕES PASSARAM");
