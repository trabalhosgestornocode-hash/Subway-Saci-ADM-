import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ui from '../src/desenvolvimentoUi.js';
const d={id:'id',codigo:'DEV-001',titulo:'<script>alert(1)</script>',categoria:'UX/UI',status:'PLANNED',prioridade:'HIGH',progresso:65,previsao_entrega:'2026-09-12',inicio_previsto:'2026-09-01',conclusao_real:null,indicador_prazo:'No prazo'};
test('cards escapam conteúdo, exibem progresso, previsão e controles só para admin',()=>{
  const html=ui.card(d);assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('65%'));assert.ok(html.includes('12/09/2026'));assert.ok(!html.includes('data-dev-move'));assert.ok(ui.card(d,true).includes('data-dev-move'));
});
test('agenda apresenta múltiplos marcos e organiza mês, semana e lista',()=>{
  assert.equal(ui.eventos([d]).length,2);
  assert.equal((ui.agenda([d],'mes','2026-09-01').match(/class="dev-day"/g)||[]).length,42);
  assert.equal((ui.agenda([d],'semana','2026-09-01').match(/class="dev-day"/g)||[]).length,7);
  assert.ok(ui.agenda([d],'lista','2026-09-01').includes('Início previsto'));
});
test('roadmap agrupa por mês e mantém demandas sem data visíveis',()=>{
  const html=ui.roadmap([d,{...d,previsao_entrega:null,inicio_previsto:null}]);assert.ok(html.includes('setembro'));assert.ok(html.includes('Sem previsão'));
});
test('board possui seis colunas e timeline escapa notas',()=>{
  assert.equal((ui.board([d],false).match(/class="dev-column"/g)||[]).length,6);
  assert.ok(!ui.historico([{texto:'<img onerror=alert(1)>',created_at:'2026-09-01',visibilidade:'PUBLIC'}]).includes('<img'));
});

const UUID='fddba1a8-ddd7-49cc-b1ae-976a93c6f826';
test('responsável aparece por nome nos cards, foco e próximas — nunca o UUID',()=>{
  const comDono={...d,responsavel_usuario_id:UUID,responsavel_nome:'João Pedro'};
  const cartao=ui.card(comDono);
  assert.ok(cartao.includes('João Pedro'));
  assert.ok(!cartao.includes(UUID));
  // Sem responsável: rótulo humano, nunca vazio nem identificador.
  assert.ok(ui.card(d).includes('Sem responsável'));
  assert.equal(ui.responsavel(comDono),'João Pedro');
  assert.equal(ui.responsavel(d),'Sem responsável');
  // Board e roadmap herdam o mesmo cartão.
  for(const html of [ui.board([comDono],false),ui.roadmap([comDono])]){
    assert.ok(html.includes('João Pedro'));assert.ok(!html.includes(UUID));
  }
  // Foco atual e próximas demandas na Visão Geral.
  const geral=ui.overview({andamento:1,planejadas:1,validacao:0,bloqueadas:0,entregues_mes:0,minhas:2,foco:comDono,proximas:[comDono],proxima_entrega:null,recentes:[]});
  assert.ok(!geral.includes(UUID));
  assert.equal((geral.match(/João Pedro/g)||[]).length>=3,true);
  assert.ok(geral.includes('Minhas demandas'));
});
test('histórico mostra o nome do autor, não o identificador da conta',()=>{
  const evento={id:'e1',autor:UUID,autor_nome:'João Pedro',texto:'Responsável alterado de Ana para João Pedro.',tipo:'ASSIGN',visibilidade:'PUBLIC',created_at:'2026-09-05T15:00:00Z'};
  const html=ui.historico([evento]);
  assert.ok(html.includes('Autor: João Pedro'));
  assert.ok(!html.includes(UUID));
  assert.ok(html.includes('Responsável alterado de Ana para João Pedro.'));
  // Sem autor resolvido, o rótulo é "Sistema" — jamais um UUID.
  assert.ok(ui.historico([{...evento,autor_nome:undefined}]).includes('Autor: Sistema'));
  // E o nome continua escapado.
  assert.ok(!ui.historico([{...evento,autor_nome:'<img onerror=alert(1)>'}]).includes('<img'));
});
