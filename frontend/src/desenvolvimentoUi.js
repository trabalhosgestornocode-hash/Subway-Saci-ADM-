import { escapeHtml as e } from './utils.js';
export const STATUS = { BACKLOG:'Backlog', PLANNED:'Planejada', IN_PROGRESS:'Em desenvolvimento', VALIDATION:'Em validação', BLOCKED:'Bloqueada', COMPLETED:'Concluída', ARCHIVED:'Arquivada' };
export const PRIORIDADES = { CRITICAL:'Crítica', HIGH:'Alta', MEDIUM:'Média', LOW:'Baixa' };
export const data = v => v ? e(v.slice(0,10).split('-').reverse().join('/')) : 'Sem previsão';
export const vazio = texto => `<div class="dev-empty">${e(texto)}</div>`;
export const opcoes = (values, selected = '', placeholder = 'Todos') => `<option value="">${e(placeholder)}</option>` + (Array.isArray(values) ? values.map(v=>[v,v]) : Object.entries(values)).map(([v,label])=>`<option value="${e(v)}" ${v===selected?'selected':''}>${e(label)}</option>`).join('');
/** Nome humano do responsável. O UUID nunca chega à interface. */
export const responsavel = d => d.responsavel_nome || (d.responsavel_usuario_id ? 'Responsável definido' : 'Sem responsável');

