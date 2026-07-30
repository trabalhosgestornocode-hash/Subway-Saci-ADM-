// =====================================================================
// VIRADA DE ACESSOS — cria o SuperAdmin, ajusta os e-mails e zera vínculos
// =====================================================================
// Roda UMA VEZ, depois da migration 020. Faz o que o SQL não pode fazer:
// criar uma conta de login (o Supabase Auth guarda o hash da senha e a
// identidade — inserir direto em auth.users é frágil e desencorajado).
//
// O que ele garante, no fim:
//   * pontesjoaopedro68@gmail.com  -> conta de LOGIN do SuperAdmin, com senha
//     PROVISÓRIA e a flag `senha_provisoria` ligada (troca obrigatória no
//     primeiro acesso);
//   * projetospeu@gmail.com        -> usuário COMUM, com o perfil sincronizado
//     ao e-mail de login (hoje o perfil dele exibe outro e-mail);
//   * nenhum usuário vinculado diretamente a empresa — todos os vínculos são
//     zerados e recriados pelo Painel SuperAdmin.
//
// É IDEMPOTENTE: rodar de novo não duplica conta, não rebaixa o SuperAdmin e
// — graças à guarda `migracao_020_reset_acessos` — não zera de novo os
// vínculos que você já tiver criado no painel.
//
// USO:  npm --prefix backend run virada:superadmin
//   (equivale a: node --env-file=.env scripts/virada-superadmin.js)
// =====================================================================

import { createClient } from "@supabase/supabase-js";
import ws from "ws";
if (!globalThis.WebSocket) globalThis.WebSocket = ws; // Node < 22

// ---------------------------------------------------------------------
// PARÂMETROS — edite aqui se precisar.
// ---------------------------------------------------------------------
const EMAIL_SUPERADMIN = (process.env.SUPERADMIN_EMAIL || "pontesjoaopedro68@gmail.com").toLowerCase();
const NOME_SUPERADMIN = process.env.SUPERADMIN_NOME || "João Pedro Pontes";

// O e-mail que, hoje, está no PERFIL do SuperAdmin mas é o LOGIN de outra
// pessoa. Vamos devolvê-lo ao seu dono como usuário comum.
const EMAIL_USUARIO_COMUM = (process.env.USUARIO_COMUM_EMAIL || "projetospeu@gmail.com").toLowerCase();

// Senha PROVISÓRIA do SuperAdmin.
//
// Você pediu "1234", mas o Supabase Auth recusa senhas com menos de 6
// caracteres (é política do projeto, não do nosso código) e o sistema exige 8
// na troca. Como esta senha é descartável — o primeiro login OBRIGA a definir
// outra — o valor exato quase não importa. Deixei "1234" embutido num valor
// que passa nas duas regras. Troque à vontade (ou via env SENHA_PROVISORIA).
const SENHA_PROVISORIA = process.env.SENHA_PROVISORIA || "Crescer1234";

// Ligue para RESETAR a senha provisória mesmo se a conta já existir (útil se
// esqueceu a senha antes de trocá-la). Por padrão, desligado: não mexemos na
// senha de uma conta que já está de pé.
const FORCAR_RESET = process.env.FORCAR_RESET === "true";

// ---------------------------------------------------------------------
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no ambiente. Rode com --env-file=.env.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const log = (...a) => console.log(...a);
const passo = (n, t) => console.log(`\n[${n}] ${t}`);

