import { API_BASE } from "./config.js";
import { statusCmv } from "./utils.js";
import { tokenAtual } from "./supabaseClient.js";
import { contextTokenAtual, limparContexto } from "./sessao.js";
import { geracaoContexto, contextoMudou } from "./contextoEscopo.js";

// Anexa as DUAS credenciais a cada requisição:
//   Authorization    -> quem sou eu (Access Token do Supabase)
//   x-context-token  -> em qual empresa estou (token assinado pelo servidor)
// Nenhum organizacao_id/unidade_id trafega mais em header ou corpo: o servidor
// extrai a empresa do Context Token e ignora qualquer id que o cliente informe.
async function comAuth(extra = {}) {
  const token = await tokenAtual();
  const ctx = contextTokenAtual();
  return {
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(ctx ? { "x-context-token": ctx } : {}),
  };
}

// 401 e 409 significam coisas diferentes e levam a lugares diferentes:
//   401 -> o login caiu; volta para a tela de login.
//   409 -> o login está bom, o contexto caiu; volta para a seleção de unidade.
//
// O parâmetro `g` (geração do contexto no momento do ENVIO) existe por causa
// de um bug real na troca de unidade: ao trocar, o contexto anterior é
// revogado no servidor, e qualquer requisição ainda em voo daquele contexto
// volta 409. Sem a checagem de geração, esse 409 atrasado chamava
// `limparContexto()` — apagando o token da unidade NOVA, que era válido — e
// jogava o usuário de volta para a tela de seleção com um "Contexto
// encerrado" que não fazia sentido nenhum. Um 409 só derruba a sessão se for
// do contexto que ainda está valendo.
async function tratar(r, g) {
  if (r.status === 401) {
    document.dispatchEvent(new CustomEvent("app:sessao-expirada"));
    throw new Error("Sessão expirada. Faça login novamente.");
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    if (r.status === 409 && j?.details?.contexto === "invalido" && !contextoMudou(g)) {
      limparContexto();
      document.dispatchEvent(new CustomEvent("app:contexto-invalido", { detail: j.error }));
    }
    throw new Error(j.error || `${r.status} ${r.statusText}`);
  }
  return r.json();
}

async function getJson(url) {
  const g = geracaoContexto();
  return tratar(await fetch(API_BASE + url, { headers: await comAuth() }), g);
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

export async function excluirProduto(id) {
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}/api/v1/produtos/${id}`, { method: "DELETE", headers: await comAuth() });
  return tratar(r, g);
}

export async function atualizarProduto(id, dados) {
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}/api/v1/produtos/${id}`, {
    method: "PUT",
    headers: await comAuth({ "Content-Type": "application/json" }),
    body: JSON.stringify(dados),
  });
  return tratar(r, g);
}

