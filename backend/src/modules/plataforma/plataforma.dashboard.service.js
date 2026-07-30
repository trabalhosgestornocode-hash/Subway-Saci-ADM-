// Dashboard Global do SuperAdmin — a visão de saúde do SaaS inteiro.
//
// HONESTIDADE DOS INDICADORES: alguns números pedidos (uso de banco, de
// Storage e de API) não têm fonte dentro deste sistema — vêm do painel do
// Supabase e do Render, via APIs administrativas que exigem credenciais
// próprias. Em vez de inventar um valor, esses cartões voltam com
// `disponivel: false` e a origem necessária. Métrica falsa em painel de
// administração é pior que métrica ausente: leva a decisão errada com
// confiança.

import { supabase } from "../../config/supabase.js";
import { JANELA_ONLINE_MS } from "../../middlewares/auth.js";
import { contarVarios, buscar, serieMensal } from "./plataforma.repo.js";
import { calcularMetricas } from "./plataforma.financeiro.service.js";

/**
 * @typedef {object} IndicadorIndisponivel
 * @property {false} disponivel
 * @property {string} origem  onde esse dado vive de verdade
 */

export async function obterDashboard() {
  const desdeOnline = new Date(Date.now() - JANELA_ONLINE_MS).toISOString();
  const hoje = new Date().toISOString().slice(0, 10);

  const [contagens, metricas, empresasCriadas, usuariosCriados, ultimosLogins, negados, sessoesVivas] =
    await Promise.all([
      contarVarios([
        { chave: "empresasTotal", tabela: "organizacoes" },
        { chave: "empresasAtivas", tabela: "organizacoes", filtro: (q) => q.eq("status", "ativa") },
        { chave: "empresasBloqueadas", tabela: "organizacoes", filtro: (q) => q.eq("status", "bloqueada") },
        { chave: "empresasSuspensas", tabela: "organizacoes", filtro: (q) => q.eq("status", "suspensa") },
        { chave: "empresasTeste", tabela: "organizacoes", filtro: (q) => q.eq("status", "teste") },
        { chave: "empresasCanceladas", tabela: "organizacoes", filtro: (q) => q.eq("status", "cancelada") },
        { chave: "usuariosTotal", tabela: "perfis" },
        { chave: "usuariosAtivos", tabela: "perfis", filtro: (q) => q.eq("ativo", true) },
        { chave: "vinculosAtivos", tabela: "usuarios_organizacoes", filtro: (q) => q.eq("ativo", true) },
        { chave: "unidades", tabela: "unidades", filtro: (q) => q.eq("ativo", true) },
        { chave: "superadmins", tabela: "plataforma_admins", filtro: (q) => q.eq("ativo", true) },
        // Integrações ativas = configurações de integração efetivamente ligadas.
        // Hoje só a Martin Brower tem tabela própria; as demais entram aqui
        // conforme ganharem persistência.
        { chave: "integracoesAtivas", tabela: "mb_configuracoes", filtro: (q) => q.eq("ativo", true) },
        { chave: "cobrancasVencidas", tabela: "cobrancas", filtro: (q) => q.eq("status", "vencida") },
        { chave: "cobrancasPendentes", tabela: "cobrancas", filtro: (q) => q.eq("status", "pendente").lt("vencimento", hoje) },
      ]),
      calcularMetricas(),
      buscar("organizacoes", "created_at"),
      buscar("perfis", "created_at"),
      buscar("plataforma_auditoria", "ator_email, acao, organizacao_id, created_at, ip",
        (q) => q.in("acao", ["sessao.contexto_selecionado", "sessao.contexto_trocado", "impersonacao.iniciada"])
                .order("created_at", { ascending: false }).limit(10)),
      buscar("plataforma_auditoria", "ator_email, acao, detalhes, created_at",
        (q) => q.in("acao", ["sessao.login_negado"]).order("created_at", { ascending: false }).limit(10)),
      buscar("sessoes_contexto", "usuario_id, organizacao_id, papel, impersonado_por, ultimo_uso_em",
        (q) => q.is("revogada_em", null).gte("ultimo_uso_em", desdeOnline).order("ultimo_uso_em", { ascending: false })),
    ]);

  // "Online" = uma sessão de contexto viva e usada na janela. Contamos usuários
  // distintos, não sessões: o mesmo usuário não deve valer dois.
  const usuariosOnline = new Set(sessoesVivas.map((s) => s.usuario_id)).size;

  return {
    empresas: {
      total: contagens.empresasTotal,
      ativas: contagens.empresasAtivas,
      bloqueadas: contagens.empresasBloqueadas,
      suspensas: contagens.empresasSuspensas,
      teste: contagens.empresasTeste,
      canceladas: contagens.empresasCanceladas,
      inadimplentes: metricas.inadimplentes,
    },
    usuarios: {
      total: contagens.usuariosTotal,
      ativos: contagens.usuariosAtivos,
      online: usuariosOnline,
      superadmins: contagens.superadmins,
      vinculosAtivos: contagens.vinculosAtivos,
    },
    operacao: {
      unidades: contagens.unidades,
      integracoesAtivas: contagens.integracoesAtivas,
      sessoesVivas: sessoesVivas.length,
      janelaOnlineMin: JANELA_ONLINE_MS / 60000,
    },
    financeiro: {
      mrr: metricas.mrr,
      arr: metricas.arr,
      churnPct: metricas.churnPct,
      assinaturasAtivas: metricas.assinaturasAtivas,
      inadimplentes: metricas.inadimplentes,
      aReceber: metricas.aReceber,
      recebidoNoMes: metricas.recebidoNoMes,
      cobrancasVencidas: (contagens.cobrancasVencidas ?? 0) + (contagens.cobrancasPendentes ?? 0),
    },
    crescimento: {
      empresas: serieMensal(empresasCriadas.map((e) => e.created_at)),
      usuarios: serieMensal(usuariosCriados.map((u) => u.created_at)),
    },
    ultimosLogins: ultimosLogins.map((l) => ({
      email: l.ator_email, acao: l.acao, organizacaoId: l.organizacao_id, ip: l.ip, em: l.created_at,
    })),
    // "Erros críticos" hoje = acessos negados registrados na auditoria. Erros de
    // aplicação (500) não são persistidos; ligar isso a um coletor externo
    // (Sentry/Logtail) é o próximo passo natural.
    errosCriticos: {
      acessosNegados: negados.length,
      itens: negados.map((n) => ({ email: n.ator_email, detalhes: n.detalhes, em: n.created_at })),
      observacao: "Somente acessos negados. Exceções da aplicação exigem um coletor externo (ex: Sentry).",
    },
    recursos: {
      banco: indisponivel("Supabase Management API (uso de disco do projeto)"),
      storage: indisponivel("Supabase Storage API (bytes por bucket)"),
      api: indisponivel("Métricas do Render / logs de acesso agregados"),
    },
    geradoEm: new Date().toISOString(),
  };
}