/** Procura um usuário no Auth por e-mail (o SDK só oferece listUsers paginado). */
async function acharNoAuth(email) {
  const alvo = email.toLowerCase();
  for (let pagina = 1; pagina <= 20; pagina++) {
    const { data, error } = await sb.auth.admin.listUsers({ page: pagina, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const us = data?.users ?? [];
    const achado = us.find((u) => (u.email ?? "").toLowerCase() === alvo);
    if (achado) return achado;
    if (us.length < 200) return null; // última página
  }
  return null;
}

async function main() {
  log("=== VIRADA DE ACESSOS — Crescer com Delivery ===");
  log(`SuperAdmin : ${EMAIL_SUPERADMIN}`);
  log(`Usuário    : ${EMAIL_USUARIO_COMUM}`);

  // Confirma que o schema da 020 existe antes de mexer em qualquer coisa.
  const { error: schemaErr } = await sb.from("plataforma_admins").select("usuario_id").limit(1);
  if (schemaErr) {
    console.error(`\n✗ A tabela plataforma_admins não respondeu (${schemaErr.message}).`);
    console.error("  Aplique a migration 020 no Supabase (SQL Editor) ANTES de rodar a virada.");
    process.exit(1);
  }

  // -------------------------------------------------------------------
  // 1. Devolve projetospeu@gmail.com ao seu dono como usuário comum.
  //    Precisa vir ANTES de criar o SuperAdmin: hoje o perfil dessa pessoa
  //    exibe 'pontesjoaopedro68@gmail.com'; liberamos esse e-mail sincronizando
  //    o perfil ao login real dela.
  // -------------------------------------------------------------------
  passo(1, "Ajustando o usuário comum (projetospeu@gmail.com)");
  const contaUsuario = await acharNoAuth(EMAIL_USUARIO_COMUM);
  if (!contaUsuario) {
    log(`  · Conta de login ${EMAIL_USUARIO_COMUM} não encontrada no Auth — nada a ajustar.`);
  } else {
    const patch = { email: EMAIL_USUARIO_COMUM, ativo: true };
    const { error } = await sb.from("perfis").update(patch).eq("id", contaUsuario.id);
    if (error) throw new Error(`perfis(usuário comum): ${error.message}`);
    // Garante que ele NÃO seja superadmin (era o dono do perfil "João Pedro").
    await sb.from("plataforma_admins").update({ ativo: false }).eq("usuario_id", contaUsuario.id);
    log(`  ✓ Perfil de ${EMAIL_USUARIO_COMUM} sincronizado (id ${contaUsuario.id}); não é superadmin.`);
  }

  // -------------------------------------------------------------------
  // 2. Cria (ou localiza) a conta de login do SuperAdmin.
  // -------------------------------------------------------------------
  passo(2, "Conta de login do SuperAdmin");
  let contaAdmin = await acharNoAuth(EMAIL_SUPERADMIN);
  let recemCriado = false;

  if (!contaAdmin) {
    const { data, error } = await sb.auth.admin.createUser({
      email: EMAIL_SUPERADMIN,
      password: SENHA_PROVISORIA,
      email_confirm: true, // login imediato, sem e-mail de confirmação
      user_metadata: { nome: NOME_SUPERADMIN },
    });
    if (error || !data?.user) throw new Error(`createUser: ${error?.message ?? "sem usuário"}`);
    contaAdmin = data.user;
    recemCriado = true;
    log(`  ✓ Conta criada: ${EMAIL_SUPERADMIN} (id ${contaAdmin.id})`);
  } else {
    log(`  · Conta já existe: ${EMAIL_SUPERADMIN} (id ${contaAdmin.id})`);
    if (FORCAR_RESET) {
      const { error } = await sb.auth.admin.updateUserById(contaAdmin.id, {
        password: SENHA_PROVISORIA, email_confirm: true,
      });
      if (error) throw new Error(`updateUserById: ${error.message}`);
      recemCriado = true; // trata como recém-preparada → religa a flag abaixo
      log("  ✓ Senha provisória redefinida (FORCAR_RESET=true).");
    }
  }

  // -------------------------------------------------------------------
  // 3. Perfil (identidade) do SuperAdmin + flag de senha provisória.
  //    `senha_provisoria` só é LIGADA quando a conta é nova (ou resetada).
  //    Se o SuperAdmin já trocou a senha, uma re-execução NÃO volta a exigir
  //    troca — seria um incômodo sem motivo.
  // -------------------------------------------------------------------
  passo(3, "Perfil do SuperAdmin");
  const perfilAdmin = {
    id: contaAdmin.id,
    nome: NOME_SUPERADMIN,
    email: EMAIL_SUPERADMIN,
    ativo: true,
    organizacao_id: null, // SuperAdmin não pertence a empresa
    unidade_id: null,
  };
  if (recemCriado) perfilAdmin.senha_provisoria = true;

  const { error: perr } = await sb.from("perfis").upsert(perfilAdmin, { onConflict: "id" });
  if (perr) throw new Error(`perfis(superadmin): ${perr.message}`);
  log(`  ✓ Perfil pronto${recemCriado ? " · senha_provisoria = true (troca obrigatória no 1º login)" : ""}`);

  // -------------------------------------------------------------------
  // 4. Concede o papel global de SuperAdmin.
  // -------------------------------------------------------------------
  passo(4, "Papel de SuperAdmin da plataforma");
  const { error: aerr } = await sb.from("plataforma_admins").upsert({
    usuario_id: contaAdmin.id,
    ativo: true,
    observacao: "Concedido pela virada-superadmin (fundador da plataforma).",
  }, { onConflict: "usuario_id" });
  if (aerr) throw new Error(`plataforma_admins: ${aerr.message}`);
  log("  ✓ plataforma_admins atualizado (ativo).");

  // -------------------------------------------------------------------
  // 5. Zera os vínculos usuário -> empresa/unidade. GUARDADO: uma vez só.
  //    A guarda garante que uma re-execução não apague os acessos que você
  //    já tiver recriado no painel.
  // -------------------------------------------------------------------
  passo(5, "Zerando vínculos antigos (uma única vez)");
  const { data: guarda } = await sb.from("plataforma_config")
    .select("chave").eq("chave", "migracao_020_reset_acessos").maybeSingle();

  let vinculosRemovidos = 0;
  if (guarda) {
    log("  · Guarda presente — vínculos já foram zerados antes. Preservando o que existe.");
  } else {
    const { count } = await sb.from("usuarios_organizacoes")
      .select("*", { count: "exact", head: true });
    vinculosRemovidos = count ?? 0;

    // unidades antes de organizações (a de unidade referencia a de empresa no
    // modelo mental, embora o FK seja para unidades/auth).
    const delU = await sb.from("usuarios_unidades").delete().not("usuario_id", "is", null);
    if (delU.error) throw new Error(`delete usuarios_unidades: ${delU.error.message}`);
    const delO = await sb.from("usuarios_organizacoes").delete().not("usuario_id", "is", null);
    if (delO.error) throw new Error(`delete usuarios_organizacoes: ${delO.error.message}`);

    // Auditoria imutável — a virada precisa ficar rastreada.
    await sb.from("plataforma_auditoria").insert({
      ator_id: contaAdmin.id, ator_email: EMAIL_SUPERADMIN, ator_tipo: "sistema",
      acao: "migracao.020_reset_acessos", entidade: "plataforma",
      detalhes: { vinculos_removidos: vinculosRemovidos, superadmin: EMAIL_SUPERADMIN, usuario_comum: EMAIL_USUARIO_COMUM },
    });

    // Guarda de execução única.
    await sb.from("plataforma_config").insert({
      chave: "migracao_020_reset_acessos",
      valor: { em: new Date().toISOString(), vinculos_removidos: vinculosRemovidos, via: "virada-superadmin.js" },
      secreto: false,
      descricao: "Guarda: impede a virada de zerar os vínculos novamente.",
    });

    log(`  ✓ Vínculos removidos: ${vinculosRemovidos}. Guarda gravada.`);
  }

  // -------------------------------------------------------------------
  // Resumo
  // -------------------------------------------------------------------
  log("\n=== CONCLUÍDO ===");
  log(`SuperAdmin  : ${EMAIL_SUPERADMIN}`);
  if (recemCriado) {
    log(`Senha       : ${SENHA_PROVISORIA}   (PROVISÓRIA — o sistema vai exigir a troca no 1º login)`);
  } else {
    log("Senha       : inalterada (a conta já existia). Use FORCAR_RESET=true para redefinir a provisória.");
  }
  log(`Usuário comum: ${EMAIL_USUARIO_COMUM} (perfil sincronizado; associe empresas pelo painel)`);
  log("\nEntre no sistema com o SuperAdmin, defina a nova senha, e recrie os acessos em Usuários → Novo usuário.");
}

main().catch((e) => {
  console.error(`\n✗ FALHOU: ${e.message}`);
  console.error("  Nada foi deixado pela metade de propósito? Verifique a mensagem acima e rode de novo — o script é idempotente.");
  process.exit(1);
});
