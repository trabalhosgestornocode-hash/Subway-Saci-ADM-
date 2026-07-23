#!/usr/bin/env node
// =====================================================================
// diagnosticar-chaves.js — diagnóstico SOMENTE LEITURA de um projeto Supabase
// =====================================================================
// OBJETIVO
//   Responder, sem revelar segredo nenhum, a três perguntas que já custaram
//   tempo neste projeto:
//     1. as chaves estão nos slots certos (secret x publishable)?
//     2. elas ainda são válidas neste projeto (ou foram rotacionadas)?
//     3. as tabelas que os testes precisam estão acessíveis?
//
// SOMENTE LEITURA — POR CONSTRUÇÃO
//   Faz apenas requisições GET. Não cria, não altera e não apaga nada.
//   Não existe caminho de escrita neste arquivo; por isso ele pode rodar com
//   segurança contra qualquer ambiente, inclusive produção (ver ALVO abaixo).
//
// NUNCA IMPRIME SEGREDO
//   De cada chave, mostra só: prefixo do TIPO (sb_secret_ / sb_publishable_ /
//   JWT legado), tamanho e — no caso de JWT legado — as claims públicas `role`
//   e `ref`. O valor da chave jamais é escrito na saída, nem em erro.
//
// USO DE service_role
//   A chave secreta é usada para UMA única leitura mínima (listar 1 usuário,
//   sem imprimir nada sobre ele). É o único teste definitivo de poder de
//   service_role, já que `auth.admin` não responde à chave publishable.
//
// ALVO (variável MB_DIAG_TARGET)
//   test  (padrão) -> usa TEST_SUPABASE_URL / _SERVICE_ROLE_KEY / _ANON_KEY
//   prod           -> usa SUPABASE_URL / _SERVICE_ROLE_KEY / _ANON_KEY
//   Apontar para produção exige a escolha explícita. Como o script é somente
//   leitura, isso é seguro — a exigência existe para evitar diagnóstico
//   acidental do ambiente errado, não para proteger contra escrita.
//
// EXEMPLOS
//   npm run diagnosticar:chaves                       # projeto de TESTE
//   MB_DIAG_TARGET=prod npm run diagnosticar:chaves   # produção (leitura)
//   node --env-file=.env.test scripts/diagnosticar-chaves.js
//
// EXIT CODE
//   0  tudo consistente
//   1  alguma inconsistência encontrada (chave inválida, slot trocado,
//      tabela inacessível, RLS aparentemente ausente)
//   2  configuração ausente (variáveis não definidas)
//
// O QUE VERIFICA
//   Chaves      formato, slot, validade, poder de service_role
//   Tabelas     ACESSIBILIDADE via PostgREST das tabelas usadas pelos testes:
//                 organizacoes, unidades, perfis, produtos, insumos, vendas,
//                 usuarios_organizacoes, usuarios_unidades, plataforma_admins,
//                 martin_brower_integracoes, martin_brower_produtos,
//                 martin_brower_precos_historico, martin_brower_sincronizacoes,
//                 martin_brower_filtros, martin_brower_vinculos
//   RLS         se um cliente ANÔNIMO consegue ler linhas de tabela de dados
//
// LIMITAÇÕES — leia antes de confiar
//   * NÃO verifica constraints, índices, colunas nem definições de policy:
//     o PostgREST não expõe os catálogos do Postgres (pg_constraint,
//     pg_indexes, pg_policies). Para isso use o script SQL de diagnóstico
//     em docs/martin-brower-integracao.md, no SQL Editor.
//   * "tabela acessível" não prova que o schema está correto, só que ela
//     existe e responde.
//   * A checagem de RLS é indicativa: uma tabela vazia devolve [] tanto com
//     RLS correto quanto com RLS ausente. Só o resultado POSITIVO (anônimo
//     recebeu linhas) é conclusivo — e esse é sempre um problema.
// =====================================================================

const ALVO = (process.env.MB_DIAG_TARGET ?? "test").toLowerCase();
const ehProd = ALVO === "prod";

const base = ehProd ? process.env.SUPABASE_URL : process.env.TEST_SUPABASE_URL;
const secreta = ehProd ? process.env.SUPABASE_SERVICE_ROLE_KEY : process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const publica = ehProd ? process.env.SUPABASE_ANON_KEY : process.env.TEST_SUPABASE_ANON_KEY;