/** @param {string} origem @returns {IndicadorIndisponivel} */
function indisponivel(origem) {
  return { disponivel: false, origem };
}

/**
 * Sessões vivas com nome de usuário e empresa — a lista "quem está online".
 * Consulta separada do dashboard porque é detalhe, não indicador.
 */
export async function listarSessoesVivas() {
  const desde = new Date(Date.now() - JANELA_ONLINE_MS).toISOString();
  const { data, error } = await supabase
    .from("sessoes_contexto")
    .select("id, usuario_id, papel, impersonado_por, ip, criada_em, ultimo_uso_em, organizacoes(id, nome), unidades(id, nome)")
    .is("revogada_em", null)
    .gte("ultimo_uso_em", desde)
    .order("ultimo_uso_em", { ascending: false })
    .limit(200);
  if (error) return [];

  // Nome/e-mail vêm de `perfis` numa segunda consulta: o join direto não é
  // possível (sessoes_contexto referencia auth.users, não perfis).
  const ids = [...new Set((data ?? []).map((s) => s.usuario_id))];
  const perfis = ids.length
    ? await buscar("perfis", "id, nome, email", (q) => q.in("id", ids))
    : [];
  const porId = new Map(perfis.map((p) => [p.id, p]));

  return (data ?? []).map((s) => ({
    sessionId: s.id,
    usuarioId: s.usuario_id,
    nome: porId.get(s.usuario_id)?.nome ?? null,
    email: porId.get(s.usuario_id)?.email ?? null,
    empresa: s.organizacoes ? { id: s.organizacoes.id, nome: s.organizacoes.nome } : null,
    unidade: s.unidades ? { id: s.unidades.id, nome: s.unidades.nome } : null,
    papel: s.papel,
    impersonando: !!s.impersonado_por,
    ip: s.ip,
    desde: s.criada_em,
    ultimoUso: s.ultimo_uso_em,
  }));
}
