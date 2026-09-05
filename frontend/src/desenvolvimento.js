import { escapeHtml as e } from './utils.js';
import * as ui from './desenvolvimentoUi.js';

export async function montarCardDesenvolvimento(root, api, abrir) {
  if (!api.desenvolvimento) return;
  const node = document.createElement('section'); node.className='dev-panel'; root.prepend(node);
  node.innerHTML='<h2>Desenvolvimento da Plataforma</h2><p>Carregando agenda…</p>';
  try {
    const r = await api.desenvolvimento('/resumo');
    if (!node.isConnected) return;
    node.innerHTML=`<div class="dev-heading"><div><h2>Desenvolvimento da Plataforma</h2><p>${r.andamento} em andamento · ${r.entregues_mes} entregas neste mês · Próxima previsão: ${ui.data(r.proxima_entrega?.previsao_entrega)}</p><p class="dev-muted">Foco atual: ${e(r.foco?.titulo || 'A definir')}</p></div><button class="btn" data-dev-dashboard>Ver agenda de desenvolvimento</button></div>`;
    node.querySelector('button').onclick=abrir;
  } catch { node.innerHTML='<h2>Desenvolvimento da Plataforma</h2><p>Agenda temporariamente indisponível.</p><button class="btn">Ver agenda de desenvolvimento</button>'; node.querySelector('button').onclick=abrir; }
}

