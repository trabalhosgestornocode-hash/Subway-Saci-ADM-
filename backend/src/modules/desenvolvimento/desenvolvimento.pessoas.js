// Nomes humanos e elegibilidade de responsável.
//
// A agenda NÃO tem cadastro próprio de pessoas. Tudo vem das tabelas que já
// existem e que o middleware `requirePainelAdministrativo` consulta:
//   - `perfis`                          -> nome e e-mail de exibição
//   - `painel_administrativo_usuarios`  -> acesso ao Painel Administrativo
//   - `plataforma_admins`               -> SuperAdmin (bypass do painel)
//
// Regra de exibição: NUNCA devolver UUID cru. A ordem de fallback é
// nome -> e-mail -> rótulo genérico, igual à função SQL
// `desenvolvimento_nome_usuario` usada pelos gatilhos de histórico.
import { supabase } from '../../config/supabase.js';

export const SEM_CADASTRO = 'Usuário sem cadastro';
export const SEM_RESPONSAVEL = 'Sem responsável';
export const SISTEMA = 'Sistema';

/** Quantas contas sem linha em `perfis` vale a pena resolver no Auth por request. */
const LIMITE_AUTH = 25;

const limpar = v => (typeof v === 'string' ? v.trim() : '');

/**
 * Resolve `ids` para `{ id, nome, email }` com nome sempre humano.
 * @param {any} db  cliente service_role
 * @param {Array<string|null|undefined>} ids
 * @returns {Promise<Map<string, {id: string, nome: string, email: string|null}>>}
 */
export async function mapaPessoas(db, ids) {
  const alvos = [...new Set((ids ?? []).filter(Boolean))];
  const mapa = new Map();
  if (!alvos.length) return mapa;

  const { data } = await db.from('perfis').select('id,nome,email').in('id', alvos);
  for (const p of data ?? []) {
    const nome = limpar(p.nome) || limpar(p.email);
    if (nome) mapa.set(p.id, { id: p.id, nome, email: limpar(p.email) || null });
  }

  // O SuperAdmin não pertence a nenhuma empresa e pode não ter linha em
  // `perfis` — nesse caso a identidade vem do Auth, nunca o UUID.
  let restantes = alvos.filter(id => !mapa.has(id));
  for (const id of restantes.slice(0, LIMITE_AUTH)) {
    let email = null;
    try { email = limpar((await db.auth?.admin?.getUserById?.(id))?.data?.user?.email) || null; } catch { email = null; }
    mapa.set(id, { id, nome: email ?? SEM_CADASTRO, email });
  }
  for (const id of restantes.slice(LIMITE_AUTH)) mapa.set(id, { id, nome: SEM_CADASTRO, email: null });
  return mapa;
}

/** Nome de exibição de um id já resolvido. `vazio` cobre o id nulo. */
export const nomeDe = (mapa, id, vazio = SEM_RESPONSAVEL) => (id ? mapa.get(id)?.nome ?? SEM_CADASTRO : vazio);

/**
 * Contas que PODEM ser responsáveis: quem entra no Painel Administrativo.
 * É a mesma união que `desenvolvimento_pode_ser_responsavel` aplica no banco —
 * a validação existe nas duas camadas de propósito.
 * @returns {Promise<Array<{id: string, nome: string, email: string|null, superadmin: boolean}>>}
 */
export async function responsaveisElegiveis(db = supabase) {
  const [painel, admins] = await Promise.all([
    db.from('painel_administrativo_usuarios').select('usuario_id').eq('ativo', true),
    db.from('plataforma_admins').select('usuario_id').eq('ativo', true),
  ]);
  const idsAdmin = new Set((admins.data ?? []).map(r => r.usuario_id));
  const ids = [...new Set([...(painel.data ?? []).map(r => r.usuario_id), ...idsAdmin])];
  const mapa = await mapaPessoas(db, ids);
  return ids
    .map(id => ({ ...(mapa.get(id) ?? { id, nome: SEM_CADASTRO, email: null }), superadmin: idsAdmin.has(id) }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

/** O usuário pode ser responsável? Consulta pontual, sem montar a lista toda. */
export async function podeSerResponsavel(db, id) {
  if (!id) return false;
  const [painel, admin] = await Promise.all([
    db.from('painel_administrativo_usuarios').select('usuario_id').eq('usuario_id', id).eq('ativo', true).maybeSingle(),
    db.from('plataforma_admins').select('usuario_id').eq('usuario_id', id).eq('ativo', true).maybeSingle(),
  ]);
  return !!(painel.data || admin.data);
}
