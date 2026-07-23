// Preflight compartilhado dos testes de integração contra Supabase real.
//
// OBJETIVO: quando algo dá errado, dizer EXATAMENTE o quê. A versão anterior
// tinha uma única mensagem ("as chaves devem estar trocadas") que apontava
// para a causa errada na maioria dos casos — e custou tempo de diagnóstico.
//
// Distingue sete situações, que exigem ações completamente diferentes:
//   1. tentativa de execução contra PRODUÇÃO      -> abortar, jamais rodar
//   2. variáveis de teste ausentes                -> pular (não é erro)
//   3. credencial de teste INVÁLIDA               -> gerar chave nova
//   4. credencial no slot errado                  -> trocar SERVICE <-> ANON
//   5. tabela / migration ausente                 -> aplicar a migration X
//   6. política RLS ausente                       -> aplicar a migration de RLS
//   7. usuário de teste sem vínculo               -> falha de SETUP do teste
// A oitava — falha real de isolamento — é o que os testes em si detectam, e
// deve ser inconfundível com qualquer uma das acima.
//
// NÃO altera a lógica de segurança: as guardas anti-produção continuam sendo
// as mesmas, apenas com diagnóstico melhor.

// --- 1 e 2: as guardas, antes de qualquer conexão -------------------------

/**
 * Decide se a suíte deve rodar. Retorna `false` para rodar, ou a string com o
 * motivo do skip (formato esperado pelo `{ skip }` do node:test).
 */
export function motivoParaPular({ url, service, anon, urlProducao, confirmaDescartavel }) {
  if (!url || !service || !anon) {
    return "[VARIAVEIS AUSENTES] defina TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_ROLE_KEY / "
         + "TEST_SUPABASE_ANON_KEY em backend/.env.test (veja .env.test.example). "
         + "Isto NAO e uma falha: sem projeto de teste, a suite e pulada.";
  }
  if (urlProducao && url === urlProducao) {
    return "[ALVO E PRODUCAO] TEST_SUPABASE_URL e igual a SUPABASE_URL — RECUSADO. "
         + "Este teste CRIA e APAGA organizacoes, usuarios e dados. "
         + "Aponte TEST_SUPABASE_URL para um projeto DESCARTAVEL.";
  }
  if (!confirmaDescartavel) {
    return "[CONFIRMACAO AUSENTE] defina ISOLATION_TEST_DISPOSABLE=1 para confirmar que o alvo "
         + "e um projeto DESCARTAVEL. Este teste CRIA e APAGA dados — nunca aponte para producao.";
  }
  return false;
}

// --- 3 e 4: a credencial ---------------------------------------------------

/**
 * Confirma que a chave em SERVICE tem mesmo poder de service_role.
 * `auth.admin` só responde à secret, então é o teste definitivo.
 * @throws Error com diagnóstico específico da causa
 */