export async function renderDesenvolvimento(root, api, acessoRevogado) {
  // Estado pertence a esta montagem; respostas antigas nunca sobrescrevem outra tela.
  const host=document.createElement('div');host.className='dev-shell';root.replaceChildren(host);
  let aba='geral', pagina=1, filtros={}, catalogo, itens=[], resumo, seq=0, modo='mes', referencia=new Date().toLocaleDateString('en-CA');
  const vivo=()=>root.contains(host);
  const erro=err=>{ if (err.status===403) acessoRevogado?.(err.message); return `<div role="alert" class="dev-error">${e(err.message)}</div>`; };
  const requisicao=(rota,q)=>api.desenvolvimento(rota,q);
  const podeEditar=()=>!!catalogo?.pode_editar, podeAdministrar=()=>!!catalogo?.pode_administrar;
  const eu=()=>catalogo?.usuario_atual;
  const responsaveis=()=>Object.fromEntries((catalogo?.responsaveis||[]).map(x=>[x.id,x.nome]));
  function nomes(d) { return d.escopo==='PLATFORM' ? 'Plataforma inteira' : [catalogo.organizacoes.find(x=>x.id===d.organizacao_id)?.nome, catalogo.unidades.find(x=>x.id===d.unidade_id)?.nome].filter(Boolean).join(' / '); }
  function filtrosHtml() {
    const selects=[['status','Status',catalogo.status],['prioridade','Prioridade',catalogo.prioridades],['categoria','Categoria',catalogo.categorias],['tipo','Tipo',catalogo.tipos],['organizacao_id','Organização',Object.fromEntries(catalogo.organizacoes.map(x=>[x.id,x.nome]))],['unidade_id','Unidade',Object.fromEntries(catalogo.unidades.filter(x=>!filtros.organizacao_id||x.organizacao_id===filtros.organizacao_id).map(x=>[x.id,x.nome]))],['responsavel_usuario_id','Responsável',responsaveis()]];
    return `<details class="dev-filter-disclosure"><summary>Pesquisa e filtros${Object.keys(filtros).length ? " · ativos" : ""}</summary><form class="dev-filters"><label>Pesquisar<input name="busca" value="${e(filtros.busca||'')}" placeholder="Código, título ou descrição" maxlength="180"></label>${selects.map(([k,label,vs])=>`<label>${label}<select name="${k}">${ui.opcoes(vs,filtros[k])}</select></label>`).join('')}<label>Data de<select name="campo_periodo">${ui.opcoes({previsao_entrega:'Previsão de entrega',inicio_previsto:'Início previsto',conclusao_real:'Conclusão'},filtros.campo_periodo||'previsao_entrega','Escolher')}</select></label><label>De<input type="date" name="de" value="${e(filtros.de||'')}"></label><label>Até<input type="date" name="ate" value="${e(filtros.ate||'')}"></label><label class="dev-check"><input type="checkbox" name="atrasadas" ${filtros.atrasadas?'checked':''}> Atrasadas</label><label class="dev-check"><input type="checkbox" name="sem_responsavel" ${filtros.sem_responsavel?'checked':''}> Sem responsável</label><button class="btn" type="submit">Aplicar filtros</button><button class="btn" type="button" data-dev-clear>Limpar</button></form></details>`;
  }
  function shell(conteudo,total=0) {
    host.innerHTML=`<header class="dev-heading"><div><span class="dev-eyebrow">DESENVOLVIMENTO</span><h1>Agenda de Demandas</h1><p class="dev-muted">Prioridades, evolução e entregas da plataforma. As previsões podem ser atualizadas.</p></div><div class="dev-header-actions">${aba==='geral'?'':`<button class="btn ${filtros.minhas?'btn-primary':''}" data-dev-mine aria-pressed="${filtros.minhas?'true':'false'}">Minhas demandas</button>`}${podeEditar()?'<button class="btn btn-primary" data-dev-new>Nova demanda</button>':'<span class="dev-badge">Somente leitura</span>'}</div></header><nav class="dev-tabs" aria-label="Visualizações da agenda">${Object.entries({geral:'Visão Geral',board:'Board',agenda:'Agenda',roadmap:'Roadmap',historico:'Histórico'}).map(([k,label])=>`<button class="${aba===k?'active':''}" data-dev-tab="${k}" aria-current="${aba===k?'page':'false'}">${label}</button>`).join('')}</nav>${aba==='geral'?'':filtrosHtml()}<div class="dev-content">${conteudo}</div>${aba==='geral'?'':`<footer class="dev-pagination"><button class="btn" data-dev-page="-1" ${pagina===1?'disabled':''}>Anterior</button><span>Página ${pagina} · ${total} demandas · até 60 por página</span><button class="btn" data-dev-page="1" ${pagina*60>=total?'disabled':''}>Próxima</button></footer>`}`;
    host.querySelectorAll('[data-dev-tab]').forEach(b=>b.onclick=()=>{aba=b.dataset.devTab;pagina=1;filtros={};if(aba==='historico') filtros={status:'COMPLETED',campo_periodo:'conclusao_real'};carregar();});
    host.querySelector('[data-dev-new]')?.addEventListener('click',()=>editar());
    // "Minhas demandas" resolve pelo servidor a partir da sessão: o cliente
    // manda apenas o sinalizador, nunca um id de usuário escolhido aqui.
    host.querySelector('[data-dev-mine]')?.addEventListener('click',()=>{if(filtros.minhas)delete filtros.minhas;else{filtros.minhas='true';delete filtros.responsavel_usuario_id;delete filtros.sem_responsavel;}pagina=1;carregar();});
    host.querySelector('[data-dev-clear]')?.addEventListener('click',()=>{filtros=aba==='historico'?{status:'COMPLETED',campo_periodo:'conclusao_real'}:{};pagina=1;carregar();});
    host.querySelector('.dev-filters')?.addEventListener('submit',ev=>{ev.preventDefault();filtros=Object.fromEntries([...new FormData(ev.currentTarget)].filter(([,v])=>v));for(const k of ['atrasadas','sem_responsavel']) if(filtros[k]) filtros[k]='true';pagina=1;carregar();});
    const org=host.querySelector('.dev-filters [name=organizacao_id]');
    if(org)org.onchange=()=>{host.querySelector('.dev-filters [name=unidade_id]').innerHTML=ui.opcoes(Object.fromEntries(catalogo.unidades.filter(x=>!org.value||x.organizacao_id===org.value).map(x=>[x.id,x.nome])));};
    host.querySelectorAll('[data-dev-page]').forEach(b=>b.onclick=()=>{pagina+=Number(b.dataset.devPage);carregar();});
    ligarDetalhes(host);
    host.querySelectorAll('[data-dev-move]').forEach(s=>s.onchange=async()=>{const d=itens.find(x=>x.id===s.dataset.devMove);const status=s.value;if(!status)return; if(status==='BLOCKED'&&!d.bloqueio){editar({...d,status});return;} s.disabled=true;try{await api.salvarDemanda(d.id,{status,versao:d.versao});await carregar();}catch(err){s.value=d.status;s.disabled=false;mensagem(err);}});
  }
  function mensagem(err){const n=document.createElement('div');n.innerHTML=erro(err);host.prepend(n);}
  function ligarDetalhes(container){container.querySelectorAll('[data-dev-open]').forEach(b=>b.onclick=()=>detalhe(b.dataset.devOpen));}
  async function carregar() {
    const ticket=++seq;
    if(!catalogo)host.innerHTML='<p role="status">Carregando agenda…</p>';
    else host.setAttribute('aria-busy','true');
    try{
      catalogo ||= await requisicao('/catalogos');
      if(aba==='geral'){
        resumo=await requisicao('/resumo');if(!vivo()||ticket!==seq)return;shell(ui.overview(resumo));
      }else{
        const consulta={...filtros,pagina,limite:60};
        if(aba==='agenda' && modo!=='lista'){
          const inicio=new Date(referencia+'T12:00:00Z');
          if(modo==='mes')inicio.setUTCDate(1);
          inicio.setUTCDate(inicio.getUTCDate()-((inicio.getUTCDay()+6)%7));
          const fim=new Date(inicio);fim.setUTCDate(fim.getUTCDate()+(modo==='mes'?41:6));
          Object.assign(consulta,{campo_periodo:'marcos',de:inicio.toISOString().slice(0,10),ate:fim.toISOString().slice(0,10)});
        }
        const r=await requisicao('/demandas',consulta);if(!vivo()||ticket!==seq)return;itens=r.itens;
        let html;
        if(aba==='board')html=filtros.status==='ARCHIVED'?`<div class="dev-grid">${itens.map(d=>ui.card(d,podeEditar())).join('')}</div>`:ui.board(itens,podeEditar());
        else if(aba==='roadmap')html=ui.roadmap(itens);
        else if(aba==='historico')html=itens.map(d=>`<section class="dev-panel">${ui.card(d)}<p>Concluída em ${ui.data(d.conclusao_real)} · ${e(nomes(d))}</p><h3>O que foi entregue</h3><p class="dev-text">${e(d.resumo_entrega||d.atualizacao_publica||'Resumo ainda não informado.')}</p><h3>Impacto</h3><p class="dev-text">${e(d.impacto||'Não informado.')}</p></section>`).join('')||ui.vazio('Nenhuma entrega encontrada.');
        else html=`<div class="dev-calendar-controls"><label>Visualização<select data-dev-mode>${ui.opcoes({mes:'Mês',semana:'Semana',lista:'Lista cronológica'},modo,'Escolher')}</select></label><button class="btn" data-dev-date-step="-1" aria-label="Período anterior">‹</button><label>Data de referência<input type="date" data-dev-date value="${referencia}"></label><button class="btn" data-dev-date-step="1" aria-label="Próximo período">›</button></div><p class="dev-muted">Marcos das demandas desta página: início previsto, previsão atual e conclusão.</p><div data-dev-calendar>${ui.agenda(itens,modo,referencia)}</div>`;
        shell(html,r.total);
        if(aba==='agenda'){
          host.querySelector('[data-dev-mode]').onchange=ev=>{modo=ev.target.value||'mes';pagina=1;carregar();};
          host.querySelector('[data-dev-date]').onchange=ev=>{if(ev.target.value){referencia=ev.target.value;pagina=1;carregar();}};
          host.querySelectorAll('[data-dev-date-step]').forEach(b=>b.onclick=()=>{const dt=new Date(referencia+'T12:00:00Z');if(modo==='mes'){dt.setUTCDate(1);dt.setUTCMonth(dt.getUTCMonth()+Number(b.dataset.devDateStep));}else dt.setUTCDate(dt.getUTCDate()+7*Number(b.dataset.devDateStep));referencia=dt.toISOString().slice(0,10);pagina=1;carregar();});
        }
      }
    }catch(err){if(vivo()&&ticket===seq){host.innerHTML=erro(err)+'<button class="btn" data-dev-retry>Tentar novamente</button>';host.querySelector('button').onclick=carregar;}}
    finally{host.removeAttribute('aria-busy');}
  }
  function modal(titulo,html){
    const dialog=document.createElement('dialog');dialog.className='dev-dialog';dialog.innerHTML=`<header class="dev-heading"><h2>${e(titulo)}</h2><button class="btn" data-dev-close aria-label="Fechar">×</button></header><div data-dev-modal-error role="alert"></div>${html}`;
    host.append(dialog);dialog.querySelector('[data-dev-close]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();return dialog;
  }
  async function detalhe(id){
    const dialog=modal('Detalhes da demanda','<p role="status">Carregando…</p>');
    try{
      const [d,h]=await Promise.all([requisicao('/demandas/'+encodeURIComponent(id)),requisicao('/atualizacoes',{demanda_id:id,limite:30})]);if(!dialog.isConnected)return;
      dialog.close();
      const campos=[['Descrição',d.descricao],['Objetivo',d.objetivo],['Impacto',d.impacto],['Resumo da entrega',d.resumo_entrega],['Próximo passo',d.proximo_passo],['Bloqueio',d.bloqueio],['Atualização pública',d.atualizacao_publica]];
      const n=modal(d.codigo+' — '+d.titulo,`${ui.card(d)}<section class="dev-panel"><h3>Sobre e execução</h3>${campos.map(([k,v])=>`<h4>${k}</h4><p class="dev-text">${e(v||'Não informado.')}</p>`).join('')}<dl class="dev-facts"><dt>Responsável</dt><dd>${e(ui.responsavel(d))}</dd><dt>Criado por</dt><dd>${e(d.criado_por_nome||'Sistema')}</dd><dt>Criado em</dt><dd>${ui.data(d.created_at)}</dd><dt>Última atualização por</dt><dd>${e(d.atualizado_por_nome||'Sistema')}</dd><dt>Escopo</dt><dd>${e(nomes(d))}</dd><dt>Início previsto</dt><dd>${ui.data(d.inicio_previsto)}</dd><dt>Início real</dt><dd>${ui.data(d.inicio_real)}</dd><dt>Conclusão</dt><dd>${ui.data(d.conclusao_real)}</dd><dt>Última atualização</dt><dd>${ui.data(d.updated_at)}</dd><dt>Dependência</dt><dd>${d.dependencia_id?`<button class="dev-link" data-dev-related>Ver demanda relacionada</button>`:'Nenhuma'}</dd></dl></section>${d.pode_administrar?`<section class="dev-panel"><h3>Informações técnicas · internas</h3><p class="dev-text">${e(d.nota_interna||'Nenhuma nota interna.')}</p>${/^https?:\/\//i.test(d.link_tecnico||'')?`<a href="${e(d.link_tecnico)}" target="_blank" rel="noopener noreferrer">Abrir link técnico</a>`:''}</section>`:''}${d.pode_editar?`<section class="dev-panel"><h3>Ações</h3><div class="dev-actions"><button class="btn" data-dev-edit>Editar demanda</button><button class="btn" data-dev-focus>${d.foco_atual?'Remover foco':'Definir como foco atual'}</button>${d.pode_administrar?'<button class="btn" data-dev-delete>Excluir demanda</button>':''}</div>${d.pode_administrar?'':'<p class="dev-muted">A exclusão definitiva é do SuperAdmin. Para tirar a demanda das visualizações ativas, mude o status para Arquivada.</p>'}</section>`:''}<section class="dev-panel"><h3>Atualizações</h3><div data-dev-history>${ui.historico(h.itens)}</div><button class="btn" data-dev-more ${h.total<=30?'hidden':''}>Carregar mais</button>${d.pode_editar?`<form data-dev-update><label>Nova atualização<textarea name="texto" required maxlength="10000"></textarea></label><label>Tipo<select name="tipo"><option value="UPDATE">Atualização</option><option value="COMMENT">Comentário</option><option value="BLOCK">Bloqueio</option><option value="UNBLOCK">Desbloqueio</option></select></label>${d.pode_administrar?'<label>Visibilidade<select name="visibilidade"><option value="PUBLIC">Pública — gestores podem ler</option><option value="INTERNAL">Interna — apenas SuperAdmin</option></select></label>':'<input type="hidden" name="visibilidade" value="PUBLIC">'}<button class="btn btn-primary">Publicar atualização</button></form>`:''}</section>`);
      const falha=err=>n.querySelector('[data-dev-modal-error]').innerHTML=erro(err);
      n.querySelector('[data-dev-related]')?.addEventListener('click',()=>{n.close();detalhe(d.dependencia_id);});
      n.querySelector('[data-dev-edit]')?.addEventListener('click',()=>{n.close();editar(d);});
      n.querySelector('[data-dev-focus]')?.addEventListener('click',async ev=>{ev.target.disabled=true;try{await api.salvarDemanda(id,{foco_atual:!d.foco_atual,versao:d.versao});n.close();await carregar();}catch(err){falha(err);ev.target.disabled=false;}});
      n.querySelector('[data-dev-delete]')?.addEventListener('click',()=>{const c=modal('Excluir '+d.codigo,`<p>Excluir esta demanda e seu histórico? A auditoria será preservada e o código não será reutilizado.</p><button class="btn" data-dev-confirm>Excluir definitivamente</button>`);c.querySelector('[data-dev-confirm]').onclick=async ev=>{ev.target.disabled=true;try{await api.excluirDemanda(id,d.versao);c.close();n.close();await carregar();}catch(err){c.querySelector('[data-dev-modal-error]').innerHTML=erro(err);ev.target.disabled=false;}};});
      let hp=1;
      n.querySelector('[data-dev-more]').onclick=async ev=>{ev.target.disabled=true;try{const r=await requisicao('/atualizacoes',{demanda_id:id,pagina:hp+1,limite:30});hp++;n.querySelector('[data-dev-history]').insertAdjacentHTML('beforeend',ui.historico(r.itens));ev.target.hidden=hp*30>=r.total;}catch(err){falha(err);}finally{ev.target.disabled=false;}};
      n.querySelector('[data-dev-update]')?.addEventListener('submit',async ev=>{ev.preventDefault();const btn=ev.currentTarget.querySelector('button');btn.disabled=true;try{await api.atualizarDemanda(id,Object.fromEntries(new FormData(ev.currentTarget)));n.close();await carregar();await detalhe(id);}catch(err){falha(err);btn.disabled=false;}});
    }catch(err){if(dialog.isConnected)dialog.querySelector('[data-dev-modal-error]').innerHTML=erro(err);}
  }
  function editar(d={}){
    // Campos técnicos nem são renderizados fora do SuperAdmin — e, por não
    // existirem no formulário, também não entram no corpo enviado à API.
    const tecnicos=podeAdministrar();
    // Novo registro já nasce no nome de quem está criando, quando essa pessoa
    // pode ser responsável. O criador em si vem da sessão, no servidor.
    const padraoResponsavel=d.id?'':(eu()?.pode_ser_responsavel?eu().id:'');
    const texto=(k,label,multi=false)=>`<label class="${multi?'dev-span':''}">${label}${multi?`<textarea name="${k}" maxlength="${k==='nota_interna'||k==='descricao'?10000:5000}">${e(d[k]||'')}</textarea>`:`<input name="${k}" value="${e(d[k]||'')}" ${k==='titulo'?'required maxlength="180"':''}>`}</label>`;
    const select=(k,label,vals,def)=>`<label>${label}<select name="${k}">${ui.opcoes(vals,d[k]||def,'Selecionar')}</select></label>`;
    const n=modal(d.id?'Editar '+d.codigo:'Nova demanda',`<form data-dev-form><div class="dev-form-grid">${texto('titulo','Título')}${select('categoria','Categoria',catalogo.categorias,'Outros')}${select('tipo','Tipo',catalogo.tipos,'Feature')}${select('prioridade','Prioridade',catalogo.prioridades,'MEDIUM')}${select('status','Status',catalogo.status,'BACKLOG')}${select('escopo','Escopo',{PLATFORM:'Plataforma inteira',ORGANIZATION:'Organização específica',UNIT:'Unidade específica'},'PLATFORM')}<label>Responsável pela demanda<select name="responsavel_usuario_id">${ui.opcoes(responsaveis(),d.responsavel_usuario_id||padraoResponsavel,'Sem responsável')}</select><small class="dev-muted">Apenas usuários com acesso ao Painel Administrativo.</small></label>${d.id?`<label>Criado por<input value="${e(d.criado_por_nome||'Sistema')}" readonly disabled></label><label>Criado em<input value="${ui.data(d.created_at)}" readonly disabled></label>`:''}${select('organizacao_id','Organização',Object.fromEntries(catalogo.organizacoes.map(x=>[x.id,x.nome])))}${select('unidade_id','Unidade',Object.fromEntries(catalogo.unidades.filter(x=>x.organizacao_id===d.organizacao_id).map(x=>[x.id,x.nome])))}<label>Progresso (%)<input name="progresso" type="number" min="0" max="100" required value="${d.progresso||0}"></label><label>Ordem dentro da prioridade<input name="ordem" type="number" min="0" max="2147483646" required value="${d.ordem||0}"></label>${[['inicio_previsto','Início previsto'],['inicio_real','Início real'],['previsao_entrega','Previsão atual'],['conclusao_real','Conclusão real']].map(([k,label])=>`<label>${label}<input type="date" name="${k}" value="${e(d[k]||'')}"></label>`).join('')}${[['descricao','Descrição'],['objetivo','Objetivo'],['impacto','Impacto'],['resumo_entrega','Resumo da entrega'],['proximo_passo','Próximo passo'],['bloqueio','Bloqueio atual'],['atualizacao_publica','Atualização pública'],...(tecnicos?[['nota_interna','Nota interna — apenas SuperAdmin']]:[])].map(([k,label])=>texto(k,label,true)).join('')}${tecnicos?texto('link_tecnico','Link técnico (HTTP/HTTPS)'):''}<div class="dev-span"><label>Pesquisar dependência<input data-dev-dependency-search placeholder="Código ou título"></label><button type="button" class="btn" data-dev-dependency-find>Pesquisar demandas</button><label>Demanda da qual depende<select name="dependencia_id"><option value="">Nenhuma</option>${d.dependencia_id?`<option value="${e(d.dependencia_id)}" selected>Dependência atual</option>`:''}</select></label></div><label class="dev-check"><input type="checkbox" name="foco_atual" ${d.foco_atual?'checked':''}> Foco atual (um por vez)</label></div><p class="dev-muted">Concluir ajusta o progresso para 100%. Para reabrir, selecione um status ativo. Arquivar remove a demanda das visualizações ativas.</p><button class="btn btn-primary" type="submit">Salvar demanda</button></form>`);
    const form=n.querySelector('form');const org=form.elements.organizacao_id;const unidade=form.elements.unidade_id;const escopo=form.elements.escopo;
    const ajustar=()=>{org.disabled=escopo.value==='PLATFORM';unidade.disabled=escopo.value!=='UNIT';if(org.disabled)org.value='';if(unidade.disabled)unidade.value='';};escopo.onchange=ajustar;ajustar();
    org.onchange=()=>{unidade.innerHTML=ui.opcoes(Object.fromEntries(catalogo.unidades.filter(x=>x.organizacao_id===org.value).map(x=>[x.id,x.nome])),null,'Selecionar');};
    n.querySelector('[data-dev-dependency-find]').onclick=async ev=>{ev.target.disabled=true;try{const r=await requisicao('/demandas',{busca:n.querySelector('[data-dev-dependency-search]').value,limite:100});form.elements.dependencia_id.innerHTML=ui.opcoes(Object.fromEntries(r.itens.filter(x=>x.id!==d.id).map(x=>[x.id,x.codigo+' — '+x.titulo])),d.dependencia_id,'Nenhuma');}catch(err){n.querySelector('[data-dev-modal-error]').innerHTML=erro(err);}finally{ev.target.disabled=false;}};
    form.onsubmit=async ev=>{ev.preventDefault();const btn=form.querySelector('[type=submit]');btn.disabled=true;const body=Object.fromEntries(new FormData(form));
      body.progresso=Number(body.progresso);body.ordem=Number(body.ordem);body.foco_atual=form.elements.foco_atual.checked;
      for(const k of ['organizacao_id','unidade_id','dependencia_id','responsavel_usuario_id','inicio_previsto','inicio_real','previsao_entrega','conclusao_real'])body[k] ||= null;
      if(d.id)body.versao=d.versao;
      try{await api.salvarDemanda(d.id,body);n.close();await carregar();}catch(err){n.querySelector('[data-dev-modal-error]').innerHTML=erro(err);btn.disabled=false;}
    };
  }
  await carregar();
}
