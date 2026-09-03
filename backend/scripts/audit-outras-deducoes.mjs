// SOMENTE LEITURA — auditoria de `outras_deducoes` antes da migração
// "Ajustes a favor / contra a loja". Não escreve nada.
import { supabase as sb } from "../src/config/supabase.js";

const TABELA = "lancamentos_financeiros_diarios";

const cnt = async (filtro) => {
  let q = sb.from(TABELA).select("id", { count: "exact", head: true });
  q = filtro(q);
  const { count, error } = await q;
  return error ? `erro(${error.message})` : count;
};

const soma = async (filtro) => {
  let q = sb.from(TABELA).select("outras_deducoes");
  q = filtro(q);
  const { data, error } = await q;
  if (error) return `erro(${error.message})`;
  return (data ?? []).reduce((s, r) => s + Number(r.outras_deducoes ?? 0), 0);
};

console.log("=== AUDITORIA outras_deducoes ===\n");

console.log("Total de linhas:", await cnt((q) => q));
console.log("  outras_deducoes IS NULL      :", await cnt((q) => q.is("outras_deducoes", null)));
console.log("  outras_deducoes = 0          :", await cnt((q) => q.eq("outras_deducoes", 0)));
console.log("  outras_deducoes > 0 (positivo):", await cnt((q) => q.gt("outras_deducoes", 0)));
console.log("  outras_deducoes < 0 (negativo):", await cnt((q) => q.lt("outras_deducoes", 0)));

console.log("\nPor origem_lancamento (não-nulo e != 0):");
for (const origem of ["diario", "distribuicao_mensal"]) {
  console.log(`  ${origem}: >0 =`, await cnt((q) => q.eq("origem_lancamento", origem).gt("outras_deducoes", 0)),
    "| <0 =", await cnt((q) => q.eq("origem_lancamento", origem).lt("outras_deducoes", 0)));
}

console.log("\nSomas (R$):");
console.log("  Σ positivos:", await soma((q) => q.gt("outras_deducoes", 0)));
console.log("  Σ negativos:", await soma((q) => q.lt("outras_deducoes", 0)));

console.log("\nAmostra de NEGATIVOS (até 50):");
const { data: negs, error } = await sb
  .from(TABELA)
  .select("id, organizacao_id, unidade_id, data_lancamento, status, origem_lancamento, outras_deducoes, justificativa_ajuste")
  .lt("outras_deducoes", 0)
  .order("data_lancamento", { ascending: true })
  .limit(50);
if (error) console.log("  erro:", error.message);
else if (!negs.length) console.log("  (nenhum registro negativo)");
else for (const r of negs) {
  console.log(`  ${r.data_lancamento} | un=${r.unidade_id} | ${r.status}/${r.origem_lancamento} | ${r.outras_deducoes} | just: ${r.justificativa_ajuste ?? "—"}`);
}

console.log("\n=== FIM ===");
process.exit(0);
