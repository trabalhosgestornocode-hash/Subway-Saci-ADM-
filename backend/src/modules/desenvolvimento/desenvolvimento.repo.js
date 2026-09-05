import { ApiError } from '../../shared/ApiError.js';
import { CAMPOS_PUBLICOS, CAMPOS_TECNICOS } from './desenvolvimento.domain.js';
export const TABELA = 'desenvolvimento_demandas';
export function resultado({ data, error, count }) {
  if (error) {
    if (error.code === '23505') throw new ApiError(409, 'Já existe um foco atual. Remova o foco anterior antes de definir outro.');
    if (['23503', '23514', '22P02', '22007'].includes(error.code)) throw ApiError.badRequest('Organização, unidade, dependência ou dados incompatíveis.');
    throw ApiError.internal('Não foi possível acessar a agenda de desenvolvimento.');
  }
  return { data, count };
}
export const colunas = admin => CAMPOS_PUBLICOS + (admin ? ',' + CAMPOS_TECNICOS : '');
export function filtrar(q, f) {
  for (const k of ['status', 'prioridade', 'categoria', 'tipo', 'organizacao_id', 'unidade_id', 'responsavel_usuario_id']) if (f[k]) q = q.eq(k, f[k]);
  if (f.sem_responsavel) q = q.is('responsavel_usuario_id', null);
  if (!f.status) q = q.eq('arquivada', false);
  if (f.busca) {
    const termo = f.busca.replace(/[\\%_]/g, '\\$&').replace(/[(),.*"']/g, ' ').trim();
    q = q.or(`codigo.ilike.%${termo}%,titulo.ilike.%${termo}%,descricao.ilike.%${termo}%`);
  }
  if (f.campo_periodo === 'marcos' && (f.de || f.ate)) {
    q = q.or(['inicio_previsto','previsao_entrega','conclusao_real'].map(k => {
      const clauses = [f.de && `${k}.gte.${f.de}`,f.ate && `${k}.lte.${f.ate}`].filter(Boolean);
      return clauses.length === 2 ? `and(${clauses.join(',')})` : clauses[0];
    }).join(','));
  } else {
    if (f.de) q = q.gte(f.campo_periodo, f.de);
    if (f.ate) q = q.lte(f.campo_periodo, f.ate);
  }
  if (f.atrasadas) q = q.lt('previsao_entrega', f.hoje).is('conclusao_real', null).neq('status', 'ARCHIVED');
  return q;
}
export async function listar(db, f, admin) {
  const r = resultado(await filtrar(db.from(TABELA).select(colunas(admin), { count: 'exact' }), f)
    .order('prioridade_ordem').order('ordem').order('numero').range((f.pagina - 1) * f.limite, f.pagina * f.limite - 1));
  return { itens: r.data, total: r.count, pagina: f.pagina, limite: f.limite };
}
export async function obter(db, id, admin) {
  const { data } = resultado(await db.from(TABELA).select(colunas(admin)).eq('id', id).maybeSingle());
  if (!data) throw ApiError.notFound('Demanda não encontrada.');
  return data;
}
export async function historico(db, admin, { id, pagina = 1, limite = 30 } = {}) {
  let q = db.from('desenvolvimento_demanda_atualizacoes').select('id,demanda_id,autor,texto,tipo,visibilidade,created_at,demanda:desenvolvimento_demandas(codigo,titulo)', { count: 'exact' });
  if (id) q = q.eq('demanda_id', id);
  if (!admin) q = q.eq('visibilidade', 'PUBLIC');
  const r = resultado(await q.order('created_at', { ascending: false }).order('id').range((pagina - 1) * limite, pagina * limite - 1));
  return { itens: r.data, total: r.count, pagina, limite };
}
