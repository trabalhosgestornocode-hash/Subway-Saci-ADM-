import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { administrativoRouter } from '../src/modules/administrativo/administrativo.routes.js';
import { requireAuth } from '../src/middlewares/auth.js';
import * as d from '../src/modules/desenvolvimento/desenvolvimento.domain.js';
import * as s from '../src/modules/desenvolvimento/desenvolvimento.service.js';
import * as repo from '../src/modules/desenvolvimento/desenvolvimento.repo.js';
const id='11111111-1111-4111-8111-111111111111';
const id2='22222222-2222-4222-8222-222222222222';
const idAdmin='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const idGestor='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const idForaDoPainel='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const admin={id:idAdmin,superadmin:true,nome:'Ana SuperAdmin'}, gestor={id:idGestor,painelAdministrativo:true,nome:'João Pedro'};
// Cadastro real que a agenda consulta: nomes vêm de `perfis`, elegibilidade de
// `painel_administrativo_usuarios` + `plataforma_admins`.
const cadastro={
  perfis:[{id:idAdmin,nome:'Ana SuperAdmin',email:'ana@crescer.test'},{id:idGestor,nome:'João Pedro',email:'joao@crescer.test'},{id:idForaDoPainel,nome:'Carlos Operador',email:'carlos@loja.test'}],
  painel_administrativo_usuarios:[{usuario_id:idGestor,ativo:true}],
  plataforma_admins:[{usuario_id:idAdmin,ativo:true}],
};

