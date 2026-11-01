import test from 'node:test';
import assert from 'node:assert/strict';
import { grocerySessionHeaders } from '../src/grocery-auth.js';

test('groceries sends the profile session bearer when cookies are unavailable', () => {
 const storage = {getItem: (key) => key === 'noyau:token' ? 'session-token' : null};
 assert.deepEqual(grocerySessionHeaders('aurora',storage),{'Content-Type':'application/json','X-Noyau-Profile':'aurora',Authorization:'Bearer session-token'});
});
test('missing storage preserves cookie or paired device authentication', () => {
 const storage = {getItem: () => {throw new Error('unavailable');}};
 assert.deepEqual(grocerySessionHeaders('p',storage),{'Content-Type':'application/json','X-Noyau-Profile':'p'});
});
