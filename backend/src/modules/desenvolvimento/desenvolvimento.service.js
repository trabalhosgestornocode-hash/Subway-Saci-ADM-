import { supabase } from '../../config/supabase.js';
import { ApiError } from '../../shared/ApiError.js';
import * as d from './desenvolvimento.domain.js';
import * as repo from './desenvolvimento.repo.js';
import * as pessoas from './desenvolvimento.pessoas.js';
const dbDe = deps => deps.supabase ?? supabase;

// ---------------------------------------------------------------------------
// AUTORIZAÇÃO — duas faixas, nunca três.
//
//   Painel Administrativo (inclui o SuperAdmin, que faz bypass):
//     ler, criar, editar, mover status/prioridade/progresso/previsão,
//     trocar responsável, concluir, reabrir, arquivar e publicar
//     atualizações PÚBLICAS.
//
//   SuperAdmin, e só ele:
//     exclusão definitiva, nota interna, link técnico e atualizações
//     INTERNAL — tanto para escrever quanto para ler.
//
// Nada disso é decidido no frontend: `pode_editar`/`pode_administrar` nas
// respostas são dicas de UI. O bloqueio real está aqui e no router.
// ---------------------------------------------------------------------------

/** @returns {boolean} `true` se o usuário é SuperAdmin. */
export function autorizar(user) {
  if (!user) throw ApiError.unauthorized();
  if (!user.superadmin && !user.painelAdministrativo) throw ApiError.forbidden('Acesso não autorizado à agenda.');
  return !!user.superadmin;
}

/** Ações exclusivas do SuperAdmin. Um usuário do painel recebe 403, não 404. */
export function autorizarSuperadmin(user, mensagem = 'Ação restrita ao SuperAdmin.') {
  if (!autorizar(user)) throw ApiError.forbidden(mensagem);
  return true;
}

export function filtros(query = {}) {
  const permitidos = ['busca','status','prioridade','categoria','tipo','organizacao_id','unidade_id','responsavel_usuario_id','minhas','sem_responsavel','de','ate','campo_periodo','atrasadas','pagina','limite'];
  if (Object.keys(query).some(k => !permitidos.includes(k))) throw ApiError.badRequest('Filtro desconhecido.');
  const f = { pagina: 1, limite: 60, campo_periodo: 'previsao_entrega', ...query, hoje: d.hojeBrasil() };
  for (const k of ['pagina','limite']) { f[k] = Number(f[k]); if (!Number.isInteger(f[k]) || f[k] < 1 || f[k] > (k === 'limite' ? 100 : 1000000)) throw ApiError.badRequest('Paginação inválida.'); }
  for (const [k, valores] of Object.entries({ status: Object.keys(d.STATUS), prioridade: Object.keys(d.PRIORIDADES), categoria: d.CATEGORIAS, tipo: d.TIPOS, campo_periodo: ['inicio_previsto','previsao_entrega','conclusao_real','marcos'] })) if (f[k] && !valores.includes(f[k])) throw ApiError.badRequest('Filtro inválido: ' + k);
  for (const k of ['organizacao_id','unidade_id','responsavel_usuario_id']) if (f[k]) d.uuid(f[k]);
  for (const k of ['de','ate']) if (f[k] && !d.dataValida(f[k])) throw ApiError.badRequest('Período inválido.');
  if (f.de && f.ate && f.de > f.ate) throw ApiError.badRequest('Período invertido.');
  if (f.busca !== undefined && (typeof f.busca !== 'string' || f.busca.length > 180)) throw ApiError.badRequest('Pesquisa inválida.');
  for (const k of ['atrasadas','minhas','sem_responsavel']) {
    if (f[k] !== undefined && !['true','false'].includes(String(f[k]))) throw ApiError.badRequest('Filtro booleano inválido: ' + k);
    f[k] = String(f[k]) === 'true';
  }
  if (f.minhas && f.sem_responsavel) throw ApiError.badRequest('"Minhas demandas" e "Sem responsável" se excluem.');
  return f;
}

/** "Minhas demandas" resolve pela SESSÃO — o cliente não escolhe de quem. */
function aplicarMinhas(f, user) {
  if (f.minhas) f.responsavel_usuario_id = user.id;
  return f;
}

const decorar = x => ({ ...x, indicador_prazo: d.prazo(x) });

/**
 * Acrescenta os nomes humanos de criador, responsável e último editor.
 * Uma consulta de nomes por resposta, não uma por linha.
 */
