import test from 'node:test';import assert from 'node:assert/strict';import {extractQuestions,conversationQuestions,buildConversationTimeline} from '../shared/conversation-timeline.js';import {answeredQuestions} from '../server/question-status.js';
const m=(id,direction,text)=>({stableId:id,direction,text});
test('requests stay working while the agent works, one finished reply closing one request',()=>{
  const statuses=(messages,options)=>buildConversationTimeline(messages,options).map(x=>x.status);
  assert.deepEqual(statuses([m('a','in','un'),m('b','in','deux'),m('c','in','trois')],{working:true}),['working','working','working']);
  assert.deepEqual(statuses([m('a','in','un'),m('b','in','deux'),m('r','out','C’est fait.')],{working:true}),['done','working','done']);
});
test('a progress note written mid-turn closes no request',()=>{
  const rows=buildConversationTimeline([m('a','in','un'),{...m('p','out','Je regarde.'),final:false},m('b','in','deux')],{working:true});
  assert.deepEqual(rows.map(x=>x.status),['working','progress','working']);
});
test('an idle agent leaves nothing spinning, whatever the pairing',()=>{
  const old=new Date(Date.now()-3600000).toISOString();
  const rows=buildConversationTimeline([{...m('a','in','un'),at:old},{...m('b','in','deux'),at:old},{...m('r','out','Fait.'),at:old}],{working:false});
  assert.deepEqual(rows.map(x=>x.status),['done','done','done']);
});
test('a request answered by a merged reply earlier does not spin forever in a later turn',()=>{
  const t=(minutes)=>new Date(Date.UTC(2026,0,1,12,minutes)).toISOString();
  const messages=[{...m('a','in','un'),at:t(0)},{...m('b','in','deux'),at:t(0)},{...m('r','out','Fait.'),at:t(1)},{...m('s','out','Encore.'),at:t(58)},{...m('c','in','trois'),at:t(59)}];
  assert.deepEqual(buildConversationTimeline(messages,{working:true}).map(x=>x.status),['done','done','done','done','working']);
});
test('a direct approval closes a lone question without the model',()=>{
  const messages=[m('r','out','Corriger le texte puis alléger l’écran.\n\nJe fais les deux ? Si tu ne veux que l’un des deux, dis-moi lequel.'),m('u','in','oui vas y fais les deux, faut vraiment améliorer')];
  assert.equal(buildConversationTimeline(messages)[0].status,'done');
});
test('a partial reply leaves the second question open',()=>{
  const messages=[m('r','out','Quel jour ?\nQuel lieu ?'),m('u','in','oui lundi')];
  assert.equal(buildConversationTimeline(messages)[0].status,'question');
  assert.equal(buildConversationTimeline([...messages.slice(0,1),m('u','in','oui aux deux')])[0].status,'done');
});
test('a request with no question shows no question mark',()=>{
  assert.equal(buildConversationTimeline([m('r','out','Terminé, à toi de tester.')])[0].status,'done');
});
test('question extraction keeps only the asking sentence and skips quotes',()=>{
  assert.deepEqual(extractQuestions('C’est corrigé. Je déploie ?\n> Pourquoi ça casse ?'),['Je déploie ?']);
});
test('questions remain open individually until confirmed answered',()=>{const messages=[m('r','out','Q1 : Quel jour ?\nQ2 : Quel lieu ?'),m('u','in','Q1 : lundi.')];const q=conversationQuestions(messages);assert.equal(q.length,2);assert.equal(buildConversationTimeline(messages,{answeredIds:[q[0].id]})[0].status,'question');assert.equal(buildConversationTimeline(messages,{answeredIds:q.map(x=>x.id)})[0].status,'done');assert.equal(extractQuestions('Terminé, à toi de tester.').length,0);});
test('rhetorical questions are closed by the model even without reply',async()=>{const q=[{id:'r',question:'Pourquoi ça casse ?',replies:[]}];const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{message:{content:'{"answered":[],"notQuestions":["r","invented"]}'}}]})});assert.deepEqual(await answeredQuestions(q,{fetchImpl}),['r']);});
test('question model response accepts only ids actually requested',async()=>{const q=[{id:'safe',question:'Quand ?',replies:['Demain']}];const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{message:{content:'{"answered":[{"id":"safe","evidence":"Demain"},{"id":"invented","evidence":"Demain"}]}'}}]})});assert.deepEqual(await answeredQuestions(q,{fetchImpl}),['safe']);});
