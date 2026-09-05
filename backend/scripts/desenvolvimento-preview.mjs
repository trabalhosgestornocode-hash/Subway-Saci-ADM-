// Preview manual isolado. Fixtures em memória; sem autenticação ou banco de produção.
// node backend/scripts/desenvolvimento-preview.mjs -> http://127.0.0.1:55470
//
// Serve para validar o fluxo completo do responsável sem tocar em nenhum banco:
// abrir DEV-001, editar o responsável, salvar, conferir card, detalhes e histórico.
// Abra `/?papel=gestor` para ver a tela de um usuário do Painel Administrativo
// (edita tudo, mas sem exclusão, sem nota interna e sem atualização interna) e
// `/` para a visão do SuperAdmin. PREVIEW_PAPEL define o padrão.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=new URL('../../frontend/',import.meta.url);
const padraoSuperadmin=process.env.PREVIEW_PAPEL!=='gestor';
const paginaDe=superadmin=>`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agenda — validação local</title><link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/desenvolvimento.css"><body><main id="preview" style="padding:24px;max-width:1500px;margin:auto"></main><script type="module">
import {renderDesenvolvimento} from '/src/desenvolvimento.js';
const SUPERADMIN=${superadmin};
const status={BACKLOG:'Backlog',PLANNED:'Planejada',IN_PROGRESS:'Em desenvolvimento',VALIDATION:'Em validação',BLOCKED:'Bloqueada',COMPLETED:'Concluída',ARCHIVED:'Arquivada'};
// Pessoas com acesso ao Painel Administrativo — a mesma forma que /catalogos devolve.
const pessoas=[{id:'u-joao',nome:'João Pedro',email:'joao@crescer.test',superadmin:true},{id:'u-maria',nome:'Maria Silva',email:'maria@crescer.test',superadmin:false},{id:'u-ana',nome:'Ana Souza',email:'ana@crescer.test',superadmin:false}];
const eu=pessoas[0];
const nomeDe=id=>pessoas.find(p=>p.id===id)?.nome||'Sem responsável';
const titulos=['Integração Whatsapp API','Integração IFOOD','Integração financeira iFood','Bonificação mensal','Evolução do Agente Crescer','Indicadores de novos clientes'];
const rows=Object.keys(status).slice(0,6).map((s,i)=>({id:String(i+1),codigo:'DEV-00'+(i+1),titulo:titulos[i],categoria:'Integrações',tipo:'Feature',status:s,prioridade:i<3?'HIGH':'MEDIUM',progresso:i===5?100:35+i*10,versao:1,escopo:'PLATFORM',inicio_previsto:'2026-09-01',previsao_entrega:'2026-09-15',conclusao_real:i===5?'2026-09-04':null,descricao:'Estamos evoluindo os controles para dar mais clareza e segurança ao acompanhamento das operações.',atualizacao_publica:'Validação dos cenários com a equipe em andamento.',proximo_passo:'Concluir os testes e disponibilizar para validação.',bloqueio:s==='BLOCKED'?'Aguardando retorno da integração.':'',foco_atual:i===2,indicador_prazo:i===5?'Concluída':'No prazo',
  // DEV-001 e DEV-002 nascem SEM responsável — é justamente o que se vai definir.
  responsavel_usuario_id:i<2?null:'u-maria',criado_por:'u-joao',atualizado_por:'u-joao',created_at:'2026-09-01T12:00:00Z',updated_at:'2026-09-04T18:00:00Z'}));
const nomear=d=>({...d,responsavel_nome:nomeDe(d.responsavel_usuario_id),criado_por_nome:nomeDe(d.criado_por),atualizado_por_nome:nomeDe(d.atualizado_por)});
const recent=[{id:'a',demanda_id:'3',demanda:rows[2],texto:'Progresso avançou para 55%.',tipo:'PROGRESS',visibilidade:'PUBLIC',autor:'u-joao',autor_nome:'João Pedro',created_at:'2026-09-04T21:00:00Z'}];
const historico={};
const api={async desenvolvimento(path,q={}){
  if(path==='/catalogos')return{status,prioridades:{CRITICAL:'Crítica',HIGH:'Alta',MEDIUM:'Média',LOW:'Baixa'},categorias:['Integrações','Financeiro','Outros'],tipos:['Feature','Melhoria'],organizacoes:[],unidades:[],responsaveis:pessoas,usuario_atual:{id:eu.id,nome:eu.nome,pode_ser_responsavel:true},pode_editar:true,pode_administrar:SUPERADMIN};
  if(path==='/resumo')return{andamento:1,planejadas:1,validacao:1,bloqueadas:1,entregues_mes:1,minhas:rows.filter(x=>x.responsavel_usuario_id===eu.id).length,foco:nomear(rows.find(x=>x.foco_atual)),proximas:rows.filter(x=>x.status==='PLANNED').map(nomear),proxima_entrega:rows[2],recentes:recent,pode_editar:true,pode_administrar:SUPERADMIN};
  if(path==='/atualizacoes'){const itens=q.demanda_id?(historico[q.demanda_id]||[]):recent;return{itens,total:itens.length};}
  if(path==='/demandas'){let itens=rows.filter(x=>(!q.status||x.status===q.status)&&(!q.busca||x.titulo.includes(q.busca))&&(!q.responsavel_usuario_id||x.responsavel_usuario_id===q.responsavel_usuario_id)&&(!q.minhas||x.responsavel_usuario_id===eu.id)&&(!q.sem_responsavel||!x.responsavel_usuario_id));return{itens:itens.map(nomear),total:itens.length};}
  return{...nomear(rows.find(x=>path.endsWith('/'+x.id))),pode_editar:true,pode_administrar:SUPERADMIN};},
 async salvarDemanda(id,data){
   if(id){const alvo=rows.find(x=>x.id===id);const antes=alvo.responsavel_usuario_id;Object.assign(alvo,data,{versao:alvo.versao+1,atualizado_por:eu.id});
     if(antes!==alvo.responsavel_usuario_id){const ev={id:'h'+Date.now(),demanda_id:id,texto:'Responsável alterado de '+(antes?nomeDe(antes):'sem responsável')+' para '+(alvo.responsavel_usuario_id?nomeDe(alvo.responsavel_usuario_id):'sem responsável')+'.',tipo:'ASSIGN',visibilidade:'PUBLIC',autor:eu.id,autor_nome:eu.nome,created_at:new Date().toISOString()};(historico[id]??=[]).unshift(ev);recent.unshift({...ev,demanda:alvo});}
   } else rows.push({...data,id:'7',codigo:'DEV-007',versao:1,criado_por:eu.id,atualizado_por:eu.id,created_at:new Date().toISOString()});},
 async excluirDemanda(id){rows.splice(rows.findIndex(x=>x.id===id),1);},
 async atualizarDemanda(id,d){const ev={...d,id:'b'+Date.now(),demanda_id:id,autor:eu.id,autor_nome:eu.nome,created_at:new Date().toISOString()};(historico[id]??=[]).unshift(ev);recent.unshift(ev);}};
renderDesenvolvimento(document.querySelector('#preview'),api);
</script></body></html>`;
http.createServer(async(req,res)=>{try{const alvo=new URL(req.url,'http://localhost');if(alvo.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(paginaDe(alvo.searchParams.has('papel')?alvo.searchParams.get('papel')!=='gestor':padraoSuperadmin));return;}const path=alvo.pathname;if(!/^\/src\/[a-zA-Z0-9.-]+\.(js|css)$/.test(path)){res.writeHead(404).end();return;}const url=new URL('.'+path,root);res.setHeader('Content-Type',path.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(fileURLToPath(url)));}catch{res.writeHead(404).end();}}).listen(55470,'127.0.0.1',()=>console.log('Preview: http://127.0.0.1:55470 (padrão '+(padraoSuperadmin?'superadmin':'gestor')+'; troque com ?papel=gestor / ?papel=superadmin)'));