export async function verificarCredencial(admin, chaveService) {
  const { error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (!error) return;

  // Três causas DIFERENTES com ações OPOSTAS. A decisão vem primeiro do
  // FORMATO da chave (conclusivo, lido localmente), depois da mensagem da API.
  // Mesma lógica de scripts/diagnosticar-chaves.js — mantenha as duas juntas.
  const pareceSecreta = typeof chaveService === "string"
    && (chaveService.startsWith("sb_secret_") || chaveService.startsWith("eyJ"));

  if (chaveService && !pareceSecreta) {
    throw new Error(
      "[CREDENCIAL NO SLOT ERRADO] TEST_SUPABASE_SERVICE_ROLE_KEY nao tem formato de chave secreta "
      + `(${error.message}). Acao: coloque a sb_secret_... em SERVICE e a sb_publishable_... em ANON — `
      + "elas costumam vir TROCADAS.");
  }
  if (/unregistered|not registered/i.test(error.message)) {
    throw new Error(
      "[CREDENCIAL ROTACIONADA] TEST_SUPABASE_SERVICE_ROLE_KEY nao e reconhecida por ESTE projeto "
      + `(${error.message}). Foi rotacionada ou pertence a outro projeto. `
      + "Acao: gere uma nova secret em Project Settings > API Keys do projeto apontado por "
      + "TEST_SUPABASE_URL. Isto NAO e troca de slots — nao mexa na ANON.");
  }
  if (/invalid api key/i.test(error.message)) {
    throw new Error(
      "[CREDENCIAL INVALIDA] TEST_SUPABASE_SERVICE_ROLE_KEY e malformada, truncada ou inexistente "
      + `(${error.message}). Acao: recopie a secret inteira do painel, sem cortar caracteres.`);
  }
  throw new Error(
    "[CREDENCIAL SEM PODER] a chave e reconhecida, mas nao tem poder de service_role "
    + `(${error.message}). Confira os slots SERVICE / ANON.`);
}

// --- 5: tabelas / migrations ----------------------------------------------

// Quais migrations criam o quê — usado para dizer QUAL aplicar.
const MIGRATION_DE = {
  organizacoes: "database/schema.sql",
  unidades: "database/schema.sql",
  perfis: "database/schema.sql",
  produtos: "database/schema.sql",
  insumos: "database/schema.sql",
  vendas: "database/schema.sql",
  usuarios_organizacoes: "015_multi_membership_papeis.sql",
  usuarios_unidades: "015_multi_membership_papeis.sql",
  plataforma_admins: "015_multi_membership_papeis.sql",
  plataforma_acessos: "015_multi_membership_papeis.sql",
  martin_brower_integracoes: "017_martin_brower.sql",
  martin_brower_produtos: "017_martin_brower.sql",
  martin_brower_precos_historico: "017_martin_brower.sql",
  martin_brower_sincronizacoes: "017_martin_brower.sql",
  martin_brower_filtros: "017_martin_brower.sql",
  martin_brower_vinculos: "017_martin_brower.sql",
};

/**
 * Confirma que cada tabela existe e é acessível pelo admin.
 * @throws Error nomeando a tabela E a migration que a cria
 */
export async function verificarTabelas(admin, tabelas) {
  const faltando = [];
  for (const t of tabelas) {
    const { error } = await admin.from(t).select("*", { count: "exact", head: true });
    if (error) faltando.push({ tabela: t, motivo: error.message });
  }
  if (!faltando.length) return;

  const detalhe = faltando
    .map((f) => `  - ${f.tabela}  (criada por ${MIGRATION_DE[f.tabela] ?? "migration desconhecida"})  [${f.motivo}]`)
    .join("\n");
  throw new Error(
    `[MIGRATION AUSENTE] ${faltando.length} tabela(s) inacessivel(is) no projeto de teste:\n${detalhe}\n`
    + "Acao: aplique as migrations indicadas no SQL Editor do projeto de TESTE, na ordem numerica.");
}

// --- 6: políticas RLS ------------------------------------------------------

/**
 * Confirma que o RLS está de fato ATIVO: um cliente `anon` (sem login) não
 * pode enxergar linha nenhuma de uma tabela de dados.
 *
 * Detecta o caso perigoso em que a migration criou as tabelas mas NÃO as
 * policies — o teste passaria por acidente e daria falsa confiança.
 *
 * @param anonCli cliente com a chave publishable e SEM login
 */
export async function verificarRlsAtivo(anonCli, tabela) {
  const { data, error } = await anonCli.from(tabela).select("id").limit(1);

  // Erro de permissão = RLS bloqueando. É o resultado desejado.
  if (error) return;
  if ((data ?? []).length === 0) return;  // lista vazia = deny-all funcionando

  throw new Error(
    `[RLS AUSENTE] a tabela "${tabela}" devolveu dados para um cliente ANONIMO (sem login). `
    + "Isso significa que a tabela existe mas nao tem policy de tenant, ou o RLS esta desligado. "
    + "Acao: aplique 014 -> 015 -> 016 (e 017, para as tabelas martin_brower_*) e confirme com: "
    + "select tablename, count(*) from pg_policies where schemaname='public' group by 1;");
}

// --- 7: vínculos do usuário de teste --------------------------------------

/**
 * Confirma que o usuário de teste recebeu os vínculos no setup. Sem eles, o
 * RLS da 016 bloquearia o PRÓPRIO dono dos dados — e todos os testes falhariam
 * parecendo "vazamento inverso", que é um diagnóstico completamente errado.
 */
export async function verificarVinculos(admin, { usuarioId, organizacaoId, unidadeId, rotulo }) {
  const [{ data: vo }, { data: vu }] = await Promise.all([
    admin.from("usuarios_organizacoes").select("organizacao_id")
      .eq("usuario_id", usuarioId).eq("organizacao_id", organizacaoId).eq("ativo", true).maybeSingle(),
    unidadeId
      ? admin.from("usuarios_unidades").select("unidade_id")
          .eq("usuario_id", usuarioId).eq("unidade_id", unidadeId).eq("ativo", true).maybeSingle()
      : Promise.resolve({ data: true }),
  ]);

  if (vo && vu) return;
  const faltou = [!vo && "usuarios_organizacoes", !vu && "usuarios_unidades"].filter(Boolean).join(" e ");
  throw new Error(
    `[SETUP INCOMPLETO] o usuario de teste "${rotulo}" nao tem vinculo ativo em ${faltou}. `
    + "Isto e falha do SETUP do teste, NAO vazamento de isolamento: sem vinculo, o RLS da 016 "
    + "bloqueia o proprio dono dos dados e todos os casos falham com sintoma enganoso.");
}

// --- 8: mensagem de falha real de isolamento ------------------------------

/**
 * Prefixo padronizado para asserções de isolamento. Torna impossível confundir
 * um vazamento real com problema de ambiente: só esta mensagem começa com
 * [VAZAMENTO], e ela só aparece quando o banco devolveu dado de outro tenant.
 */
export const vazamento = (detalhe) =>
  `[VAZAMENTO REAL DE ISOLAMENTO] ${detalhe}. `
  + "Isto NAO e problema de ambiente: as migrations e credenciais ja foram validadas pelo preflight. "
  + "Um tenant acessou dado de outro — investigue as policies e os filtros do repositorio.";
