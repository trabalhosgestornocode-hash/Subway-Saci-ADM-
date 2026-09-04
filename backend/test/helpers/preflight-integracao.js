// Guarda para as suítes de INTEGRAÇÃO que exercitam um service real contra o
// Supabase configurado em `src/config/supabase.js` (ou seja: contra
// process.env.SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).
//
// PROBLEMA que isto resolve: essas suítes foram escritas "rodam contra o
// Supabase de produção, sempre numa unidade de teste isolada". Sob `npm test`
// (que carrega o `.env` normal) elas abriam conexão com PRODUÇÃO. A regra da
// Fase P0.4 é: teste NUNCA toca produção.
//
// REGRA: a suíte só roda quando o Supabase configurado é comprovadamente
// DESCARTÁVEL. É considerado descartável quando:
//   * SUPABASE_URL === TEST_SUPABASE_URL   (o operador apontou o app para o
//     projeto de teste de propósito — ver `npm run test:integracao`), ou
//   * INTEGRACAO_SUPABASE_DESCARTAVEL === "1"  (confirmação explícita).
// Caso contrário: PULA (não é falha) com um motivo claro.
//
// Diferente de preflight-supabase.js: aquele guarda os testes que criam seu
// PRÓPRIO cliente com TEST_SUPABASE_* + createClient; este guarda os que usam
// o cliente global do app.

/** @returns {string|false} string com o motivo do skip, ou `false` para rodar. */
export function motivoPularIntegracao(env = process.env) {
  const url = (env.SUPABASE_URL || "").trim();
  const testUrl = (env.TEST_SUPABASE_URL || "").trim();

  if (!url || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return "[SUPABASE AUSENTE] defina SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY "
      + "para um projeto de TESTE (veja npm run test:integracao). PULADO — não é falha.";
  }
  if (env.INTEGRACAO_SUPABASE_DESCARTAVEL === "1") return false;
  if (testUrl && url === testUrl) return false;

  return "[ALVO NAO CONFIRMADO COMO TESTE] esta suite exercita um service real "
    + "contra process.env.SUPABASE_URL e NAO roda contra producao. "
    + "Rode com `npm run test:integracao` (ou aponte SUPABASE_URL para o projeto "
    + "de teste e defina INTEGRACAO_SUPABASE_DESCARTAVEL=1). PULADO — nao e falha.";
}
