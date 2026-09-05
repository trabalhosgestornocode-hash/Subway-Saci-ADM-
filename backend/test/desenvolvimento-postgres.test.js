// PostgreSQL REAL descartável, exclusivamente loopback. Nunca lê .env ou Supabase.
// DEV_POSTGRES_TEST=1 DEV_POSTGRES_PORT=55469 node --test test/desenvolvimento-postgres.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const enabled=process.env.DEV_POSTGRES_TEST==='1';
const bin=process.env.DEV_PSQL_BIN || 'C:/Program Files/PostgreSQL/17/bin/psql.exe';
const db='crescer_dev_072_test_'+process.pid;
const port=process.env.DEV_POSTGRES_PORT || '55469';
function sql(text, database=db) {
  const temp=mkdtempSync(join(tmpdir(),'dev-072-sql-'));
  try { const file=join(temp,'query.sql');writeFileSync(file,text,'utf8');return execFileSync(bin,['-X','-h','127.0.0.1','-p',port,'-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-At','-f',file],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000}).trim(); }
  finally { rmSync(temp,{recursive:true,force:true}); }
}
before(()=>{
  if(!enabled)return;
  sql(`create database ${db};`,'postgres');
  sql(`do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if; if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if; end $$;
    create schema auth;create table auth.users(id uuid primary key,email text);create table organizacoes(id uuid primary key,nome text);create table unidades(id uuid primary key,organizacao_id uuid not null references organizacoes(id) on delete cascade,nome text);
    create table plataforma_auditoria(id uuid primary key default gen_random_uuid(),ator_id uuid,ator_tipo text,acao text,entidade text,entidade_id text,detalhes jsonb,created_at timestamptz default now());
    create table perfis(id uuid primary key references auth.users(id) on delete cascade,nome text,email text);
    create table painel_administrativo_usuarios(usuario_id uuid primary key references auth.users(id) on delete cascade,ativo boolean not null default true);
    create table plataforma_admins(usuario_id uuid primary key references auth.users(id) on delete cascade,ativo boolean not null default true);
    grant usage on schema public,auth to service_role;
    insert into auth.users(id,email) values('11111111-1111-4111-8111-111111111111','sem-perfil@crescer.test'),('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ana@crescer.test'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','joao@crescer.test'),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','carlos@loja.test');
    insert into perfis values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Ana SuperAdmin','ana@crescer.test'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','João Pedro','joao@crescer.test'),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','Carlos Operador','carlos@loja.test');
    insert into painel_administrativo_usuarios(usuario_id) values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    insert into plataforma_admins(usuario_id) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');`);
  sql(readFileSync(new URL('../../database/migrations/072_desenvolvimento_demandas.sql',import.meta.url),'utf8'));
  sql(readFileSync(new URL('../../database/migrations/073_desenvolvimento_responsavel.sql',import.meta.url),'utf8'));
});
after(()=>{if(enabled)sql(`drop database if exists ${db};`,'postgres');});
const pgtest=(name,fn)=>test(name,{skip:!enabled?'Defina DEV_POSTGRES_TEST=1 para PostgreSQL local descartável.':false},fn);
pgtest('migration real: código sequencial não reutiliza exclusão e auditoria sobrevive',()=>{
  const r=sql(`insert into desenvolvimento_demandas(titulo,atualizado_por) values('A','11111111-1111-4111-8111-111111111111') returning codigo;`);assert.ok(r.includes('DEV-001'));
  sql(`select desenvolvimento_excluir(id,versao,'11111111-1111-4111-8111-111111111111') from desenvolvimento_demandas where titulo='A';`);
  assert.ok(sql(`insert into desenvolvimento_demandas(titulo) values('B') returning codigo;`).includes('DEV-002'));
  assert.equal(sql(`select count(*) from plataforma_auditoria where acao='desenvolvimento.delete';`),'1');
});
pgtest('foco único e rollback integral quando há conflito',()=>{
  sql(`insert into desenvolvimento_demandas(titulo,foco_atual) values('Foco',true);`);
  assert.throws(()=>sql(`insert into desenvolvimento_demandas(titulo,foco_atual) values('Conflito',true);`));
  assert.equal(sql(`select count(*) from desenvolvimento_demandas where titulo='Conflito';`),'0');
  assert.equal(sql(`select count(*) from desenvolvimento_demandas where foco_atual;`),'1');
});
pgtest('conclusão/reabertura coerentes e histórico gerado na transação',()=>{
  sql(`update desenvolvimento_demandas set status='COMPLETED',progresso=5 where titulo='Foco';`);
  assert.equal(sql(`select progresso=100 and conclusao_real is not null and not foco_atual from desenvolvimento_demandas where titulo='Foco';`),'t');
  sql(`update desenvolvimento_demandas set status='IN_PROGRESS' where titulo='Foco';`);
  assert.equal(sql(`select progresso=0 and conclusao_real is null and inicio_real is not null from desenvolvimento_demandas where titulo='Foco';`),'t');
  assert.equal(sql(`select count(distinct tipo) from desenvolvimento_demanda_atualizacoes where tipo in ('COMPLETED','REOPEN');`),'2');
});
pgtest('constraints reais rejeitam progresso, organização e unidade incompatível',()=>{
  sql(`insert into organizacoes values('22222222-2222-4222-8222-222222222222','Org A'),('33333333-3333-4333-8333-333333333333','Org B');insert into unidades values('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222','Loja');`);
  for(const p of [-1,101])assert.throws(()=>sql(`insert into desenvolvimento_demandas(titulo,progresso) values('Inválida',${p});`));
  assert.throws(()=>sql(`insert into desenvolvimento_demandas(titulo,escopo,organizacao_id) values('Inválida','ORGANIZATION','55555555-5555-4555-8555-555555555555');`));
  assert.throws(()=>sql(`insert into desenvolvimento_demandas(titulo,escopo,organizacao_id,unidade_id) values('Inválida','UNIT','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444');`));
});
pgtest('transferência e exclusão do cadastro preservam operações e demanda',()=>{
  sql(`insert into desenvolvimento_demandas(titulo,escopo,organizacao_id,unidade_id) values('Escopo','UNIT','22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444');update unidades set organizacao_id='33333333-3333-4333-8333-333333333333' where id='44444444-4444-4444-8444-444444444444';`);
  assert.equal(sql(`select organizacao_id from desenvolvimento_demandas where titulo='Escopo';`),'33333333-3333-4333-8333-333333333333');
  sql(`delete from organizacoes where id='33333333-3333-4333-8333-333333333333';`);
  assert.equal(sql(`select escopo='PLATFORM' and organizacao_id is null and unidade_id is null from desenvolvimento_demandas where titulo='Escopo';`),'t');
});
pgtest('notas e funções inacessíveis por anon/authenticated, RLS ativo',()=>{
  for(const role of ['anon','authenticated']){
    assert.throws(()=>sql(`set role ${role};select nota_interna from desenvolvimento_demandas;`));
    assert.throws(()=>sql(`set role ${role};select * from desenvolvimento_demanda_atualizacoes;`));
    assert.throws(()=>sql(`set role ${role};select desenvolvimento_excluir('11111111-1111-4111-8111-111111111111',1,null);`));
  }
  assert.equal(sql(`select count(*) from pg_class where relname in ('desenvolvimento_demandas','desenvolvimento_demanda_atualizacoes') and relrowsecurity;`),'2');
});
pgtest('histórico manual incrementa versão e data, preserva visibilidade interna',()=>{
  const antes=Number(sql(`select versao from desenvolvimento_demandas where titulo='B';`));
  sql(`insert into desenvolvimento_demanda_atualizacoes(demanda_id,texto,tipo,visibilidade,autor) select id,'Segredo','COMMENT','INTERNAL','11111111-1111-4111-8111-111111111111' from desenvolvimento_demandas where titulo='B';`);
  assert.equal(Number(sql(`select versao from desenvolvimento_demandas where titulo='B';`)),antes+1);
  assert.equal(sql(`select count(*) from desenvolvimento_demanda_atualizacoes where texto='Segredo' and visibilidade='INTERNAL';`),'1');
});
pgtest('service_role insere demanda, histórico e auditoria sem privilégio público',()=>{
  sql(`grant insert on plataforma_auditoria to service_role;set role service_role;insert into desenvolvimento_demandas(titulo) values('Service');`);
  assert.equal(sql(`select count(*) from desenvolvimento_demandas where titulo='Service';`),'1');
});

