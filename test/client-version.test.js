import test from 'node:test';
import assert from 'node:assert/strict';
import { clientUpdateDecision } from '../src/client-version.js';

test('reload stale running UI even if another tab updated the stored release', () => {
 const input = { runningVersion:'0.165.1',serverVersion:'0.165.2',serverRelease:'0.165.2+hash',knownRelease:'0.165.2+hash' };
 const first=clientUpdateDecision(input);assert.equal(first.reload,true);
 assert.equal(clientUpdateDecision({...input,lastAttempt:first.attempt}).reload,false);
 assert.equal(clientUpdateDecision({...input,runningVersion:'0.165.2'}).reload,false);
});
test('new release reloads even with same semantic version', () => {
 assert.equal(clientUpdateDecision({runningVersion:'1.0.0',serverVersion:'1.0.0',knownRelease:'old',serverRelease:'new'}).reload,true);
});
