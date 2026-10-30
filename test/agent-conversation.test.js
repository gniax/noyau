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