// Fake captura a projeção e os predicados reais usados pelo repo (não injeta services).
function fake(rows=[],extras={}) {
  extras={...cadastro,...extras};
  const calls=[];
  const db={calls,from(table){
    const c={table,where:[],select:'*',start:0,end:999};calls.push(c);
    let operacao, payload;
    const run=async single=>{
      let data=(table===repo.TABELA?rows:extras[table]||[]).filter(r=>c.where.every(([op,k,v])=>op==='eq'?r[k]===v:op==='neq'?r[k]!==v:op==='is'?(r[k]??null)===v:op==='gte'?r[k]>=v:op==='lte'?r[k]<=v:op==='lt'?r[k]<v:op==='in'?v.includes(r[k]):op==='not'?r[k]!==null:true));
      if(operacao==='insert'){data=[{id,versao:1,progresso:0, ...payload}];rows.push(...data);}
      if(operacao==='update')data.forEach(r=>Object.assign(r,payload,{versao:r.versao+1}));
      const count=data.length;
      data=data.slice(c.start,c.end+1).map(r=>Object.fromEntries(Object.entries(r).filter(([k])=>c.select==='*'||c.select.split(',').includes(k))));
      return {data:single?data[0]||null:data,count,error:null};
    };
    const b={select:(v)=>{c.select=v;return b;},order:()=>b,range:(a,z)=>{c.start=a;c.end=z;return b;},limit:n=>{c.end=n-1;return b;},or:v=>{c.or=v;return b;},insert:v=>{operacao='insert';payload=v;return b;},update:v=>{operacao='update';payload=v;return b;},maybeSingle:()=>run(true),single:()=>run(true),then:(a,z)=>run(false).then(a,z)};
    for(const op of ['eq','neq','is','gte','lte','lt','not','in'])b[op]=(k,v)=>{c.where.push([op,k,v]);return b;};
    return b;
  },rpc:async()=>({data:true,error:null})};return db;
}
const demanda=(over={})=>({id,codigo:'DEV-001',titulo:'Demanda',descricao:'Descrição',status:'PLANNED',prioridade:'HIGH',categoria:'Outros',tipo:'Feature',progresso:20,escopo:'PLATFORM',arquivada:false,versao:1,nota_interna:'SEGREDO',link_tecnico:'https://interno.example',conclusao_real:null,previsao_entrega:'2026-09-12',...over});
test('progresso: limites, tipos, campos desconhecidos e mass assignment',()=>{
  for(const progresso of [-1,101,1.5,'50',null])assert.throws(()=>d.validarDemanda({titulo:'X',progresso}),{statusCode:400});
  for(const k of ['id','criado_por','atualizado_por','codigo','arquivada','superadmin'])assert.throws(()=>d.validarDemanda({titulo:'X',[k]:true}),{statusCode:400});
  assert.equal(d.validarDemanda({titulo:'X',progresso:100}).progresso,100);
});
test('datas reais, link seguro e status bloqueado exigem entrada válida',()=>{
  for(const body of [{titulo:'X',previsao_entrega:'2026-02-30'},{titulo:'X',link_tecnico:'javascript:alert(1)'},{titulo:'X',status:'BLOCKED'},{titulo:'X',conclusao_real:'2026-09-01'}])assert.throws(()=>d.validarDemanda(body),{statusCode:400});
});
test('conclusão e reabertura normalizam progresso e conclusão',()=>{
  assert.equal(d.validarDemanda({titulo:'X',status:'COMPLETED',progresso:40}).progresso,100);
  const reaberta=d.validarDemanda({versao:1,status:'IN_PROGRESS'},demanda({status:'COMPLETED',progresso:100,conclusao_real:'2026-09-01'}));
  assert.equal(reaberta.progresso,0);assert.equal(reaberta.conclusao_real,null);
});
test('prazo usa datas civis: vencido, hoje, dois dias, futuro e encerramento',()=>{
  const hoje='2026-09-10';
  for(const [date,label] of [['2026-09-09','Atrasada'],['2026-09-10','Atenção'],['2026-09-12','Atenção'],['2026-09-13','No prazo'],[null,'Sem previsão']])assert.equal(d.prazo(demanda({previsao_entrega:date}),hoje),label);
  assert.equal(d.prazo(demanda({status:'COMPLETED'}),hoje),'Concluída');
  assert.equal(d.prazo(demanda({status:'ARCHIVED'}),hoje),'Arquivada');
});
test('escopo não concede acesso tenant e combinações inconsistentes são rejeitadas',()=>{
  assert.throws(()=>s.autorizar({id,papel:'organization_admin',tenant:{organizacaoId:id}}),{statusCode:403});
  for(const body of [{escopo:'UNIT',organizacao_id:id},{escopo:'PLATFORM',organizacao_id:id},{escopo:'ORGANIZATION',organizacao_id:id,unidade_id:id2}])assert.throws(()=>d.validarDemanda({titulo:'X',...body}),{statusCode:400});
});
test('organização inválida e unidade de outra organização são rejeitadas pelo service',async()=>{
  await assert.rejects(s.salvar(admin,null,{titulo:'X',escopo:'ORGANIZATION',organizacao_id:id},{supabase:fake()}),{statusCode:400});
  const db=fake([],{organizacoes:[{id}],unidades:[{id:id2,organizacao_id:id2}]});
  await assert.rejects(s.salvar(admin,null,{titulo:'X',escopo:'UNIT',organizacao_id:id,unidade_id:id2},{supabase:db}),{statusCode:400});
});
test('projeções públicas não solicitam notas técnicas em lista, detalhe ou resumo',async()=>{
  const db=fake([demanda({foco_atual:true})]);
  const a=await s.listar(gestor,{}, {supabase:db});const b=await s.obter(gestor,id,{supabase:db});const c=await s.resumo(gestor,{supabase:db});
  for(const r of [a,b,c])assert.ok(!JSON.stringify(r).includes('SEGREDO'));
  assert.ok(db.calls.filter(c=>c.table===repo.TABELA).every(c=>!c.select.includes('nota_interna')&&!c.select.includes('link_tecnico')));
  assert.equal((await s.obter(admin,id,{supabase:db})).nota_interna,'SEGREDO');
});
test('histórico público filtra INTERNAL no banco, admin recebe ambos',async()=>{
  const db=fake([demanda()],{desenvolvimento_demanda_atualizacoes:[{id,texto:'Público',visibilidade:'PUBLIC',demanda_id:id},{id:id2,texto:'SEGREDO',visibilidade:'INTERNAL',demanda_id:id}]});
  assert.equal((await s.atualizacoes(gestor,{demanda_id:id},{supabase:db})).itens.length,1);
  assert.equal((await s.atualizacoes(admin,{demanda_id:id},{supabase:db})).itens.length,2);
});
test('filtros e paginação são aplicados no banco e busca não injeta sintaxe PostgREST',async()=>{
  const db=fake([demanda(),demanda({id:id2,status:'BLOCKED'})]);
  const r=await s.listar(gestor,{status:'PLANNED',prioridade:'HIGH',organizacao_id:id,busca:'DEV-001),nota_interna.ilike.*',de:'2026-09-01',ate:'2026-09-30',pagina:2,limite:10},{supabase:db});
  assert.equal(r.itens.length,0);const call=db.calls[0];assert.equal(call.start,10);assert.ok(call.where.some(x=>x[1]==='organizacao_id'));assert.ok(!call.or.includes('),'));assert.ok(!call.or.includes('nota_interna.ilike.*'));
  for(const q of [{limite:101},{status:'fake'},{nota_interna:'x'},{de:'2026-09-30',ate:'2026-09-01'}])assert.throws(()=>s.filtros(q),{statusCode:400});
});
test('resumo conta todos os registros e entregas do mês no servidor',async()=>{
  const hoje=d.hojeBrasil();const db=fake([demanda({status:'IN_PROGRESS'}),demanda({id:id2,status:'COMPLETED',conclusao_real:hoje})]);
  const r=await s.resumo(gestor,{supabase:db});assert.equal(r.andamento,1);assert.equal(r.entregues_mes,1);assert.equal(r.bloqueadas,0);
});
test('agenda filtra a união dos três marcos, incluindo início e conclusão',async()=>{
  const db=fake([]);await s.listar(gestor,{campo_periodo:'marcos',de:'2026-09-01',ate:'2026-09-30'},{supabase:db});
  for(const campo of ['inicio_previsto','previsao_entrega','conclusao_real'])assert.ok(db.calls[0].or.includes(`and(${campo}.gte.2026-09-01,${campo}.lte.2026-09-30)`));
});
test('edição concorrente retorna 409, dependência própria e histórico inválido são rejeitados',async()=>{
  const db=fake([demanda({versao:2})]);await assert.rejects(s.salvar(admin,id,{versao:1,titulo:'Outro'},{supabase:db}),{statusCode:409});
  assert.throws(()=>d.validarDemanda({versao:1,dependencia_id:id},demanda()),{statusCode:400});
  assert.throws(()=>d.validarAtualizacao({texto:'X',tipo:'UPDATE',visibilidade:'PUBLIC',autor:id}),{statusCode:400});
});
test('rotas Express reais: sem login, sem painel, leitura, mutações e CRUD de SuperAdmin',async()=>{
  const db=fake([demanda()]);const app=express();app.use(express.json());app.locals.desenvolvimentoDeps={supabase:db};
  app.use((req,res,next)=>{const role=req.headers['x-test-role'];if(!role)return requireAuth(req,res,next);req.user=role==='admin'?admin:role==='gestor'?gestor:{id};next();});
  app.use('/administrativo',administrativoRouter);app.use((err,req,res,next)=>res.status(err.statusCode||500).json({error:err.message}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const call=async(role,method,path,body)=>fetch(`http://127.0.0.1:${server.address().port}/administrativo/desenvolvimento${path}`,{method,headers:{...(role?{'x-test-role':role}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  try{
    assert.equal((await call(null,'GET','/demandas')).status,401);
    assert.equal((await call('tenant','GET','/demandas')).status,403);
    assert.equal((await call('gestor','GET','/demandas')).status,200);
    // Usuário do Painel Administrativo escreve; usuário sem painel não passa nem do 403 do router.
    assert.equal((await call('gestor','POST','/demandas',{titulo:'Do gestor'})).status,201);
    assert.equal((await call('gestor','PATCH','/demandas/'+id,{versao:1,titulo:'Editada pelo gestor'})).status,200);
    assert.equal((await call('gestor','POST','/demandas/'+id+'/atualizacoes',{texto:'Andamento','tipo':'UPDATE',visibilidade:'PUBLIC'})).status,201);
    for(const [method,path] of [['POST','/demandas'],['PATCH','/demandas/'+id],['DELETE','/demandas/'+id],['POST','/demandas/'+id+'/atualizacoes']])assert.equal((await call('tenant',method,path,{titulo:'X'})).status,403);
    // Exclusão definitiva: 403 para o gestor, 200 para o SuperAdmin.
    assert.equal((await call('gestor','DELETE','/demandas/'+id,{versao:3})).status,403);
    assert.equal((await call('admin','POST','/demandas',{titulo:'Nova'})).status,201);
    assert.equal((await call('admin','DELETE','/demandas/'+id,{versao:3})).status,200);
    assert.equal((await call('gestor','GET','/demandas/'+id2)).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

// ---------------------------------------------------------------------------
// Evolução: escrita liberada ao Painel Administrativo, responsável e nomes.
// ---------------------------------------------------------------------------
test('painel administrativo escreve; só o SuperAdmin exclui, anota e publica interno',async()=>{
  const db=fake([demanda()]);
  // Criar, editar, concluir, reabrir e arquivar — tudo pelo usuário do painel.
  assert.equal((await s.salvar(gestor,null,{titulo:'Criada pelo gestor'},{supabase:db})).titulo,'Criada pelo gestor');
  const editada=await s.salvar(gestor,id,{versao:1,titulo:'Editada',prioridade:'CRITICAL',progresso:80,previsao_entrega:'2026-10-01'},{supabase:db});
  assert.equal(editada.prioridade,'CRITICAL');
  const concluida=await s.salvar(gestor,id,{versao:editada.versao,status:'COMPLETED',conclusao_real:'2026-10-02'},{supabase:db});
  assert.equal(concluida.progresso,100);
  const reaberta=await s.salvar(gestor,id,{versao:concluida.versao,status:'IN_PROGRESS'},{supabase:db});
  assert.equal(reaberta.conclusao_real,null);
  assert.equal((await s.salvar(gestor,id,{versao:reaberta.versao,status:'ARCHIVED'},{supabase:db})).status,'ARCHIVED');
  // Atualização pública passa; a interna não.
  assert.equal((await s.adicionarAtualizacao(gestor,id,{texto:'Andamento',tipo:'UPDATE',visibilidade:'PUBLIC'},{supabase:db})).visibilidade,'PUBLIC');
  await assert.rejects(s.adicionarAtualizacao(gestor,id,{texto:'Segredo',tipo:'UPDATE',visibilidade:'INTERNAL'},{supabase:db}),{statusCode:403});
  assert.equal((await s.adicionarAtualizacao(admin,id,{texto:'Segredo',tipo:'UPDATE',visibilidade:'INTERNAL'},{supabase:db})).visibilidade,'INTERNAL');
  // Campos técnicos e exclusão continuam do SuperAdmin.
  for(const corpo of [{nota_interna:'x'},{link_tecnico:'https://x.example'}])
    await assert.rejects(s.salvar(gestor,id,{versao:99,...corpo},{supabase:db}),{statusCode:403});
  await assert.rejects(s.excluir(gestor,id,{versao:1},{supabase:db}),{statusCode:403});
  assert.deepEqual(await s.excluir(admin,id,{versao:1},{supabase:db}),{excluida:true});
});

test('criador e autor vêm da sessão; o corpo não consegue forjá-los',async()=>{
  const db=fake([]);
  for(const k of ['criado_por','atualizado_por','autor','codigo'])
    assert.throws(()=>d.validarDemanda({titulo:'X',[k]:idAdmin}),{statusCode:400});
  await s.salvar(gestor,null,{titulo:'Minha'},{supabase:db});
  const gravada=await s.obter(gestor,id,{supabase:db});
  assert.equal(gravada.criado_por,idGestor);
  assert.equal(gravada.atualizado_por,idGestor);
  // O autor de uma atualização também vem da sessão, nunca do corpo.
  const nota=await s.adicionarAtualizacao(admin,id,{texto:'Nota',tipo:'COMMENT',visibilidade:'PUBLIC'},{supabase:db});
  assert.equal(nota.autor,idAdmin);
  assert.throws(()=>d.validarAtualizacao({texto:'X',tipo:'COMMENT',visibilidade:'PUBLIC',autor:idGestor}),{statusCode:400});
});

test('responsável precisa ter acesso ao painel; inexistente e externo são recusados',async()=>{
  const db=fake([demanda()]);
  assert.equal((await s.salvar(gestor,id,{versao:1,responsavel_usuario_id:idGestor},{supabase:db})).responsavel_usuario_id,idGestor);
  assert.equal((await s.salvar(gestor,id,{versao:2,responsavel_usuario_id:idAdmin},{supabase:db})).responsavel_usuario_id,idAdmin);
  // Conta real, porém sem acesso ao Painel Administrativo.
  await assert.rejects(s.salvar(gestor,id,{versao:3,responsavel_usuario_id:idForaDoPainel},{supabase:db}),{statusCode:400});
  // Conta que não existe em lugar nenhum.
  await assert.rejects(s.salvar(gestor,id,{versao:3,responsavel_usuario_id:id2},{supabase:db}),{statusCode:400});
  assert.throws(()=>d.validarDemanda({titulo:'X',responsavel_usuario_id:'nao-e-uuid'}),{statusCode:400});
  // Remover o responsável é sempre permitido.
  assert.equal((await s.salvar(gestor,id,{versao:3,responsavel_usuario_id:null},{supabase:db})).responsavel_usuario_id,null);
});

test('respostas trazem nome humano e nenhum UUID como rótulo',async()=>{
  const db=fake([demanda({criado_por:idAdmin,atualizado_por:idGestor,responsavel_usuario_id:idGestor})],
    {desenvolvimento_demanda_atualizacoes:[{id,demanda_id:id,autor:idGestor,texto:'Responsável alterado de Ana SuperAdmin para João Pedro.',tipo:'ASSIGN',visibilidade:'PUBLIC',created_at:'2026-09-05T12:00:00Z'}]});
  const detalhe=await s.obter(gestor,id,{supabase:db});
  assert.equal(detalhe.criado_por_nome,'Ana SuperAdmin');
  assert.equal(detalhe.responsavel_nome,'João Pedro');
  assert.equal(detalhe.atualizado_por_nome,'João Pedro');
  assert.equal((await s.listar(gestor,{},{supabase:db})).itens[0].responsavel_nome,'João Pedro');
  const historico=await s.atualizacoes(gestor,{demanda_id:id},{supabase:db});
  assert.equal(historico.itens[0].autor_nome,'João Pedro');
  // Sem responsável nunca vira UUID nem string vazia.
  const semDono=await s.obter(gestor,id,{supabase:fake([demanda()])});
  assert.equal(semDono.responsavel_nome,'Sem responsável');
  assert.equal(semDono.criado_por_nome,'Sistema');
});

test('catálogo oferece só responsáveis do painel e identifica o usuário da sessão',async()=>{
  const c=await s.catalogos(gestor,{supabase:fake([])});
  const ids=c.responsaveis.map(x=>x.id);
  assert.deepEqual([...ids].sort(),[idAdmin,idGestor].sort());
  assert.ok(!ids.includes(idForaDoPainel));
  assert.ok(c.responsaveis.every(x=>x.nome&&!/^[0-9a-f-]{36}$/i.test(x.nome)));
  assert.deepEqual(c.usuario_atual,{id:idGestor,nome:'João Pedro',pode_ser_responsavel:true});
  assert.equal(c.pode_editar,true); assert.equal(c.pode_administrar,false);
  assert.equal((await s.catalogos(admin,{supabase:fake([])})).pode_administrar,true);
});

test('filtro por responsável e "Minhas demandas" resolvem pela sessão',async()=>{
  const db=fake([demanda({responsavel_usuario_id:idGestor}),demanda({id:id2,responsavel_usuario_id:idAdmin})]);
  const minhas=await s.listar(gestor,{minhas:'true'},{supabase:db});
  assert.equal(minhas.itens.length,1);
  assert.equal(minhas.itens[0].responsavel_usuario_id,idGestor);
  assert.ok(db.calls.some(c=>c.table===repo.TABELA&&c.where.some(([op,k,v])=>op==='eq'&&k==='responsavel_usuario_id'&&v===idGestor)));
  assert.equal((await s.listar(gestor,{responsavel_usuario_id:idAdmin},{supabase:db})).itens[0].id,id2);
  assert.equal((await s.listar(gestor,{sem_responsavel:'true'},{supabase:db})).itens.length,0);
  for(const q of [{minhas:'sim'},{responsavel_usuario_id:'x'},{minhas:'true',sem_responsavel:'true'}])assert.throws(()=>s.filtros(q),{statusCode:400});
});

test('projeção do gestor não carrega nota, link nem eventos internos após a liberação',async()=>{
  const db=fake([demanda()],{desenvolvimento_demanda_atualizacoes:[{id,demanda_id:id,autor:idAdmin,texto:'SEGREDO',visibilidade:'INTERNAL'},{id:id2,demanda_id:id,autor:idGestor,texto:'Publico',visibilidade:'PUBLIC'}]});
  const salva=await s.salvar(gestor,id,{versao:1,titulo:'Sem vazamento'},{supabase:db});
  assert.ok(!Object.hasOwn(salva,'nota_interna')&&!Object.hasOwn(salva,'link_tecnico'));
  assert.ok(!JSON.stringify(salva).includes('SEGREDO'));
  const h=await s.atualizacoes(gestor,{demanda_id:id},{supabase:db});
  assert.equal(h.itens.length,1);
  assert.ok(!JSON.stringify(h).includes('SEGREDO'));
});
