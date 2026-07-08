// Carrega e valida variáveis de ambiente. Rode com: node --env-file=.env
const obrigatorias = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"];
const faltando = obrigatorias.filter((k) => !process.env[k]);
if (faltando.length) {
  console.error(`[config] Variáveis de ambiente faltando: ${faltando.join(", ")}`);
  console.error("Copie backend/.env.example para backend/.env e preencha.");
  process.exit(1);
}

export const config = {
  port: Number(process.env.PORT) || 3001,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY, // pública — enviada ao frontend p/ Supabase Auth
};
