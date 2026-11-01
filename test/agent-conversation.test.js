import test from 'node:test';
import assert from 'node:assert/strict';
import { readAgentConversation, liveActivity } from '../server/agent-conversation.js';
test('history lookup is strictly bound to agent ID and reports unknown history', async () => {
 let args; const handover = { codexFile: async value => { args = value; return null; } };
 assert.deepEqual(await readAgentConversation({ assistant: 'codex', cwd: '/shared', threadId: null }, { handover }), { available: false, messages: [] });
 assert.equal(args.strict, true); assert.equal(args.cwd, '/shared');
});
test('history shows complete prompts and replies, never presents truncation as editable text', async () => {
 const handover = { codexFile: async () => '/exact' }; const agentMap = { transcriptEntries: async () => [{ role: 'user', text: 'a'.repeat(17000), at: 1 }, {role:'assistant',text:'Réponse',at:2,final:true}] };
 const result = await readAgentConversation({assistant:'codex',threadId:'known'}, {handover,agentMap});
 assert.equal(result.messages[0].truncated, true); assert.equal(result.messages[0].text.length,16384); assert.equal(result.messages[1].text,'Réponse');
});

test("live activity is bounded terminal text, never a fabricated message", () => { assert.equal(liveActivity("\u001b[31mTest\u001b[0m\nSuite"), "Test\nSuite"); assert.ok(liveActivity("x".repeat(900)).length <= 600); });

test('switched history survives unavailable transcript and new distinct prompts', async () => {
 const prior = [{ direction:'in', kind:'founder', text:'Première demande', at:1 }, { direction:'in', kind:'founder', text:'Deuxième demande', at:2 }];
 let handover = { codexFile: async () => null };
 assert.deepEqual((await readAgentConversation({assistant:'codex',conversationHistory:prior},{handover})).messages, prior);
 handover = { codexFile: async () => '/new' };
 const agentMap = { transcriptEntries: async () => [{role:'user',text:"Tu es Codex et tu reprends le travail d'un agent",at:3},{role:'user',text:'Troisième demande',at:4},{role:'user',text:'Quatrième demande',at:5}] };
 const result = await readAgentConversation({assistant:'codex',conversationHistory:prior},{handover,agentMap});
 assert.deepEqual(result.messages.map(m => m.text), ['Première demande','Deuxième demande','Troisième demande','Quatrième demande']);
});

test('messages sent while the agent works stay in the conversation, in order', async () => {
  const { parseTranscriptLine, conversationEvents } = await import('../server/agent-map.js');
  const line = (attachment, timestamp) => JSON.stringify({ type: 'attachment', timestamp, attachment });
  const entries = [
    JSON.stringify({ type: 'user', timestamp: '2026-11-01T10:00:00Z', message: { content: 'Première demande' } }),
    line({ type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: 'Deuxième pendant le travail' }, '2026-11-01T10:01:00Z'),
    line({ type: 'queued_command', commandMode: 'prompt', origin: { kind: 'task-notification' }, prompt: 'Notification interne' }, '2026-11-01T10:02:00Z'),
    line({ type: 'queued_command', commandMode: 'bash', origin: { kind: 'human' }, prompt: 'ls' }, '2026-11-01T10:03:00Z'),
    line({ type: 'skill_listing', prompt: 'ignored' }, '2026-11-01T10:04:00Z'),
  ].map((value) => parseTranscriptLine(value, 'claude')).filter(Boolean);
  assert.deepEqual(conversationEvents(entries).map((event) => event.text), ['Première demande', 'Deuxième pendant le travail']);
});

test('text written between two actions reaches the conversation as progress', async () => {
  const { parseTranscriptLine, conversationEvents } = await import('../server/agent-map.js');
  const assistant = (text, stop_reason, timestamp) => JSON.stringify({ type: 'assistant', timestamp, message: { content: [{ type: 'text', text }], stop_reason } });
  const entries = [
    JSON.stringify({ type: 'user', timestamp: '2026-11-01T10:00:00Z', message: { content: 'Demande' } }),
    assistant('Je regarde', 'tool_use', '2026-11-01T10:00:01Z'),
    assistant('Je corrige', null, '2026-11-01T10:00:02Z'),
    assistant('Fini', 'end_turn', '2026-11-01T10:00:03Z'),
  ].map((value) => parseTranscriptLine(value, 'claude'));
  assert.deepEqual(conversationEvents(entries, { notes: true }).map((event) => [event.text, event.final]), [['Demande', undefined], ['Je regarde', false], ['Je corrige', false], ['Fini', true]]);
  assert.deepEqual(conversationEvents(entries).map((event) => event.text), ['Demande', 'Fini']);
  assert.deepEqual(conversationEvents(entries.slice(0, 2), { notes: true, working: true }).map((event) => event.text), ['Demande', 'Je regarde']);
});