/** `podeEditar` libera os controles rápidos — vale para todo o Painel Administrativo. */
export function card(d, podeEditar = false) {
  return `<article class="dev-card"><div class="dev-card-top"><span>${e(d.codigo)}</span><span class="dev-badge dev-priority-${e(d.prioridade)}">${e(PRIORIDADES[d.prioridade])}</span></div>
    <button class="dev-title" data-dev-open="${e(d.id)}">${e(d.titulo)}</button><p class="dev-muted">${e(d.categoria)} · ${e(STATUS[d.status])}</p>
    <p class="dev-owner"><span class="dev-owner-label">Responsável</span> <strong>${e(responsavel(d))}</strong></p>
    <div class="dev-progress"><progress max="100" value="${Number(d.progresso)||0}" aria-label="Progresso de ${e(d.codigo)}"></progress><span>${Number(d.progresso)||0}%</span></div>
    <div class="dev-card-bottom"><span>Previsão atual: ${data(d.previsao_entrega)}</span><span class="dev-badge">${e(d.indicador_prazo)}</span></div>
    ${podeEditar ? `<label class="dev-move">Mover para<select data-dev-move="${e(d.id)}" aria-label="Mover ${e(d.codigo)}">${opcoes(STATUS,d.status,'Selecionar')}</select></label>` : ''}</article>`;
}
export function resumoCards(r) {
  return `<div class="dev-metrics">${[['Em andamento',r.andamento],['Planejadas',r.planejadas],['Em validação',r.validacao],['Bloqueadas',r.bloqueadas],['Entregues no mês',r.entregues_mes],['Minhas demandas',r.minhas],['Próxima previsão',r.proxima_entrega ? data(r.proxima_entrega.previsao_entrega) : 'Sem previsão']].map(([k,v])=>`<div class="dev-metric"><span>${k}</span><strong>${v ?? '—'}</strong></div>`).join('')}</div>`;
}
export function historico(itens) {
  return itens.length ? `<ol class="dev-timeline">${itens.map(a=>`<li><time>${data(a.created_at)} ${e(new Date(a.created_at).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'}))}</time><span class="dev-badge">${a.visibilidade==='INTERNAL'?'Interna':'Pública'}</span>${a.demanda ? `<button class="dev-link" data-dev-open="${e(a.demanda_id)}">${e(a.demanda.codigo)} — ${e(a.demanda.titulo)}</button>`:''}<p class="dev-text">${e(a.texto)}</p><small class="dev-muted">Autor: ${e(a.autor_nome || 'Sistema')}</small></li>`).join('')}</ol>` : vazio('Ainda não há atualizações.');
}
export function overview(r) {
  const f = r.foco;
  return resumoCards(r) + `<div class="dev-overview"><section class="dev-focus"><span class="dev-eyebrow">FOCO ATUAL</span><h2>Em que estamos trabalhando agora</h2>${f ? card(f) + `<p class="dev-text">${e(f.atualizacao_publica || f.descricao)}</p><dl class="dev-facts"><dt>Responsável</dt><dd>${e(responsavel(f))}</dd><dt>Início</dt><dd>${data(f.inicio_real || f.inicio_previsto)}</dd><dt>Próximo passo</dt><dd>${e(f.proximo_passo || 'A definir')}</dd><dt>Bloqueio</dt><dd>${e(f.bloqueio || 'Nenhum informado')}</dd><dt>Dependência</dt><dd>${f.dependencia_id ? `<button class="dev-link" data-dev-open="${e(f.dependencia_id)}">Abrir demanda relacionada</button>` : 'Nenhuma'}</dd></dl>` : vazio('Nenhum foco definido. As prioridades continuam disponíveis no board.')}</section>
  <section class="dev-panel"><h2>Próximas demandas</h2>${r.proximas.length ? r.proximas.map(x=>card(x)).join('') : vazio('Nenhuma demanda planejada.')}</section></div><section class="dev-panel"><h2>Atualizações recentes</h2>${historico(r.recentes)}</section>`;
}
export function board(itens, podeEditar) { return `<div class="dev-board">${Object.entries(STATUS).filter(([k])=>k!=='ARCHIVED').map(([k,label])=>`<section class="dev-column"><h3>${label} <span>${itens.filter(x=>x.status===k).length}</span></h3>${itens.filter(x=>x.status===k).map(d=>card(d,podeEditar)).join('') || vazio('Nenhuma demanda nesta página.')}</section>`).join('')}</div>`; }
export function eventos(itens) { return itens.flatMap(d=>[['inicio_previsto','Início previsto'],['previsao_entrega','Previsão atual'],['conclusao_real','Conclusão']].filter(([k])=>d[k]).map(([k,label])=>({ dia:d[k], label, demanda:d }))).sort((a,b)=>a.dia.localeCompare(b.dia)); }
export function agenda(itens, modo, referencia) {
  const ev = eventos(itens);
  const item = x => `<button class="dev-event" data-dev-open="${e(x.demanda.id)}"><small>${e(x.label)}</small><b>${e(x.demanda.codigo)}</b> ${e(x.demanda.titulo)}</button>`;
  if (modo==='lista') return ev.length ? `<div class="dev-panel">${ev.map(x=>`<div class="dev-day-list"><time>${data(x.dia)}</time>${item(x)}</div>`).join('')}</div>` : vazio('Nenhum marco datado nesta página.');
  const ref = new Date(referencia+'T12:00:00Z'); const start = new Date(ref);
  if (modo==='mes') start.setUTCDate(1);
  start.setUTCDate(start.getUTCDate()-((start.getUTCDay()+6)%7));
  const n = modo==='mes' ? 42 : 7;
  return `<div class="dev-calendar ${modo==='semana'?'dev-week':''}">${Array.from({length:n},(_,i)=>{const dt=new Date(start);dt.setUTCDate(start.getUTCDate()+i);const dia=dt.toISOString().slice(0,10);return `<section class="dev-day"><time>${data(dia)}</time>${ev.filter(x=>x.dia===dia).map(item).join('')}</section>`;}).join('')}</div>`;
}
export function roadmap(itens) {
  const grupos = new Map();
  for (const d of itens) { const k=(d.previsao_entrega || d.inicio_previsto || '').slice(0,7) || 'Sem previsão'; if (!grupos.has(k)) grupos.set(k,[]); grupos.get(k).push(d); }
  return [...grupos].sort(([a],[b])=>a.localeCompare(b)).map(([mes,ds])=>`<section class="dev-panel"><h2>${e(mes==='Sem previsão'?mes:new Date(mes+'-01T12:00:00Z').toLocaleDateString('pt-BR',{month:'long',year:'numeric'}))}</h2><div class="dev-grid">${ds.map(x=>card(x)).join('')}</div></section>`).join('') || vazio('Nenhuma demanda neste período.');
}