async function comNomes(db, linhas) {
  const lista = Array.isArray(linhas) ? linhas : [linhas];
  const mapa = await pessoas.mapaPessoas(db, lista.flatMap(x => x ? [x.criado_por, x.atualizado_por, x.responsavel_usuario_id] : []));
  const enriquecer = x => x && ({
    ...x,
    criado_por_nome: pessoas.nomeDe(mapa, x.criado_por, pessoas.SISTEMA),
    atualizado_por_nome: pessoas.nomeDe(mapa, x.atualizado_por, pessoas.SISTEMA),
    responsavel_nome: pessoas.nomeDe(mapa, x.responsavel_usuario_id, pessoas.SEM_RESPONSAVEL),
  });
  return Array.isArray(linhas) ? lista.map(enriquecer) : enriquecer(linhas);
}

/** Histórico com `autor_nome`. O UUID do autor nunca é a fonte de exibição. */
async function historicoComNomes(db, admin, opcoes) {
  const r = await repo.historico(db, admin, opcoes);
  const mapa = await pessoas.mapaPessoas(db, r.itens.map(x => x.autor));
  return { ...r, itens: r.itens.map(x => ({ ...x, autor_nome: pessoas.nomeDe(mapa, x.autor, pessoas.SISTEMA) })) };
}

const permissoes = admin => ({ pode_editar: true, pode_administrar: admin });

