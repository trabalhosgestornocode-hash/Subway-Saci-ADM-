import { state } from "./state.js";
import { getSupabase } from "./supabaseClient.js";

function traduzErro(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("invalid login")) return "E-mail ou senha incorretos.";
  if (m.includes("email not confirmed")) return "E-mail ainda não confirmado.";
  if (m.includes("rate limit")) return "Muitas tentativas. Aguarde um instante.";
  return msg || "Falha no login.";
}

// Login real via Supabase Auth (senha com hash bcrypt, JWT com expiração/refresh).
export async function login(email, senha) {
  if (!email?.trim() || !senha?.trim()) throw new Error("Preencha e-mail e senha.");
  const sb = await getSupabase();
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password: senha });
  if (error) throw new Error(traduzErro(error.message));
  state.usuario = data.user.email;
  return data;
}

// Restaura a sessão persistida (com refresh automático do token).
export async function restaurarSessao() {
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  if (data?.session?.user) {
    state.usuario = data.session.user.email;
    return true;
  }
  return false;
}

export async function logout() {
  try {
    const sb = await getSupabase();
    await sb.auth.signOut();
  } catch { /* ignora */ }
  state.usuario = null;
}
