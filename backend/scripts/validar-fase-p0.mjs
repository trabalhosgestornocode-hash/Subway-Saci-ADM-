// =====================================================================
// VALIDAÇÃO DA FASE P0 — contra o Supabase de TESTE (conexão PG direta)
// =====================================================================
// SOMENTE LEITURA por padrão. O único bloco que escreve é o teste de
// concorrência da quota atômica (migration 067), atrás da flag
// `--concorrencia`, e ele limpa APENAS as linhas que cria (chave sentinela).
//
// Conexão: EXCLUSIVAMENTE process.env.DATABASE_TESTE_URL.
//   Ausente / placeholder / == produção  ->  ABORTA (não há fallback).
//
// Uso:
//   node --env-file=.env scripts/validar-fase-p0.mjs
//   node --env-file=.env scripts/validar-fase-p0.mjs --concorrencia
//
// Requer o cliente `psql` no PATH (nenhuma dependência npm nova).
// =====================================================================
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { assertBancoDeTeste, hostDe } from "../test/helpers/db-teste.js";

const QUER_CONCORRENCIA = process.argv.includes("--concorrencia");
const SEP = "\x1f"; // separador de coluna improvável em dados

// --- 0. guarda -------------------------------------------------------------
let alvo;
try {
  alvo = assertBancoDeTeste();
} catch (e) {
  console.error("\n✖ " + e.message + "\n");
  process.exit(2);
}

// psql presente?
if (spawnSync("psql", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.error("\n✖ `psql` não encontrado no PATH. Instale o cliente PostgreSQL.\n");
  process.exit(2);
}

// --- monta o ambiente do psql (senha fora do argv) ------------------------
const u = new URL(alvo.url);
const pgEnv = {
  ...process.env,
  PGHOST: u.hostname,
  PGPORT: u.port || "5432",
  PGUSER: decodeURIComponent(u.username),
  PGPASSWORD: decodeURIComponent(u.password),
  PGDATABASE: (u.pathname || "/postgres").slice(1) || "postgres",
  PGSSLMODE: u.searchParams.get("sslmode") || "require",
  PGCONNECT_TIMEOUT: "15",
};

/** Roda um SELECT e devolve as linhas como arrays de strings. */
function q(sql) {
  const r = spawnSync("psql", ["-tAF", SEP, "-v", "ON_ERROR_STOP=1", "-c", sql], {
    env: pgEnv,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || "psql falhou").trim());
  }
  return r.stdout
    .replace(/\r/g, "") // psql no Windows emite CRLF
    .split("\n")
    .filter((l) => l.length)
    .map((l) => l.split(SEP));
}

const linhas = [];
const reg = (chave, valor, ok) =>
  linhas.push({ chave, valor, ok: ok === undefined ? null : ok });

