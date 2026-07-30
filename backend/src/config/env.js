// Carrega e valida variáveis de ambiente. Rode com: node --env-file=.env
import crypto from "node:crypto";

const obrigatorias = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"];
const faltando = obrigatorias.filter((k) => !process.env[k]);
if (faltando.length) {
  console.error(`[config] Variáveis de ambiente faltando: ${faltando.join(", ")}`);
  console.error("Copie backend/.env.example para backend/.env e preencha.");
  process.exit(1);
}

// Segredo que assina o Context Token (a empresa da sessão). Se não vier do
// ambiente, é DERIVADO da service_role key — que já é um segredo forte e
// exclusivo do servidor. Derivar, em vez de exigir a variável, evita quebrar um
// deploy existente; derivar, em vez de sortear, mantém os tokens válidos entre
// reinícios e entre instâncias do Render (um segredo aleatório por processo
// invalidaria a sessão de todo mundo a cada deploy).
//
// Ainda assim, o ideal é definir CONTEXT_TOKEN_SECRET: assim rotacionar a chave
// do Supabase não derruba todas as sessões, e vice-versa.
const contextTokenSecret = process.env.CONTEXT_TOKEN_SECRET
  || crypto.createHmac("sha256", process.env.SUPABASE_SERVICE_ROLE_KEY)
      .update("crescer:context-token:v1").digest("hex");

if (!process.env.CONTEXT_TOKEN_SECRET && process.env.NODE_ENV === "production") {
  console.warn("[config] CONTEXT_TOKEN_SECRET não definida — usando segredo derivado da service_role key. Defina a variável para desacoplar a rotação das chaves.");
}

export const config = {
  port: Number(process.env.PORT) || 3001,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY, // pública — enviada ao frontend p/ Supabase Auth
  contextTokenSecret,
  // Janela que define "usuário online" no Dashboard Global (minutos).
  janelaOnlineMin: Number(process.env.JANELA_ONLINE_MIN) || 15,
};
