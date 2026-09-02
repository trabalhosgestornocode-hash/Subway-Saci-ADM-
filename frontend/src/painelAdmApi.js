// Cliente da API do PAINEL ADMINISTRATIVO (/api/v1/administrativo).
//
// AUTENTICAÇÃO: a mesma do resto do frontend — o Bearer do Supabase
// (`tokenAtual()`), que é a IDENTIDADE. Não há autenticação paralela.
//
// DIFERENÇA DELIBERADA em relação a sessao.js#http: aqui NUNCA vai o header
// `x-context-token`. O Painel Administrativo não opera sob o contexto de
// nenhuma empresa (igual ao Painel SuperAdmin) — mandar o token de contexto
// seria semanticamente errado, mesmo que o backend o ignore nessas rotas.
import { API_BASE } from "./config.js";
import { tokenAtual } from "./supabaseClient.js";

const BASE = "/api/v1/administrativo";

async function chamar(rota, opcoes = {}) {
  const token = await tokenAtual();
  const r = await fetch(API_BASE + BASE + rota, {
    ...opcoes,
    headers: {
      ...(opcoes.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = typeof corpo.error === "string" ? corpo.error : (corpo.error?.message ?? `${r.status} ${r.statusText}`);
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return corpo.data ?? corpo;
}

export const painelAdmApi = {
  /**
   * Sanidade + validação REAL do acesso. 200 = pode entrar; 403 = acesso não
   * está mais disponível (ex.: SuperAdmin revogou depois da tela carregada).
   */
  ping: () => chamar("/ping"),
};
