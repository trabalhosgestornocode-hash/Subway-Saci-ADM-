// Sessão do frontend: quem sou eu, e em qual empresa estou.
//
// O Context Token é opaco para o frontend — ele não abre, não lê e não monta o
// token. Guarda o que o servidor devolveu e reenvia. O company_id, portanto,
// nunca é uma escolha do cliente: é consequência de uma seleção que o servidor
// validou e assinou.
//
// Armazenamento: sessionStorage, não localStorage. O contexto vale para a aba —
// fechar a aba encerra o contexto, e duas abas podem, no futuro, estar em
// unidades diferentes sem se atropelar.

import { API_BASE } from "./config.js";
import { state } from "./state.js";
import { getSupabase, tokenAtual } from "./supabaseClient.js";
import { geracaoContexto, contextoMudou, invalidarGeracaoDeContexto } from "./contextoEscopo.js";

const CHAVE_TOKEN = "cd.contextToken";

/** @typedef {import('./state.js').Sessao} Sessao */

// ---------------------------------------------------------------------------
// Token de contexto
// ---------------------------------------------------------------------------

export function contextTokenAtual() {
  return sessionStorage.getItem(CHAVE_TOKEN);
}

function guardarContextToken(token) {
  if (token) sessionStorage.setItem(CHAVE_TOKEN, token);
  else sessionStorage.removeItem(CHAVE_TOKEN);
}

export function limparContexto() {
  invalidarGeracaoDeContexto(); // respostas em voo do contexto que acabou não valem mais
  guardarContextToken(null);
  state.sessao.empresa = null;
  state.sessao.unidade = null;
  state.sessao.papel = null;
  state.sessao.papelRotulo = null;
  state.sessao.permissoes = [];
  state.sessao.modulos = [];
  state.sessao.impersonando = false;
}

// ---------------------------------------------------------------------------
// Requisições
// ---------------------------------------------------------------------------

async function cabecalhos(extra = {}) {
  const token = await tokenAtual();
  const ctx = contextTokenAtual();
  return {
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(ctx ? { "x-context-token": ctx } : {}),
  };
}

/**
 * Chamada à API com tratamento dos dois modos de falha que importam aqui:
 *   401 -> a identidade caiu: precisa fazer login de novo.
 *   409 -> a identidade está boa, o CONTEXTO caiu: basta escolher a unidade.
 * Tratar os dois como 401 expulsaria o usuário do sistema a cada contexto
 * expirado, que é o erro mais comum e o menos grave.
 */
async function chamar(url, opcoes = {}) {
  // Geração do contexto no momento do ENVIO — ver o comentário longo em
  // api.js#tratar: um 409 de uma requisição do contexto ANTERIOR, chegando
  // depois de o usuário já ter entrado em outra unidade, não pode apagar o
  // token da unidade nova nem mandá-lo de volta para a tela de seleção.
  const g = geracaoContexto();
  const r = await fetch(API_BASE + url, {
    ...opcoes,
    headers: await cabecalhos(opcoes.headers ?? {}),
  });

  if (r.status === 401) {
    document.dispatchEvent(new CustomEvent("app:sessao-expirada"));
    throw new Error("Sessão expirada. Faça login novamente.");
  }
  const corpo = await r.json().catch(() => ({}));
  if (r.status === 409 && corpo?.details?.contexto === "invalido") {
    if (!contextoMudou(g)) {
      limparContexto();
      document.dispatchEvent(new CustomEvent("app:contexto-invalido", { detail: corpo.error }));
    }
    throw new Error(corpo.error || "Contexto encerrado.");
  }
  if (!r.ok) throw new Error(corpo.error || `${r.status} ${r.statusText}`);
  return corpo;
}

const get = (url) => chamar(url);
const post = (url, body) => chamar(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
});

// ---------------------------------------------------------------------------
// Login e identidade
// ---------------------------------------------------------------------------

function traduzErro(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("invalid login")) return "E-mail ou senha incorretos.";
  if (m.includes("email not confirmed")) return "E-mail ainda não confirmado.";
  if (m.includes("rate limit")) return "Muitas tentativas. Aguarde um instante.";
  return msg || "Falha no login.";
}

/**
 * Login: e-mail e senha, nada mais. A empresa NÃO é escolhida aqui — é o
 * requisito central do fluxo novo. O que vem depois do login é a lista de
 * acessos, e a decisão de para onde ir.
 * @param {string} email
 * @param {string} senha
 */
export async function login(email, senha) {
  if (!email?.trim() || !senha?.trim()) throw new Error("Preencha e-mail e senha.");
  const sb = await getSupabase();
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password: senha });
  if (error) throw new Error(traduzErro(error.message));
  limparContexto();               // login novo nunca herda contexto antigo
  await carregarIdentidade();
  return data;
}

/** Carrega /me para state.sessao.usuario. */
export async function carregarIdentidade() {
  const { data } = await get("/api/v1/me");
  state.sessao.usuario = data;
  return data;
}

