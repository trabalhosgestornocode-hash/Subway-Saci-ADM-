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

export async function health() {
  return getJson("/health");
}
