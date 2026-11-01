import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationQuotaExhausted as exhausted } from '../src/conversation-quota.js';
const session = { agentStatus: { state: 'idle' } };
const messages = [{ direction: 'out', text: 'Usage limit reached', at: '2026-11-01T10:00:00Z' }];
test('quota warning follows resets and newer successful quota readings', () => {
  const old = { updatedAt: '2026-11-01T09:00:00Z', windows: [{ remainingPercent: 0, resetsAt: '2026-11-01T11:00:00Z' }] };
  assert.equal(exhausted({session, messages, quota: old, now: Date.parse('2026-11-01T10:30:00Z')}), true);
  assert.equal(exhausted({session, messages, quota: old, now: Date.parse('2026-11-01T11:01:00Z')}), false);
  assert.equal(exhausted({session, messages, quota: {updatedAt:'2026-11-01T10:01:00Z', windows:[{remainingPercent:50}]}}), false);
  assert.equal(exhausted({session, messages, quota: {updatedAt:'2026-11-01T09:00:00Z', windows:[{remainingPercent:50}]}}), true);
});
test('old error disappears when user retries or agent works', () => {
  assert.equal(exhausted({session, messages:[...messages,{direction:'in',text:'retry'}]}), false);
  assert.equal(exhausted({session, messages, pending:true}), false);
  assert.equal(exhausted({session:{agentStatus:{state:'working'}}, messages}), false);
});