// ---------- Insumos ----------
function qsInsumos(f = {}) {
  const p = Object.entries(f).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== "todos")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return p ? `?${p}` : "";
}
export const listarInsumos = (f) => getJson(`/api/v1/insumos${qsInsumos(f)}`);
export const obterInsumo = (id) => getJson(`/api/v1/insumos/${id}`);
export const insumoProdutos = (id) => getJson(`/api/v1/insumos/${id}/produtos`);
export const criarInsumo = (dados) => postJson(`/api/v1/insumos`, dados);
export async function atualizarInsumo(id, dados) {
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}/api/v1/insumos/${id}`, {
    method: "PUT", headers: await comAuth({ "Content-Type": "application/json" }), body: JSON.stringify(dados),
  });
  return tratar(r, g);
}
export async function excluirInsumo(id) {
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}/api/v1/insumos/${id}`, { method: "DELETE", headers: await comAuth() });
  return tratar(r, g);
}
export async function definirStatusInsumo(id, ativo) {
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}/api/v1/insumos/${id}/status`, {
    method: "PATCH", headers: await comAuth({ "Content-Type": "application/json" }), body: JSON.stringify({ ativo }),
  });
  return tratar(r, g);
}

// ---------- Ficha técnica (editor dentro do produto) ----------
export const adicionarComponente = (produtoId, dados) => postJson(`/api/v1/produtos/${produtoId}/ficha`, dados);
export async function atualizarComponente(produtoId, fichaId, dados) {
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}/api/v1/produtos/${produtoId}/ficha/${fichaId}`, {
    method: "PATCH", headers: await comAuth({ "Content-Type": "application/json" }), body: JSON.stringify(dados),
  });
  return tratar(r, g);
}
export async function removerComponente(produtoId, fichaId) {
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}/api/v1/produtos/${produtoId}/ficha/${fichaId}`, {
    method: "DELETE", headers: await comAuth(),
  });
  return tratar(r, g);
}

// ---------- Usuários (Configurações → Usuários) ----------
export async function obterUsuarios() {
  return getJson("/api/v1/usuarios");
}
export async function criarUsuario(dados) {
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}/api/v1/usuarios`, {
    method: "POST",
    headers: await comAuth({ "Content-Type": "application/json" }),
    body: JSON.stringify(dados),
  });
  return tratar(r, g);
}
export async function atualizarUsuario(id, dados) {
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}/api/v1/usuarios/${id}`, {
    method: "PATCH",
    headers: await comAuth({ "Content-Type": "application/json" }),
    body: JSON.stringify(dados),
  });
  return tratar(r, g);
}
export async function excluirUsuario(id) {
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}/api/v1/usuarios/${id}`, {
    method: "DELETE",
    headers: await comAuth(),
  });
  return tratar(r, g);
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
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}/api/v1/vendas/importacoes/${id}`, { method: "DELETE", headers: await comAuth() });
  return tratar(r, g);
}
export const vendasDivergencias = () => getJson(`/api/v1/vendas/divergencias`);
export const listarProdutosSistema = () => getJson(`/api/v1/produtos?vendavel=true`);

async function postJson(url, body) {
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}${url}`, {
    method: "POST", headers: await comAuth({ "Content-Type": "application/json" }), body: JSON.stringify(body),
  });
  return tratar(r, g);
}
export const vendasPreview = (payload) => postJson(`/api/v1/vendas/importar/preview`, payload);
export const vendasImportar = (payload) => postJson(`/api/v1/vendas/importar`, payload);
export const vendasVincular = (dados) => postJson(`/api/v1/vendas/vincular`, dados);
export const vendasVincularLote = (itens) => postJson(`/api/v1/vendas/vincular-lote`, { itens });
export const vendasComponentesCombo = (codigo) => getJson(`/api/v1/vendas/combos/${encodeURIComponent(codigo)}/componentes`);
export const vendasArquivoOriginal = (id) => getJson(`/api/v1/vendas/importacoes/${id}/arquivo`);
export async function vendasResolverDivergencia(id, resolvida = true) {
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}/api/v1/vendas/divergencias/${id}`, {
    method: "PATCH", headers: await comAuth({ "Content-Type": "application/json" }), body: JSON.stringify({ resolvida }),
  });
  return tratar(r, g);
}

// ---------- Dashboard Executivo (lançamento financeiro diário) ----------
const DEX = "/api/v1/dashboard-executivo";
export const dashExecUnidades = () => getJson(`${DEX}/unidades`);
export const dashExecMes = (f) => getJson(`${DEX}/mes${qs(f)}`);
export const dashExecLancamento = (data, f) => getJson(`${DEX}/lancamentos/${encodeURIComponent(data)}${qs(f)}`);
export const dashExecHistorico = (f) => getJson(`${DEX}/historico${qs(f)}`);
export const dashExecSimuladorPreco = (f) => getJson(`${DEX}/simulador-preco${qs(f)}`);
export const dashExecExcluirLancamento = (id, dados) => postJson(`${DEX}/lancamentos/${id}/excluir`, dados);
export const dashExecCriarLancamento = (dados) => postJson(`${DEX}/lancamentos`, dados);
export async function dashExecAtualizarLancamento(id, dados) {
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}${DEX}/lancamentos/${id}`, {
    method: "PUT", headers: await comAuth({ "Content-Type": "application/json" }), body: JSON.stringify(dados),
  });
  return tratar(r, g);
}

