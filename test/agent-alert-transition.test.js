import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceAgentAlert } from '../src/agent-alert-transition.js';
test('transient idle does not announce completion and stable idle announces once', () => {
 let s = advanceAgentAlert(null, 'working', 0);
 s = advanceAgentAlert(s, 'available', 5000); assert.equal(s.alert, null);
 s = advanceAgentAlert(s, 'working', 10000); assert.equal(s.alert, null); assert.equal(s.pendingSince, null);
 s = advanceAgentAlert(s, 'available', 15000); assert.equal(s.alert, null);
 s = advanceAgentAlert(s, 'available', 34999); assert.equal(s.alert, null);
 s = advanceAgentAlert(s, 'available', 35000); assert.equal(s.alert, 'done');
 s = advanceAgentAlert(s, 'available', 40000); assert.equal(s.alert, null);
});
test('waiting cancels pending completion and is announced only once', () => {
 let s = advanceAgentAlert(null, 'working', 0);
 s = advanceAgentAlert(s, 'available', 1000);
 s = advanceAgentAlert(s, 'waiting', 2000); assert.equal(s.alert, 'waiting'); assert.equal(s.pendingSince, null);
 s = advanceAgentAlert(s, 'waiting', 3000); assert.equal(s.alert, null);
 s = advanceAgentAlert(s, 'available', 30000); assert.equal(s.alert, null);
});
