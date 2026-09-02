// Controller do PAINEL ADMINISTRATIVO da Crescer com Delivery.
//
// Um TERCEIRO ambiente, além do operacional (empresa/unidade) e do Painel
// SuperAdmin. É GERENCIAL: monitoramento cross-tenant do preenchimento e da
// qualidade dos dados das empresas acompanhadas pela Crescer. NÃO tem poder
// técnico de SuperAdmin.
//
// TODA rota deste módulo já passou por:
//   requireAuth  ->  exigirSenhaDefinitiva  ->  requirePainelAdministrativo
// (o último aplicado ao router INTEIRO em administrativo.routes.js — mesma
// disciplina do plataformaRouter). NENHUMA rota daqui usa requireContexto: o
// Painel Administrativo não opera sob o contexto de nenhuma empresa. As
// leituras cross-tenant (fases seguintes) vivem SOMENTE dentro deste módulo,
// com service_role, exatamente como plataforma.*.
//
// FASE B: só o `ping` de sanidade da cadeia de autorização. Os endpoints de
// monitoramento (resumo, AÇÃO NECESSÁRIA HOJE, dashboard-ifood/status,
// dashboard-ifood/pendencias, calendário por unidade, histórico) entram nas
// fases E/F, reaproveitando statusMes/RESOLVIDOS do Dashboard iFood.

/**
 * GET /api/v1/administrativo/ping
 *
 * Sanidade da autorização: responde 200 apenas para quem passou por
 * `requirePainelAdministrativo`. Um usuário sem acesso nunca chega até aqui
 * (o middleware devolve 403 antes). Serve para o frontend confirmar o acesso
 * ao abrir o painel e para os testes de ponta a ponta das próximas fases.
 */
export function ping(req, res) {
  const viaSuperadmin = !!req.user?.superadmin && !req.user?.painelAdministrativo;
  res.json({
    data: {
      ok: true,
      ambiente: "painel_administrativo",
      usuario: { id: req.user.id, nome: req.user.nome },
      via: viaSuperadmin ? "superadmin" : "painel_administrativo",
    },
  });
}

/** Qualquer rota não mapeada sob /administrativo é 404 em JSON (nunca cai no app). */
export function naoEncontrado(req, res) {
  res.status(404).json({ error: `Rota não encontrada: ${req.method} ${req.originalUrl}` });
}