const TABELAS = [
  "organizacoes", "unidades", "perfis", "produtos", "insumos", "vendas",
  "usuarios_organizacoes", "usuarios_unidades", "plataforma_admins",
  "martin_brower_integracoes", "martin_brower_produtos",
  "martin_brower_precos_historico", "martin_brower_sincronizacoes",
  "martin_brower_filtros", "martin_brower_vinculos",
];

let problemas = 0;
const falha = (msg) => { problemas += 1; console.log(`  ✖ ${msg}`); };
const ok = (msg) => console.log(`  ✔ ${msg}`);
const aviso = (msg) => console.log(`  • ${msg}`);

// Descreve a chave SEM revelar o valor.
function perfilDaChave(chave) {
  if (!chave) return { formato: "AUSENTE" };
  const t = chave.trim();
  const info = { tamanho: t.length, espacoSobrando: t !== chave };
  if (t.startsWith("sb_secret_")) return { ...info, formato: "sb_secret_ (nova, SECRETA)", secreta: true };
  if (t.startsWith("sb_publishable_")) return { ...info, formato: "sb_publishable_ (nova, PUBLICA)", secreta: false };
  if (t.startsWith("eyJ")) {
    try {
      // Claims públicas de um JWT legado — não são segredo.
      const p = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
      return { ...info, formato: "JWT legado", role: p.role ?? "?", projeto: p.ref ?? "?",
               secreta: p.role === "service_role" };
    } catch { return { ...info, formato: "JWT ilegivel" }; }
  }
  return { ...info, formato: "DESCONHECIDO" };
}

const refDaUrl = (u) => { try { return new URL(u).host.split(".")[0]; } catch { return null; } };

// As causas de falha da chave secreta são DIFERENTES e pedem ações OPOSTAS.
// A decisão vem primeiro do FORMATO (conclusivo, lido localmente) e só depois
// da mensagem da API — que distingue "não registrada" de "inválida":
//   Unregistered API key -> formato ok, mas não pertence a este projeto
//   Invalid API key      -> chave malformada ou inexistente em qualquer lugar
function diagnosticarFalhaDaSecreta(resposta, perfil) {
  if (perfil.secreta === false) {
    return "SERVICE_ROLE_KEY contem uma chave PUBLICA — SLOTS TROCADOS. "
         + "Acao: coloque a sb_secret_... em SERVICE e a sb_publishable_... em ANON.";
  }
  if (/unregistered|not registered/i.test(resposta.corpo)) {
    return "SERVICE_ROLE_KEY nao e reconhecida por ESTE projeto — foi ROTACIONADA ou pertence a outro. "
         + "Acao: gere uma nova secret em Project Settings > API Keys. Isto NAO e troca de slots.";
  }
  if (/invalid api key/i.test(resposta.corpo)) {
    return "SERVICE_ROLE_KEY e INVALIDA (malformada, truncada ou inexistente). "
         + "Acao: recopie a secret inteira do painel, sem cortar caracteres.";
  }
  return `SERVICE_ROLE_KEY falhou com status ${resposta.status}: ${resposta.corpo.slice(0, 120)}`;
}

async function get(caminho, chave, comBearer = false) {
  const headers = { apikey: chave };
  if (comBearer) headers.Authorization = `Bearer ${chave}`;
  const r = await fetch(`${base}${caminho}`, { headers });
  const corpo = await r.text();
  return { status: r.status, ok: r.ok, corpo };
}

