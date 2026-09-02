// Decisão PURA de "para qual ambiente ir depois do login", a partir da
// resposta de GET /sessao/acessos. Extraída de app.js#encaminhar para ser
// testável sem DOM (a matriz de casos A–F do pedido da Fase D).
//
// NÃO faz I/O, NÃO troca de tela — só devolve a intenção. app.js executa.
//
// Ambientes possíveis para uma conta autenticada:
//   * TENANT (empresa/unidade)     — via `dados.opcoes`
//   * PAINEL SUPERADMIN            — `dados.superadmin`
//   * PAINEL ADMINISTRATIVO        — `dados.painelAdministrativo` (acesso
//                                     efetivo: associação explícita OU
//                                     superadmin por bypass)

/**
 * @param {{opcoes?: Array<{acessivel?: boolean}>, superadmin?: boolean, painelAdministrativo?: boolean}} dados
 * @param {{preferirAdmin?: boolean}} [opcoes]
 * @returns {{destino: 'superadmin'|'auto-tenant'|'selecao', opcao?: object}}
 */
export function rotaPosAcessos(dados, { preferirAdmin = false } = {}) {
  const opcoesLista = Array.isArray(dados?.opcoes) ? dados.opcoes : [];

  // SuperAdmin sem vínculo nenhum (ou que pediu o painel) -> painel da plataforma.
  // Inalterado — CASO E do pedido.
  if (dados?.superadmin && (preferirAdmin || !opcoesLista.length)) {
    return { destino: "superadmin" };
  }

  // Um único acesso tenant: entra direto — MAS só quando não há OUTRO ambiente
  // global disponível. Com Painel Administrativo (ou SuperAdmin), o usuário tem
  // 2+ ambientes e precisa ESCOLHER (itens 19-20). CASO A permanece: 1 empresa,
  // sem nada global -> auto-entra.
  const acessiveis = opcoesLista.filter((o) => o.acessivel);
  if (acessiveis.length === 1 && !dados?.superadmin && !dados?.painelAdministrativo) {
    return { destino: "auto-tenant", opcao: acessiveis[0] };
  }

  // Tudo o mais -> tela de seleção. Inclui: 0 empresas + Painel Administrativo
  // (CASO D) — a seleção NUNCA é um beco sem saída para o usuário administrativo.
  return { destino: "selecao" };
}

/**
 * O botão "Acessar Painel Administrativo" aparece na seleção? (item 5 do pedido)
 * @param {{painelAdministrativo?: boolean}} dados
 */
export function botaoPainelAdmVisivel(dados) {
  return !!dados?.painelAdministrativo;
}