// -------------------------------------------------------------------------
// Migration 073 — responsável e nomes humanos, no PostgreSQL real.
// -------------------------------------------------------------------------
const ANA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';   // SuperAdmin
const JOAO='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';  // Painel Administrativo
const CARLOS='cccccccc-cccc-4ccc-8ccc-cccccccccccc';// sem acesso ao painel

pgtest('073: só quem tem acesso ao painel pode ser responsável',()=>{
  sql(`insert into desenvolvimento_demandas(titulo,atualizado_por,responsavel_usuario_id) values('Com dono','${ANA}','${JOAO}');`);
  assert.equal(sql(`select responsavel_usuario_id from desenvolvimento_demandas where titulo='Com dono';`),JOAO);
  // SuperAdmin também é elegível (faz bypass do painel).
  sql(`insert into desenvolvimento_demandas(titulo,responsavel_usuario_id) values('Do super','${ANA}');`);
  // Conta real sem acesso ao painel: recusada pelo gatilho, não pelo app.
  assert.throws(()=>sql(`insert into desenvolvimento_demandas(titulo,responsavel_usuario_id) values('Externa','${CARLOS}');`));
  assert.throws(()=>sql(`update desenvolvimento_demandas set responsavel_usuario_id='${CARLOS}' where titulo='Com dono';`));
  // Nulo continua permitido (demandas antigas e sem dono).
  sql(`insert into desenvolvimento_demandas(titulo) values('Sem dono');`);
  assert.equal(sql(`select responsavel_usuario_id is null from desenvolvimento_demandas where titulo='Sem dono';`),'t');
});