async function main() {
  console.log(`\n=== DIAGNOSTICO SUPABASE (somente leitura) — alvo: ${ALVO.toUpperCase()} ===\n`);

  if (!base || !secreta || !publica) {
    const prefixo = ehProd ? "SUPABASE_" : "TEST_SUPABASE_";
    console.error(`[CONFIG AUSENTE] defina ${prefixo}URL, ${prefixo}SERVICE_ROLE_KEY e ${prefixo}ANON_KEY.`);
    console.error(ehProd ? "Rode com --env-file=.env" : "Rode com --env-file=.env.test (veja .env.test.example).");
    process.exit(2);
  }

  console.log("PROJETO");
  console.log(`  URL: ${base}`);
  console.log(`  ref: ${refDaUrl(base) ?? "(ilegivel)"}`);
  if (ehProd) console.log("  ⚠ ALVO E PRODUCAO — este script e somente leitura, nada sera alterado.");

  // --- 1. formato e slots -------------------------------------------------
  console.log("\nFORMATO DAS CHAVES (valores nunca sao impressos)");
  const pSecreta = perfilDaChave(secreta);
  const pPublica = perfilDaChave(publica);
  console.log(`  SERVICE_ROLE_KEY: ${JSON.stringify(pSecreta)}`);
  console.log(`  ANON_KEY:         ${JSON.stringify(pPublica)}`);

  if (pSecreta.secreta === false) falha("SERVICE_ROLE_KEY contem uma chave PUBLICA — slots trocados.");
  if (pPublica.secreta === true) falha("ANON_KEY contem uma chave SECRETA — slots trocados. Rotacione-a: ela pode ter vazado.");
  if (pSecreta.espacoSobrando || pPublica.espacoSobrando) falha("Ha espaco/quebra de linha sobrando em alguma chave.");
  if (pSecreta.formato === "DESCONHECIDO" || pPublica.formato === "DESCONHECIDO") falha("Formato de chave nao reconhecido.");

  // --- 2. validade das chaves --------------------------------------------
  console.log("\nVALIDADE DAS CHAVES");
  const pub = await get("/rest/v1/organizacoes?select=id&limit=1", publica, true);
  if (pub.corpo.includes("Unregistered")) {
    falha("ANON_KEY nao e reconhecida por este projeto (rotacionada ou de outro projeto).");
  } else if (pub.status === 200) {
    ok("ANON_KEY valida e registrada.");
  } else {
    aviso(`ANON_KEY respondeu ${pub.status} — ${pub.corpo.slice(0, 120)}`);
  }

  // Uma leitura mínima: 1 usuário, nada sobre ele é impresso.
  const adm = await get("/auth/v1/admin/users?page=1&per_page=1", secreta, true);
  if (adm.ok) {
    ok("SERVICE_ROLE_KEY valida e com poder de service_role.");
  } else {
    falha(diagnosticarFalhaDaSecreta(adm, pSecreta));
  }

  // --- 3. tabelas ---------------------------------------------------------
  console.log("\nACESSIBILIDADE DAS TABELAS (via service_role)");
  const ausentes = [];
  for (const t of TABELAS) {
    const r = await get(`/rest/v1/${t}?select=*&limit=0`, secreta, true);
    if (!r.ok) ausentes.push(t);
  }
  if (ausentes.length) {
    falha(`${ausentes.length} tabela(s) inacessivel(is): ${ausentes.join(", ")}`);
    if (ausentes.some((t) => t.startsWith("martin_brower"))) aviso("Aplique 017_martin_brower.sql.");
    if (ausentes.some((t) => t.startsWith("usuarios_") || t === "plataforma_admins")) aviso("Aplique 015_multi_membership_papeis.sql.");
  } else {
    ok(`todas as ${TABELAS.length} tabelas esperadas respondem.`);
  }

  // --- 4. RLS -------------------------------------------------------------
  console.log("\nRLS (cliente anonimo, sem login)");
  for (const t of ["produtos", "martin_brower_produtos"]) {
    const r = await get(`/rest/v1/${t}?select=id&limit=1`, publica, true);
    if (!r.ok) { ok(`${t}: anonimo bloqueado (${r.status}).`); continue; }
    let linhas = [];
    try { linhas = JSON.parse(r.corpo); } catch { /* corpo inesperado */ }
    if (Array.isArray(linhas) && linhas.length > 0) {
      falha(`${t}: ANONIMO LEU ${linhas.length} linha(s) — policy de tenant ausente ou RLS desligado.`);
    } else {
      ok(`${t}: anonimo nao recebeu linhas (indicativo — tabela pode estar vazia).`);
    }
  }

  console.log(`\n=== RESULTADO: ${problemas === 0 ? "nenhuma inconsistencia" : `${problemas} inconsistencia(s)`} ===\n`);
  process.exit(problemas === 0 ? 0 : 1);
}

main().catch((e) => {
  // Mensagem do erro apenas — nunca o corpo da requisição, que traria a chave.
  console.error(`\n[FALHA] ${e.message}\n`);
  process.exit(1);
});
