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

/** Monta a query string, descartando vazios / "todos". @param {Record<string, unknown>} p */
function qs(p = {}) {
  const s = Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== "todos")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return s ? `?${s}` : "";
}

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

  // -- Monitoramento (Fase F). Só leitura, Bearer, sem x-context-token. --

  /** Resumo consolidado + "Ação Necessária Hoje" + rollup por empresa. */
  visaoGeral: () => chamar("/visao-geral"),

  /**
   * Lista de unidades num dia (padrão: D-1 do backend). Filtros server-side:
   * `data` (AAAA-MM-DD, nunca hoje/futuro), `organizacaoId`, `status`
   * (categoria do D-1), `criticidade`. A busca textual é client-side.
   * @param {{data?: string, organizacaoId?: string, status?: string, criticidade?: string}} [filtros]
   */
  monitoramentoDiario: (filtros = {}) => chamar("/monitoramento-diario" + qs(filtros)),

  /** Só unidades não-em-dia. Ordem (CRÍTICO → mais antigo → ATENÇÃO) vem pronta. */
  pendencias: () => chamar("/pendencias"),

  /** Rollup por organização (conformidade = Σ/Σ). */
  empresas: () => chamar("/empresas"),

  /** Detalhe de uma empresa: resumo + unidades + pendências. */
  detalheEmpresa: (organizacaoId) => chamar(`/empresas/${encodeURIComponent(organizacaoId)}`),

  /**
   * Calendário mensal de uma unidade.
   * @param {string} unidadeId
   * @param {string} [mes] AAAA-MM (padrão: mês corrente do backend)
   */
  calendarioUnidade: (unidadeId, mes) =>
    chamar(`/unidades/${encodeURIComponent(unidadeId)}/calendario` + qs({ mes })),
};
