// Identidade numa requisição operacional — a distinção CONTA × PESSOA (Fase I).
//
//   req.user   = a CONTA / credencial (Supabase Auth). NUNCA é sobrescrita.
//   req.perfil = a PESSOA operacional (perfis_operacionais). `null` em
//                impersonação e onde não há contexto (rotas sem requireContexto).
//
// Use `identidadeOperacional(req)` para gravar "quem fez isto" nos snapshots de
// histórico das tabelas de domínio (`usuario_nome` / `usuario_email` /
// `usuario_id`, e variantes `atualizado_por_*`, `classificacao_override_*`).
//
// REGRA FIXADA NA FASE I:
//   * nome  -> a PESSOA (`req.perfil.nome`). É o que o frontend mostra em
//              "por Fulano". Cai para o nome da conta só quando não há perfil
//              legítimo (impersonação; ou pré-060 sem camada de perfil).
//   * email -> a CONTA (`req.user.email`). Os perfis compartilham a credencial
//              e não têm e-mail próprio — o snapshot representa "a credencial
//              usada". Documentado; não inventar e-mail por perfil.
//   * id    -> a CONTA (`req.user.id`). As colunas `*_id` dessas tabelas têm
//              FK para `perfis(id)`; trocar para `perfis_operacionais(id)`
//              exigiria migration e quebraria a FK para um 2º perfil (id fora
//              de `perfis`). A pessoa real fica no snapshot `_nome` e em
//              `plataforma_auditoria.perfil_id`. Migrar a FK é decisão de fase
//              futura (ver docs/multi-perfil-fase-i-*.md, seção I).
//
// Para AUDITORIA (`plataforma_auditoria`) NÃO use este helper: lá `ator_id` é a
// CONTA e `perfil_id` é a PESSOA, em colunas separadas — `contextoDaRequisicao`
// (shared/auditoria.js) já resolve isso.

/**
 * @param {{ user?: {id?: string, nome?: string, email?: string}|null,
 *           perfil?: {id?: string, nome?: string}|null,
 *           acesso?: {perfilId?: string|null, impersonando?: boolean}|null }} req
 * @returns {{ contaId: string|null, perfilId: string|null, id: string|null,
 *             nome: string|null, email: string|null, impersonando: boolean }}
 */
export function identidadeOperacional(req) {
  const conta = req?.user ?? null;
  const perfil = req?.perfil ?? null;
  return {
    contaId: conta?.id ?? null,
    perfilId: perfil?.id ?? req?.acesso?.perfilId ?? null,
    // vocabulário das tabelas de domínio ("usuario" = a pessoa do "por Fulano"):
    id: conta?.id ?? null, // FK -> perfis(id); ver nota acima
    nome: perfil?.nome ?? conta?.nome ?? null, // a PESSOA
    email: conta?.email ?? null, // a CONTA (compartilhada)
    impersonando: !!req?.acesso?.impersonando,
  };
}
