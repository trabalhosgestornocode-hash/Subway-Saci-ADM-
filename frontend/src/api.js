import { API_BASE } from "./config.js";
import { statusCmv } from "./utils.js";
import { tokenAtual } from "./supabaseClient.js";

// Anexa o token JWT da sessão a cada requisição.
async function comAuth(extra = {}) {
  const token = await tokenAtual();
  return { ...extra, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function tratar(r) {
  if (r.status === 401) {
    document.dispatchEvent(new CustomEvent("app:sessao-expirada"));
    throw new Error("Sessão expirada. Faça login novamente.");
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `${r.status} ${r.statusText}`);
  }
  return r.json();
}

async function getJson(url) {
  return tratar(await fetch(API_BASE + url, { headers: await comAuth() }));
}

// Compatível com a API atual: nome, tamanho, preco, custo, cmv_pct, lucro_liquido, desatualizado.
export async function carregarCmv(canal, tabela) {
  const [cmv, prods] = await Promise.all([
    getJson(`/api/v1/cmv?canal=${encodeURIComponent(canal)}&tabela=${encodeURIComponent(tabela)}`),
    getJson(`/api/v1/produtos?vendavel=true`).catch(() => ({ data: [] })),
  ]);
  const catPorId = {};
  for (const p of prods.data ?? []) catPorId[p.id] = p.tipo;
  return (cmv.data ?? []).map((r) => ({
    ...r,
    categoria: r.categoria ?? catPorId[r.produto_id] ?? null,
    _status: statusCmv(r.cmv_pct),
  }));
}

export async function obterProduto(id) {
  return getJson(`/api/v1/produtos/${id}`);
}

export async function obterHistoricoProduto(id) {
  return getJson(`/api/v1/produtos/${id}/historico`);
}

export async function obterHistoricoRecente(limite = 8) {
  return getJson(`/api/v1/produtos/historico/recentes?limite=${limite}`);
}

export async function atualizarProduto(id, dados) {
  const r = await fetch(`${API_BASE}/api/v1/produtos/${id}`, {
    method: "PUT",
    headers: await comAuth({ "Content-Type": "application/json" }),
    body: JSON.stringify(dados),
  });
  return tratar(r);
}

// ---------- Usuários (Configurações → Usuários) ----------
export async function obterUsuarios() {
  return getJson("/api/v1/usuarios");
}
export async function criarUsuario(dados) {
  const r = await fetch(`${API_BASE}/api/v1/usuarios`, {
    method: "POST",
    headers: await comAuth({ "Content-Type": "application/json" }),
    body: JSON.stringify(dados),
  });
  return tratar(r);
}
export async function atualizarUsuario(id, dados) {
  const r = await fetch(`${API_BASE}/api/v1/usuarios/${id}`, {
    method: "PATCH",
    headers: await comAuth({ "Content-Type": "application/json" }),
    body: JSON.stringify(dados),
  });
  return tratar(r);
}
export async function excluirUsuario(id) {
  const r = await fetch(`${API_BASE}/api/v1/usuarios/${id}`, {
    method: "DELETE",
    headers: await comAuth(),
  });
  return tratar(r);
}

// ---------- Vendas (consolidação SW / PDV / iFood) ----------
function qs(params = {}) {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== "todos")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return p ? `?${p}` : "";
}
export const vendasVisaoGeral   = (f) => getJson(`/api/v1/vendas/visao-geral${qs(f)}`);
export const vendasFaturamento  = (f) => getJson(`/api/v1/vendas/faturamento${qs(f)}`);
export const vendasProdutos     = (f) => getJson(`/api/v1/vendas/produtos${qs(f)}`);
export const vendasImportacoes  = () => getJson(`/api/v1/vendas/importacoes`);
export async function vendasExcluirImportacao(id) {
  const r = await fetch(`${API_BASE}/api/v1/vendas/importacoes/${id}`, { method: "DELETE", headers: await comAuth() });
  return tratar(r);
}
export const vendasDivergencias = () => getJson(`/api/v1/vendas/divergencias`);
export const listarProdutosSistema = () => getJson(`/api/v1/produtos?vendavel=true`);

async function postJson(url, body) {
  const r = await fetch(`${API_BASE}${url}`, {
    method: "POST", headers: await comAuth({ "Content-Type": "application/json" }), body: JSON.stringify(body),
  });
  return tratar(r);
}
export const vendasPreview = (payload) => postJson(`/api/v1/vendas/importar/preview`, payload);
export const vendasImportar = (payload) => postJson(`/api/v1/vendas/importar`, payload);
export const vendasVincular = (dados) => postJson(`/api/v1/vendas/vincular`, dados);
export const vendasVincularLote = (itens) => postJson(`/api/v1/vendas/vincular-lote`, { itens });
export const vendasComponentesCombo = (codigo) => getJson(`/api/v1/vendas/combos/${encodeURIComponent(codigo)}/componentes`);
export const vendasArquivoOriginal = (id) => getJson(`/api/v1/vendas/importacoes/${id}/arquivo`);
export async function vendasResolverDivergencia(id, resolvida = true) {
  const r = await fetch(`${API_BASE}/api/v1/vendas/divergencias/${id}`, {
    method: "PATCH", headers: await comAuth({ "Content-Type": "application/json" }), body: JSON.stringify({ resolvida }),
  });
  return tratar(r);
}

// ---------- Martin Brower (integração com o portal da distribuidora) ----------
// Nenhuma credencial trafega aqui na fase atual: a sincronização automatizada
// depende de MB_PLAYWRIGHT_ENABLED no backend, e enquanto estiver desligada o
// formulário de senha nem é exibido.
const MB = "/api/v1/integracoes/martin-brower";

export const mbConfiguracao   = () => getJson(`${MB}/settings`);
export const mbProdutos       = (f) => getJson(`${MB}/products${qs(f)}`);
export const mbHistoricoPrecos = (f) => getJson(`${MB}/price-history${qs(f)}`);
export const mbHistoricoSincronizacoes = () => getJson(`${MB}/sync-history`);
export const mbSemVinculo     = () => getJson(`${MB}/unlinked`);
export const mbStatusSessao   = (sessionId) => getJson(`${MB}/${sessionId}/status`);

export async function mbSalvarConfiguracao(dados) {
  const r = await fetch(`${API_BASE}${MB}/settings`, {
    method: "PUT", headers: await comAuth({ "Content-Type": "application/json" }), body: JSON.stringify(dados),
  });
  return tratar(r);
}
export const mbVincular = (dados) => postJson(`${MB}/links`, dados);
export async function mbDesvincular(mbProdutoId) {
  return tratar(await fetch(`${API_BASE}${MB}/links/${mbProdutoId}`, { method: "DELETE", headers: await comAuth() }));
}

// Importação manual do JSON de loadItens — ferramenta TEMPORÁRIA de teste,
// usada para validar normalização/filtros/upsert enquanto o worker não existe.
export const mbImportarManual = (payload) => postJson(`${MB}/import-manual`, payload);

// Sincronização automatizada (Fase 3). Só respondem com o worker habilitado.
export const mbIniciarSincronizacao = (credenciais) => postJson(`${MB}/start`, credenciais);
export const mbInformarCodigo = (sessionId, codigo) => postJson(`${MB}/${sessionId}/code`, { codigo });
export const mbCancelarSincronizacao = (sessionId) => postJson(`${MB}/${sessionId}/cancel`, {});

export async function health() {
  return getJson("/health");
}
