// Cria um usuário administrativo no Supabase Auth + o perfil vinculado.
// Uso:  node --env-file=.env scripts/criar-admin.js <email> <senha> "[Nome]"
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
if (!globalThis.WebSocket) globalThis.WebSocket = ws; // Node < 22


const ORG = process.env.DEFAULT_ORG_ID || "00000000-0000-0000-0000-000000000001";
const UNI = process.env.DEFAULT_UNIDADE_ID || "00000000-0000-0000-0000-0000000000a1";

const [, , email, senha, nome] = process.argv;
if (!email || !senha) {
  console.error('Uso: node --env-file=.env scripts/criar-admin.js <email> <senha> "[Nome]"');
  process.exit(1);
}
if (senha.length < 8) {
  console.error("A senha deve ter pelo menos 8 caracteres.");
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await sb.auth.admin.createUser({ email, password: senha, email_confirm: true });
if (error) {
  console.error("Erro ao criar usuário:", error.message);
  process.exit(1);
}

const uid = data.user.id;
const { error: pe } = await sb.from("perfis").upsert({
  id: uid,
  organizacao_id: ORG,
  unidade_id: UNI,
  nome: nome || email,
  email,
  papel: "admin",
  ativo: true,
});
if (pe) {
  console.error("Usuário criado no Auth, mas falhou ao criar o perfil:", pe.message);
  process.exit(1);
}

console.log(`✅ Admin criado com sucesso: ${email}  (id: ${uid})`);
console.log("Agora é só entrar no sistema com esse e-mail e senha.");