export async function listar(user, query, deps = {}) {
  const admin = autorizar(user); const db = dbDe(deps); const f = aplicarMinhas(filtros(query), user);
  const r = await repo.listar(db, f, admin);
  return { ...r, itens: await comNomes(db, r.itens.map(decorar)), ...permissoes(admin) };
}
export async function obter(user, id, deps = {}) {
  const admin = autorizar(user); const db = dbDe(deps);
  return { ...await comNomes(db, decorar(await repo.obter(db, d.uuid(id), admin))), ...permissoes(admin) };
}
export async function atualizacoes(user, query = {}, deps = {}) {
  const admin = autorizar(user); const db = dbDe(deps); const { demanda_id, ...q } = query;
  if (Object.keys(q).some(k => !['pagina','limite'].includes(k))) throw ApiError.badRequest('Filtro desconhecido.');
  const f = filtros(q);
  if (demanda_id) await repo.obter(db, d.uuid(demanda_id), admin);
  return historicoComNomes(db, admin, { id: demanda_id, pagina: f.pagina, limite: f.limite });
}
async function validarRelacoes(db, dados) {
  if (dados.organizacao_id) {
    const { data } = repo.resultado(await db.from('organizacoes').select('id').eq('id', dados.organizacao_id).maybeSingle());
    if (!data) throw ApiError.badRequest('Organização não encontrada.');
  }
  if (dados.unidade_id) {
    const { data } = repo.resultado(await db.from('unidades').select('id,organizacao_id').eq('id', dados.unidade_id).maybeSingle());
    if (!data || data.organizacao_id !== dados.organizacao_id) throw ApiError.badRequest('Unidade incompatível com organização.');
  }
  if (dados.dependencia_id) await repo.obter(db, dados.dependencia_id, true);
}
export async function salvar(user, id, body, deps = {}) {
  const admin = autorizar(user); const db = dbDe(deps);
  const atual = id ? await repo.obter(db, d.uuid(id), true) : null;
  const dados = d.validarDemanda(body, atual);
  // Campos técnicos: nem escrever, nem ver a diferença. Rejeita antes de tocar o banco.
  if (!admin && d.CAMPOS_RESTRITOS.some(k => Object.hasOwn(dados, k))) throw ApiError.forbidden('Nota interna e link técnico são exclusivos do SuperAdmin.');
  await validarRelacoes(db, { ...atual, ...dados });
  // Responsável precisa ser conta com acesso ao painel — checado aqui e de novo
  // pelo gatilho da migration 070, para que nenhuma via de escrita escape.
  if (Object.hasOwn(dados, 'responsavel_usuario_id') && dados.responsavel_usuario_id
      && !await pessoas.podeSerResponsavel(db, dados.responsavel_usuario_id)) {
    throw ApiError.badRequest('O responsável precisa ser um usuário com acesso ao Painel Administrativo.');
  }
  const { versao, ...campos } = dados;
  // Autoria vem SEMPRE da sessão. `criado_por`/`atualizado_por` não são
  // aceitos no corpo (validarDemanda rejeita campos fora da lista permitida).
  campos.atualizado_por = user.id;
  let q;
  if (id) q = db.from(repo.TABELA).update(campos).eq('id', id).eq('versao', versao);
  else q = db.from(repo.TABELA).insert({ ...campos, criado_por: user.id });
  const { data } = repo.resultado(await q.select(repo.colunas(admin)).maybeSingle());
  if (!data) throw new ApiError(409, 'Esta demanda foi alterada por outra pessoa. Recarregue antes de salvar.');
  return { ...await comNomes(db, decorar(data)), ...permissoes(admin) };
}
export async function excluir(user, id, body, deps = {}) {
  autorizarSuperadmin(user, 'A exclusão definitiva é restrita ao SuperAdmin. Arquive a demanda para tirá-la das visualizações ativas.');
  d.uuid(id);
  if (!body || Object.keys(body).some(k => k !== 'versao') || !Number.isInteger(body.versao) || body.versao < 1) throw ApiError.badRequest('Versão obrigatória.');
  const { data } = repo.resultado(await dbDe(deps).rpc('desenvolvimento_excluir', { p_id: id, p_versao: body.versao, p_autor: user.id }));
  if (!data) throw new ApiError(409, 'Demanda alterada ou excluída. Recarregue a agenda.');
  return { excluida: true };
}
export async function adicionarAtualizacao(user, id, body, deps = {}) {
  const admin = autorizar(user); const db = dbDe(deps); await repo.obter(db, d.uuid(id), true);
  const dados = d.validarAtualizacao(body);
  if (dados.visibilidade === 'INTERNAL' && !admin) throw ApiError.forbidden('Atualizações internas são exclusivas do SuperAdmin.');
  // O autor é a sessão. O corpo sequer aceita a chave `autor`.
  const criada = repo.resultado(await db.from('desenvolvimento_demanda_atualizacoes').insert({ ...dados, demanda_id: id, autor: user.id }).select('id,demanda_id,autor,texto,tipo,visibilidade,created_at').single()).data;
  const mapa = await pessoas.mapaPessoas(db, [criada.autor]);
  return { ...criada, autor_nome: pessoas.nomeDe(mapa, criada.autor, pessoas.SISTEMA) };
}
export async function resumo(user, deps = {}) {
  const admin = autorizar(user); const db = dbDe(deps); const hoje = d.hojeBrasil();
  const mes = hoje.slice(0,7) + '-01'; const proximoMes = new Date(Date.UTC(Number(hoje.slice(0,4)), Number(hoje.slice(5,7)), 1)).toISOString().slice(0,10);
  const contar = async q => repo.resultado(await q).count;
  const base = () => db.from(repo.TABELA).select('id', { count: 'exact', head: true });
  const [andamento, planejadas, validacao, bloqueadas, entregues, minhas, foco, proximas, entrega, recentes] = await Promise.all([
    ...['IN_PROGRESS','PLANNED','VALIDATION','BLOCKED'].map(s => contar(base().eq('status',s))),
    contar(base().gte('conclusao_real', mes).lt('conclusao_real', proximoMes)),
    contar(base().eq('responsavel_usuario_id', user.id).eq('arquivada', false)),
    db.from(repo.TABELA).select(repo.colunas(admin)).eq('foco_atual', true).maybeSingle(),
    db.from(repo.TABELA).select(repo.colunas(admin)).eq('status','PLANNED').order('prioridade_ordem').order('ordem').order('numero').limit(5),
    db.from(repo.TABELA).select('id,codigo,titulo,previsao_entrega').eq('arquivada',false).is('conclusao_real',null).not('previsao_entrega','is',null).order('previsao_entrega').limit(1),
    historicoComNomes(db, admin, { limite: 8 }),
  ]);
  const f = repo.resultado(foco).data;
  const [focoNomeado, proximasNomeadas] = await Promise.all([
    f ? comNomes(db, decorar(f)) : null,
    comNomes(db, repo.resultado(proximas).data.map(decorar)),
  ]);
  return { andamento, planejadas, validacao, bloqueadas, entregues_mes: entregues, minhas, mes: hoje.slice(0,7), foco: focoNomeado, proximas: proximasNomeadas, proxima_entrega: repo.resultado(entrega).data[0] ?? null, recentes: recentes.itens, ...permissoes(admin) };
}
export async function catalogos(user, deps = {}) {
  const admin = autorizar(user); const db = dbDe(deps);
  // Pagina catálogos para não truncar na limitação padrão do PostgREST.
  async function todos(tabela, campos) { const itens = []; for (let i=0;;i+=500) { const r = repo.resultado(await db.from(tabela).select(campos).order('id').range(i,i+499)).data; itens.push(...r); if (r.length<500) return itens; } }
  const [organizacoes, unidades, responsaveis] = await Promise.all([
    todos('organizacoes','id,nome'),
    todos('unidades','id,nome,organizacao_id'),
    pessoas.responsaveisElegiveis(db),
  ]);
  // `usuario_atual` alimenta o padrão do formulário e o atalho "Minhas demandas".
  const eu = responsaveis.find(p => p.id === user.id);
  return {
    status: d.STATUS, prioridades: d.PRIORIDADES, categorias: d.CATEGORIAS, tipos: d.TIPOS,
    organizacoes, unidades, responsaveis,
    usuario_atual: { id: user.id, nome: eu?.nome ?? user.nome ?? user.email ?? pessoas.SEM_CADASTRO, pode_ser_responsavel: !!eu },
    ...permissoes(admin),
  };
}
