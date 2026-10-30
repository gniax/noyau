import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationDraftStore } from '../src/conversation-drafts.js';
function memoryStorage() { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k), values }; }
test('draft and attachments persist across instances and stay scoped to profile, server and agent', () => {
 const storage = memoryStorage(); const make = (profile='one',server='https://home') => createConversationDraftStore({storage,profile,server});
 make().set('a', {draft:'texte',attachments:[{name:'photo.png',path:'/upload/photo.png'}]});
 assert.deepEqual(make().get('a'), {draft:'texte',attachments:[{name:'photo.png',path:'/upload/photo.png'}]});
 assert.equal(make('two').get('a'), undefined); assert.equal(make('one','https://other').get('a'), undefined); assert.equal(make().get('b'), undefined);
 make().set('a', {draft:'',attachments:[]}); assert.equal(make().get('a'), undefined);
});
test('unavailable storage keeps draft in memory without writing across profiles', () => {
 const storage = {getItem(){throw Error('blocked')},setItem(){throw Error('blocked')},removeItem(){throw Error('blocked')}};
 const store = createConversationDraftStore({storage,server:'https://home',profile:'one'}); store.set('a',{draft:'hello',attachments:[]}); assert.equal(store.get('a').draft,'hello');
});
