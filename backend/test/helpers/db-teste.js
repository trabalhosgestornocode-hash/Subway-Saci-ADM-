// =====================================================================
// GUARDA DE BANCO DE TESTE — conexão PostgreSQL DIRETA
// =====================================================================
// Qualquer teste/script/diagnóstico que abra uma conexão `pg` direta (fora
// do Supabase HTTP/PostgREST) DEVE passar por `assertBancoDeTeste()` antes
// de qualquer escrita.
//
// REGRA CRÍTICA
//   * conexão direta  -> SÓ  process.env.DATABASE_TESTE_URL
//   * NUNCA            ->    process.env.DATABASE_URL  (produção)
//   * NUNCA            ->    fallback para produção
//   * DATABASE_TESTE_URL ausente / placeholder / apontando p/ produção
//                       ->  ABORTA com mensagem clara
//
// Supabase HTTP/Auth/PostgREST continua usando TEST_SUPABASE_* — são coisas
// diferentes e NÃO se substituem.
// =====================================================================

/** Mensagem única de aborto — o texto é contratual (usado em asserts). */
export const MSG_ABORTO =
  "DATABASE_TESTE_URL não configurada. Teste abortado para evitar acesso acidental à produção.";

let jaAvisouLegado = false;

/**
 * Lê a URL de conexão direta do banco de TESTE.
 * Aceita o nome padronizado `DATABASE_TESTE_URL` e, por compatibilidade, o
 * nome legado `DATABASETESTE_URL` (com aviso). Retorna `null` se nenhum existir.
 */
export function urlBancoDeTeste(env = process.env) {
  const padrao = (env.DATABASE_TESTE_URL || "").trim();
  if (padrao) return padrao;
  const legado = (env.DATABASETESTE_URL || "").trim();
  if (legado) {
    if (!jaAvisouLegado) {
      jaAvisouLegado = true;
      console.warn(
        "[db-teste] usando o nome legado DATABASETESTE_URL; padronize para DATABASE_TESTE_URL."
      );
    }
    return legado;
  }
  return null;
}

/** Extrai o host (sem porta) de uma URL postgres, ou "" se não parsear. */
export function hostDe(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    const m = /^[a-z]+:\/\/[^@/]*@?([^:/?]+)/i.exec(url);
    return m ? m[1].toLowerCase() : "";
  }
}

/** Extrai só a senha da URL (para detectar placeholder), sem logá-la. */
function senhaDe(url) {
  try {
    return decodeURIComponent(new URL(url).password || "");
  } catch {
    const m = /^[a-z]+:\/\/[^:/@]+:([^@]*)@/i.exec(url || "");
    return m ? m[1] : "";
  }
}

/**
 * `true` quando a URL ainda tem senha de template (copiada do painel do
 * Supabase sem substituir): `[YOUR-PASSWORD]`, `<senha>`, `SUA_SENHA`, etc.
 */
export function parecePlaceholder(url) {
  const senha = senhaDe(url);
  if (!senha) return true; // sem senha = não utilizável
  // `_` conta como caractere de palavra, então `\b` não isola SUA_SENHA — por
  // isso o teste é por substring (guarda conservadora: na dúvida, aborta).
  return (
    /[[\]<>{}]/.test(senha) ||
    /(your|sua[-_ ]?senha|senha|password|change[-_ ]?me|placeholder|exemplo|example|xxxx)/i.test(
      senha
    )
  );
}

/**
 * `true` quando o host de teste coincide com o de produção
 * (SUPABASE_URL ou DATABASE_URL) — o mesmo projeto Supabase.
 */
export function pareceProducao(url, env = process.env) {
  const alvo = hostDe(url);
  if (!alvo) return false;
  const refAlvo = alvo.replace(/^db\./, "").replace(/^aws-\d+-[^.]+\.pooler\./, "");
  const candidatos = [
    hostDe(env.DATABASE_URL),
    hostDe(env.SUPABASE_URL),
  ].filter(Boolean);
  return candidatos.some((h) => {
    const ref = h.replace(/^db\./, "");
    return h === alvo || ref === refAlvo || alvo.includes(ref) || h.includes(refAlvo);
  });
}

/**
 * Porta de entrada obrigatória. Lança `Error(MSG_ABORTO)` quando a
 * `DATABASE_TESTE_URL` está ausente; lança erro específico quando é
 * placeholder ou quando o alvo coincide com produção.
 *
 * @returns {{ url: string, host: string }} dados seguros de logar (sem senha)
 */
export function assertBancoDeTeste(env = process.env) {
  const url = urlBancoDeTeste(env);
  if (!url) {
    throw new Error(MSG_ABORTO);
  }
  if (pareceProducao(url, env)) {
    throw new Error(
      `DATABASE_TESTE_URL aponta para o mesmo host de produção (${hostDe(url)}). ` +
        "Teste abortado. Use um projeto Supabase DESCARTÁVEL."
    );
  }
  if (parecePlaceholder(url)) {
    throw new Error(
      "DATABASE_TESTE_URL contém senha de template (placeholder). " +
        "Substitua pelo valor real do projeto de teste. Teste abortado."
    );
  }
  return { url, host: hostDe(url) };
}