/** True quando a conta ainda usa a senha provisória definida por um admin. */
export function precisaDefinirSenha() {
  return state.sessao.usuario?.senhaProvisoria === true;
}

/**
 * Define a nova senha do primeiro acesso e recarrega a identidade (a flag
 * `senhaProvisoria` volta como false). Depois disso o fluxo normal segue.
 * @param {string} senha
 */
export async function definirNovaSenha(senha) {
  if (!senha || senha.length < 8) throw new Error("A senha deve ter ao menos 8 caracteres.");
  await post("/api/v1/sessao/senha", { senha });
  await carregarIdentidade();
}

/** Restaura a sessão persistida do Supabase (com refresh do token). */
export async function restaurarSessao() {
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  if (!data?.session?.user) return false;
  await carregarIdentidade();
  return true;
}

export async function logout() {
  // Revoga o contexto no servidor ANTES de derrubar o login: depois do signOut
  // não haveria mais Access Token para autenticar a chamada, e a sessão de
  // contexto ficaria viva até expirar.
  try { await post("/api/v1/sessao/encerrar"); } catch { /* sessão já pode ter caído */ }
  limparContexto();
  try {
    const sb = await getSupabase();
    await sb.auth.signOut();
  } catch { /* ignora */ }
  state.sessao.usuario = null;
}

// ---------------------------------------------------------------------------
// Contexto de empresa
// ---------------------------------------------------------------------------

/** Empresas/unidades que o usuário pode acessar. */
export async function listarAcessos() {
  const { data } = await get("/api/v1/sessao/acessos");
  state.sessao.acessos = data.opcoes ?? [];
  state.sessao.superadmin = !!data.superadmin;
  return data;
}

/**
 * Seleciona a empresa/unidade e recebe o Context Token.
 * @param {{organizacaoId: string, unidadeId?: string|null, troca?: boolean}} escolha
 */
export async function selecionarContexto({ organizacaoId, unidadeId = null, troca = false }) {
  const { data } = await post("/api/v1/sessao/selecionar", { organizacaoId, unidadeId, troca });
  aplicarContexto(data);
  return data;
}

/** Grava no estado o contexto recebido do servidor (seleção ou impersonação). */
export function aplicarContexto(data) {
  // A identidade do contexto muda AQUI — a geração tem que subir junto, antes
  // que mostrarApp() monte a tela nova (ver contextoEscopo.js).
  invalidarGeracaoDeContexto();
  guardarContextToken(data.contextToken);
  state.sessao.empresa = data.empresa;
  state.sessao.unidade = data.unidade;
  state.sessao.papel = data.papel;
  state.sessao.papelRotulo = data.papelRotulo;
  state.sessao.permissoes = data.permissoes ?? [];
  state.sessao.modulos = data.modulos ?? [];
  state.sessao.impersonando = !!data.impersonando;
}

/**
 * Recupera o contexto do servidor após um recarregamento de página.
 * Devolve false se não havia contexto válido — quem chama decide para onde ir.
 */
export async function restaurarContexto() {
  if (!contextTokenAtual()) return false;
  try {
    const { data } = await get("/api/v1/sessao/atual");
    state.sessao.empresa = data.empresa;
    state.sessao.unidade = data.unidade;
    state.sessao.papel = data.papel;
    state.sessao.papelRotulo = data.papelRotulo;
    state.sessao.permissoes = data.permissoes ?? [];
    state.sessao.modulos = data.modulos ?? [];
    state.sessao.impersonando = !!data.impersonando;
    return true;
  } catch {
    limparContexto();
    return false;
  }
}

/** Encerra apenas o contexto (mantém o login). Usado por "Trocar unidade". */
export async function encerrarContexto() {
  try { await post("/api/v1/sessao/encerrar"); } catch { /* ignora */ }
  limparContexto();
}

/** @param {string} permissao */
export function pode(permissao) {
  // Em impersonação o superadmin passa por tudo — o servidor decide igual, e
  // esconder botões aqui só criaria divergência entre UI e API.
  if (state.sessao.impersonando) return true;
  return state.sessao.permissoes.includes(permissao);
}

/**
 * A empresa do contexto atual contratou este módulo? Controla o menu lateral
 * (app.js#montarMenu) e a guarda de rota (router.js#renderRotaAtual). Mesmo
 * bypass de impersonação de `pode()` — o backend (requireModulo) decide
 * igual, então esconder aqui e liberar lá seria a UI mentir para o suporte.
 * @param {string} moduloId
 */
export function temModulo(moduloId) {
  if (state.sessao.impersonando) return true;
  return state.sessao.modulos.includes(moduloId);
}

// Exportado para o cliente do painel SuperAdmin reaproveitar o mesmo
// tratamento de erro e os mesmos cabeçalhos.
export const http = { get, post, chamar, cabecalhos };