// ---------- Modelo logístico do iFood (Marketplace x Full Service) ----------
export const dashExecModeloLogistico = (unidadeId) => getJson(`${DEX}/unidades/${unidadeId}/modelo-logistico`);
export const dashExecHistoricoModelo = (unidadeId) => getJson(`${DEX}/unidades/${unidadeId}/modelo-logistico/historico`);
export async function dashExecAtualizarModeloLogistico(unidadeId, dados) {
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}${DEX}/unidades/${unidadeId}/modelo-logistico`, {
    method: "PUT", headers: await comAuth({ "Content-Type": "application/json" }), body: JSON.stringify(dados),
  });
  return tratar(r, g);
}

// ---------- Lançamento de faturamento mensal (distribuição p/ meses históricos) ----------
export const dashExecPreviewLancamentoMensal = (dados) => postJson(`${DEX}/lancamentos-mensais`, { ...dados, confirmar: false });
export const dashExecConfirmarLancamentoMensal = (dados) => postJson(`${DEX}/lancamentos-mensais`, { ...dados, confirmar: true });
export const dashExecLancamentoMensal = (f) => getJson(`${DEX}/lancamentos-mensais${qs(f)}`);
export async function dashExecAtualizarLancamentoMensal(id, dados) {
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}${DEX}/lancamentos-mensais/${id}`, {
    method: "PUT", headers: await comAuth({ "Content-Type": "application/json" }), body: JSON.stringify(dados),
  });
  return tratar(r, g);
}
export const dashExecExcluirLancamentoMensal = (id, dados) => postJson(`${DEX}/lancamentos-mensais/${id}/excluir`, dados);

// ---------- Reset de dia (SÓ em unidade de teste) ----------
export const dashExecPreviewResetTeste = (unidadeId, data) => postJson(`${DEX}/unidades/${unidadeId}/reset-teste`, { data, confirmar: false });
export const dashExecConfirmarResetTeste = (unidadeId, data) => postJson(`${DEX}/unidades/${unidadeId}/reset-teste`, { data, confirmar: true });

// ---------- Bonificação Mensal (metas + lançamentos diários + importação Visio) ----------
const BM = "/api/v1/bonificacao-mensal";
export const bonifMes = (f) => getJson(`${BM}/mes${qs(f)}`);
export const bonifMetas = () => getJson(`${BM}/metas`);
export const bonifHistorico = (f) => getJson(`${BM}/historico${qs(f)}`);
export const bonifLancamento = (data) => getJson(`${BM}/lancamentos/${encodeURIComponent(data)}`);
export const bonifSalvarLancamento = (dados) => postJson(`${BM}/lancamentos`, dados);
export const bonifExcluirLancamento = (data, motivo) => postJson(`${BM}/lancamentos/${encodeURIComponent(data)}/excluir`, { motivo });
export const bonifImportacoes = () => getJson(`${BM}/importacoes`);
export const bonifArquivoImportacao = (id) => getJson(`${BM}/importacoes/${id}/arquivo`);
export const bonifImportarPreview = (payload) => postJson(`${BM}/importar/preview`, payload);
export const bonifImportarConfirmar = (payload) => postJson(`${BM}/importar`, payload);

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
  const g = geracaoContexto();
  const r = await fetch(`${API_BASE}${MB}/settings`, {
    method: "PUT", headers: await comAuth({ "Content-Type": "application/json" }), body: JSON.stringify(dados),
  });
  return tratar(r, g);
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