pgtest('073: revogar acesso não trava a edição das demandas antigas do responsável',()=>{
  sql(`update painel_administrativo_usuarios set ativo=false where usuario_id='${JOAO}';`);
  // Editar outros campos segue funcionando, mesmo com o responsável já inelegível.
  sql(`update desenvolvimento_demandas set progresso=40 where titulo='Com dono';`);
  assert.equal(sql(`select progresso from desenvolvimento_demandas where titulo='Com dono';`),'40');
  // Mas apontar de novo para a conta revogada é recusado.
  assert.throws(()=>sql(`update desenvolvimento_demandas set responsavel_usuario_id='${JOAO}' where titulo='Sem dono';`));
  sql(`update painel_administrativo_usuarios set ativo=true where usuario_id='${JOAO}';`);
});

pgtest('073: troca de responsável vira histórico com NOME, nunca UUID',()=>{
  sql(`update desenvolvimento_demandas set responsavel_usuario_id='${ANA}',atualizado_por='${JOAO}' where titulo='Com dono';`);
  const texto=sql(`select texto from desenvolvimento_demanda_atualizacoes where tipo='ASSIGN' and demanda_id=(select id from desenvolvimento_demandas where titulo='Com dono') order by created_at desc limit 1;`);
  assert.equal(texto,'Responsável alterado de João Pedro para Ana SuperAdmin.');
  assert.ok(!texto.includes(ANA) && !texto.includes(JOAO));
  // Autor do evento é quem editou, e resolve para nome humano.
  assert.equal(sql(`select desenvolvimento_nome_usuario(autor) from desenvolvimento_demanda_atualizacoes where tipo='ASSIGN' and demanda_id=(select id from desenvolvimento_demandas where titulo='Com dono') order by created_at desc limit 1;`),'João Pedro');
  // Definir na criação também registra.
  assert.ok(sql(`select texto from desenvolvimento_demanda_atualizacoes where tipo='ASSIGN' and demanda_id=(select id from desenvolvimento_demandas where titulo='Do super');`).includes('Responsável definido: Ana SuperAdmin.'));
  // Remover o responsável é legível, sem "null".
  sql(`update desenvolvimento_demandas set responsavel_usuario_id=null,atualizado_por='${ANA}' where titulo='Do super';`);
  assert.ok(sql(`select texto from desenvolvimento_demanda_atualizacoes where tipo='ASSIGN' and demanda_id=(select id from desenvolvimento_demandas where titulo='Do super') order by created_at desc limit 1;`).includes('para sem responsável.'));
});

pgtest('073: nome humano nunca devolve UUID e cai para o e-mail do Auth',()=>{
  assert.equal(sql(`select desenvolvimento_nome_usuario('${JOAO}');`),'João Pedro');
  // Sem linha em perfis (caso do SuperAdmin sem empresa): usa o e-mail do Auth.
  assert.equal(sql(`select desenvolvimento_nome_usuario('11111111-1111-4111-8111-111111111111');`),'sem-perfil@crescer.test');
  // Perfil com nome em branco cai para o e-mail do perfil, não para o id.
  sql(`update perfis set nome='   ' where id='${CARLOS}';`);
  assert.equal(sql(`select desenvolvimento_nome_usuario('${CARLOS}');`),'carlos@loja.test');
  assert.equal(sql(`select desenvolvimento_nome_usuario(null) is null;`),'t');
});

pgtest('073: auditoria registra o tipo real do ator, não "superadmin" fixo',()=>{
  sql(`insert into desenvolvimento_demandas(titulo,atualizado_por) values('Auditada','${JOAO}');`);
  assert.equal(sql(`select ator_tipo from plataforma_auditoria where acao='desenvolvimento.insert' and ator_id='${JOAO}' order by created_at desc limit 1;`),'usuario');
  sql(`insert into desenvolvimento_demandas(titulo,atualizado_por) values('Auditada super','${ANA}');`);
  assert.equal(sql(`select ator_tipo from plataforma_auditoria where acao='desenvolvimento.insert' and ator_id='${ANA}' order by created_at desc limit 1;`),'superadmin');
  // A auditoria continua sem nota interna nem link técnico.
  assert.equal(sql(`select count(*) from plataforma_auditoria where detalhes::text like '%nota_interna%' or detalhes::text like '%link_tecnico%';`),'0');
});

pgtest('073: funções novas continuam fora do alcance de anon/authenticated',()=>{
  for(const role of ['anon','authenticated']){
    assert.throws(()=>sql(`set role ${role};select desenvolvimento_nome_usuario('${JOAO}');`));
    assert.throws(()=>sql(`set role ${role};select desenvolvimento_pode_ser_responsavel('${JOAO}');`));
    assert.throws(()=>sql(`set role ${role};select desenvolvimento_ator_tipo('${JOAO}');`));
  }
});
