import test from 'node:test';
import assert from 'node:assert/strict';
import { readNativeNavigation, saveNativeNavigation, clearNativeNavigation } from '../src/native-navigation-state.js';
test('restore navigation per profile and clear it at logout', () => {
 const data = new Map(); const storage = { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) };
 saveNativeNavigation(storage, 'one', 'agent-1', 'projects');
 assert.deepEqual(readNativeNavigation(storage, 'one'), { session: 'agent-1', view: 'projects' });
 assert.equal(readNativeNavigation(storage, 'two'), null);
 clearNativeNavigation(storage, 'one'); assert.equal(readNativeNavigation(storage, 'one'), null);
});
