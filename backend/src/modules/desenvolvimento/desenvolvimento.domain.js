import { ApiError } from '../../shared/ApiError.js';

export const STATUS = { BACKLOG: 'Backlog', PLANNED: 'Planejada', IN_PROGRESS: 'Em desenvolvimento', VALIDATION: 'Em validação', BLOCKED: 'Bloqueada', COMPLETED: 'Concluída', ARCHIVED: 'Arquivada' };
export const PRIORIDADES = { CRITICAL: 'Crítica', HIGH: 'Alta', MEDIUM: 'Média', LOW: 'Baixa' };
export const TIPOS = ['Feature', 'Melhoria', 'Correção', 'Segurança', 'Infraestrutura', 'Refatoração', 'Integração', 'Manutenção'];
export const CATEGORIAS = ['Operação', 'Dashboard iFood', 'Financeiro', 'Bonificação', 'Parser Food Delivery', 'Plano de Ação', 'Agente Crescer', 'Painel Administrativo', 'Usuários e Acessos', 'Segurança', 'Integrações', 'Infraestrutura', 'Banco de Dados', 'UX/UI', 'Correções', 'Outros'];
export const ESCOPOS = ['PLATFORM', 'ORGANIZATION', 'UNIT'];
export const CAMPOS_PUBLICOS = 'id,codigo,titulo,descricao,objetivo,impacto,resumo_entrega,categoria,tipo,prioridade,status,progresso,escopo,organizacao_id,unidade_id,inicio_previsto,inicio_real,previsao_entrega,conclusao_real,proximo_passo,bloqueio,dependencia_id,atualizacao_publica,foco_atual,ordem,arquivada,created_at,updated_at,criado_por,atualizado_por,responsavel_usuario_id,versao';
export const CAMPOS_TECNICOS = 'nota_interna,link_tecnico';
const textos = { titulo: 180, descricao: 10000, objetivo: 5000, impacto: 5000, resumo_entrega: 5000, proximo_passo: 3000, bloqueio: 3000, atualizacao_publica: 5000, nota_interna: 10000, link_tecnico: 2000 };
const datas = ['inicio_previsto', 'inicio_real', 'previsao_entrega', 'conclusao_real'];
const enums = { status: Object.keys(STATUS), prioridade: Object.keys(PRIORIDADES), categoria: CATEGORIAS, tipo: TIPOS, escopo: ESCOPOS };
const ids = ['organizacao_id', 'unidade_id', 'dependencia_id', 'responsavel_usuario_id'];
// Campos que só o SuperAdmin escreve ou lê. Ficam FORA da projeção pública.
export const CAMPOS_RESTRITOS = ['nota_interna', 'link_tecnico'];
export const hojeBrasil = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
export function uuid(v) { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw ApiError.badRequest('Identificador inválido.'); return v; }
export function dataValida(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v; }
export function prazo(d, hoje = hojeBrasil()) {
  if (d.conclusao_real || d.status === 'COMPLETED') return 'Concluída';
  if (d.arquivada || d.status === 'ARCHIVED') return 'Arquivada';
  if (!d.previsao_entrega) return 'Sem previsão';
  const dias = (Date.parse(d.previsao_entrega) - Date.parse(hoje)) / 86400000;
  return dias < 0 ? 'Atrasada' : dias <= 2 ? 'Atenção' : 'No prazo';
}
export function validarDemanda(body, atual = null) {
  if (!body || Array.isArray(body) || typeof body !== 'object') throw ApiError.badRequest('Informe os dados da demanda.');
  const permitidos = [...Object.keys(textos), ...datas, ...Object.keys(enums), ...ids, 'progresso', 'foco_atual', 'ordem', 'versao'];
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (!permitidos.includes(k)) throw ApiError.badRequest(`Campo não permitido: ${k}.`);
    if (k in textos) {
      if (typeof v !== 'string' || v.length > textos[k] || (k === 'titulo' && !v.trim())) throw ApiError.badRequest(`Valor inválido: ${k}.`);
      out[k] = v.trim();
    } else if (k in enums) {
      if (!enums[k].includes(v)) throw ApiError.badRequest(`Valor inválido: ${k}.`);
      out[k] = v;
    } else if (datas.includes(k)) {
      if (v !== null && !dataValida(v)) throw ApiError.badRequest(`Data inválida: ${k}.`);
      out[k] = v;
    } else if (ids.includes(k)) out[k] = v === null ? null : uuid(v);
    else if (k === 'foco_atual') {
      if (typeof v !== 'boolean') throw ApiError.badRequest('Foco inválido.');
      out[k] = v;
    } else {
      if (!Number.isInteger(v) || v < (k === 'versao' ? 1 : 0) || v > (k === 'progresso' ? 100 : 2147483646)) throw ApiError.badRequest(`Valor inválido: ${k}.`);
      out[k] = v;
    }
  }
  if (!atual && !out.titulo) throw ApiError.badRequest('Título obrigatório.');
  if (atual && !out.versao) throw ApiError.badRequest('Versão obrigatória. Recarregue a demanda.');
  const d = { status: 'BACKLOG', prioridade: 'MEDIUM', categoria: 'Outros', tipo: 'Feature', escopo: 'PLATFORM', progresso: 0, ...atual, ...out };
  if (d.link_tecnico) { try { const u = new URL(d.link_tecnico); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error(); } catch { throw ApiError.badRequest('Link técnico deve ser HTTP ou HTTPS sem credenciais.'); } }
  if ((d.escopo === 'PLATFORM' && (d.organizacao_id || d.unidade_id)) || (d.escopo === 'ORGANIZATION' && (!d.organizacao_id || d.unidade_id)) || (d.escopo === 'UNIT' && (!d.organizacao_id || !d.unidade_id))) throw ApiError.badRequest('Organização/unidade incompatível com o escopo.');
  if (d.inicio_previsto && d.previsao_entrega && d.inicio_previsto > d.previsao_entrega) throw ApiError.badRequest('A previsão deve ser posterior ao início previsto.');
  if (d.inicio_real && d.conclusao_real && d.inicio_real > d.conclusao_real) throw ApiError.badRequest('A conclusão deve ser posterior ao início real.');
  if (d.status === 'BLOCKED' && !d.bloqueio?.trim()) throw ApiError.badRequest('Descreva o bloqueio atual.');
  if (d.dependencia_id && d.dependencia_id === atual?.id) throw ApiError.badRequest('Uma demanda não pode depender de si mesma.');
  if (d.status === 'COMPLETED') out.progresso = 100;
  if (atual?.status === 'BLOCKED' && d.status !== 'BLOCKED' && !Object.hasOwn(body,'bloqueio')) out.bloqueio = '';
  if (atual?.status === 'COMPLETED' && !['COMPLETED', 'ARCHIVED'].includes(d.status)) { out.conclusao_real = null; if (d.progresso === 100) out.progresso = 0; }
  if (!['COMPLETED', 'ARCHIVED'].includes(d.status) && (Object.hasOwn(out,'conclusao_real') ? out.conclusao_real : d.conclusao_real)) throw ApiError.badRequest('Conclusão exige status Concluída.');
  return out;
}
export function validarAtualizacao(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['texto', 'tipo', 'visibilidade'].includes(k))) throw ApiError.badRequest('Campos de atualização inválidos.');
  if (typeof body.texto !== 'string' || !body.texto.trim() || body.texto.length > 10000) throw ApiError.badRequest('Texto obrigatório, até 10.000 caracteres.');
  if (!['UPDATE', 'COMMENT', 'BLOCK', 'UNBLOCK'].includes(body.tipo) || !['PUBLIC', 'INTERNAL'].includes(body.visibilidade)) throw ApiError.badRequest('Tipo ou visibilidade inválida.');
  return { texto: body.texto.trim(), tipo: body.tipo, visibilidade: body.visibilidade };
}