// --- 1. identidade (read-only) -------------------------------------------
let ehTeste = false;
try {
  const [[db, user, ver]] = q(
    "select current_database(), current_user, version()"
  );
  const [[emRecovery]] = q("select pg_is_in_recovery()::text");
  reg("host", alvo.host);
  reg("database", db);
  reg("user", user);
  reg("versão", ver.replace(/ \(.*/, ""));
  reg("standby (replica)", emRecovery);

  const prodSupa = hostDe(process.env.SUPABASE_URL);
  const prodDb = hostDe(process.env.DATABASE_URL);
  ehTeste =
    !!alvo.host &&
    alvo.host !== prodDb &&
    !(prodSupa && alvo.host.includes(prodSupa.replace(/^db\./, "")));
  reg(
    "confirmado como TESTE (host ≠ produção)",
    ehTeste ? "SIM" : "NÃO — host coincide com produção",
    ehTeste
  );
  if (!ehTeste) {
    console.error("\n✖ host de teste coincide com produção. Abortado.\n");
    process.exit(2);
  }
} catch (e) {
  console.error("\n✖ falha ao conectar no banco de TESTE: " + e.message);
  console.error("  (nenhum fallback para produção — encerrando)\n");
  process.exit(2);
}

// --- 2. schema da migration base ---------------------------------------
const TABELAS = [
  "sessoes_contexto",
  "perfis_operacionais",
  "plataforma_admins",
  "painel_administrativo_usuarios",
  "agente_quota_uso",
];
let baseOk = true;
for (const t of TABELAS) {
  const [[existe]] = q(
    `select count(*) from information_schema.tables
       where table_schema='public' and table_name='${t}'`
  );
  const ok = existe === "1";
  baseOk = baseOk && ok;
  reg(`tabela ${t}`, ok ? "presente" : "AUSENTE", ok);
}

// --- 3. RPC da quota (migration 067) ----------------------------------
const [[temRpc]] = q(
  `select count(*) from pg_proc
     where proname='agente_reservar_quota' and pronamespace='public'::regnamespace`
);
const rpcOk = temRpc === "1";
reg("função agente_reservar_quota(jsonb)", rpcOk ? "presente" : "AUSENTE", rpcOk);

let privOk = false;
let m067Ok = false;
if (rpcOk) {
  const [[secdef, cfg]] = q(
    `select p.prosecdef::text, coalesce(array_to_string(p.proconfig,','),'')
       from pg_proc p
      where p.proname='agente_reservar_quota' and p.pronamespace='public'::regnamespace`
  );
  const invoker = secdef === "false"; // prosecdef::text => 'true'=DEFINER, 'false'=INVOKER
  const searchPath = /search_path=public/.test(cfg);
  reg("SECURITY INVOKER", invoker ? "sim" : "NÃO (é DEFINER)", invoker);
  reg("search_path", searchPath ? "public" : cfg || "(vazio)", searchPath);

  const [[rls]] = q(
    `select relrowsecurity::text from pg_class
       where relname='agente_quota_uso' and relnamespace='public'::regnamespace`
  );
  const [[nPol]] = q(
    `select count(*) from pg_policies where tablename='agente_quota_uso'`
  );
  const rlsLigada = rls === "true"; // relrowsecurity::text
  const rlsOk = rlsLigada && nPol === "0";
  reg("RLS em agente_quota_uso", `${rlsLigada ? "ON" : "OFF"} / ${nPol} policies`, rlsOk);

  const priv = q(
    `select r.rolname,
            has_function_privilege(r.rolname, p.oid, 'EXECUTE')::text
       from pg_proc p
       cross join (values ('public'),('anon'),('authenticated'),('service_role')) r(rolname)
      where p.proname='agente_reservar_quota'
        and p.pronamespace='public'::regnamespace`
  );
  const mapa = Object.fromEntries(priv);
  const esperado = {
    public: "false",
    anon: "false",
    authenticated: "false",
    service_role: "true",
  };
  privOk = Object.entries(esperado).every(([k, v]) => mapa[k] === v);
  for (const [k, v] of Object.entries(esperado)) {
    reg(
      `EXECUTE / ${k}`,
      mapa[k] === "true" ? "concedido" : "negado",
      mapa[k] === v
    );
  }
  m067Ok = invoker && searchPath && rlsOk && privOk;
}

// --- 4. concorrência 10 / 1 (opcional, escreve) ----------------------
let concResultado = "NÃO EXECUTADO (use --concorrencia)";
let concOk = null;
if (QUER_CONCORRENCIA && rpcOk) {
  const chave = randomUUID(); // sentinela — só este script conhece
  const payload = JSON.stringify([
    { escopo: "org", chave, janela_segundos: 3600, limite: 1 },
  ]);
  const roda = () =>
    new Promise((resolve) => {
      const c = spawn(
        "psql",
        ["-tA", "-v", "ON_ERROR_STOP=1", "-c", `select agente_reservar_quota('${payload}'::jsonb)`],
        { env: pgEnv, encoding: "utf8" }
      );
      let out = "";
      let err = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (err += d));
      c.on("close", () => resolve(/AGENTE_QUOTA_EXCEDIDA/.test(err) ? "rejeitada" : err ? "erro" : "aceita"));
    });
  try {
    const r = await Promise.all(Array.from({ length: 10 }, roda));
    const aceitas = r.filter((x) => x === "aceita").length;
    const rejeitadas = r.filter((x) => x === "rejeitada").length;
    const [[contador]] = q(
      `select coalesce(max(consumido),0)::text from agente_quota_uso
         where escopo='org' and chave='${chave}'`
    );
    // limpeza: SOMENTE a chave sentinela deste run
    q(`delete from agente_quota_uso where chave='${chave}'`);
    concOk = aceitas === 1 && rejeitadas === 9 && contador === "1";
    concResultado = `${aceitas} aceita / ${rejeitadas} rejeitadas / contador=${contador}` +
      (concOk ? "  ✓" : "  ✗ (esperado 1/9/1)");
  } catch (e) {
    concResultado = "ERRO: " + e.message;
    concOk = false;
  }
}
reg("concorrência 10/1", concResultado, concOk);

// --- relatório -----------------------------------------------------------
const larguraK = Math.max(...linhas.map((l) => l.chave.length));
console.log("\n=== VALIDAÇÃO FASE P0 — banco de TESTE ===\n");
for (const l of linhas) {
  const marca = l.ok === null ? " " : l.ok ? "✓" : "✗";
  console.log(`  [${marca}] ${l.chave.padEnd(larguraK)}  ${l.valor}`);
}
console.log("");

const veredito =
  baseOk && rpcOk && m067Ok && (concOk === null || concOk === true);
console.log(veredito ? "VEREDITO: PASS\n" : "VEREDITO: FAIL\n");
process.exit(veredito ? 0 : 1);
