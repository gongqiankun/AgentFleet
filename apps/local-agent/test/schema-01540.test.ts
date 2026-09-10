import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedCodexSchemaHash, REQUIRED_CODEX_SCHEMA_HASH } from '../src/constants.js';
import { parseManagedRuntimeTarget } from '../src/managed-runtime-update.js';
test('0.154.0 compatibility is exact and preserves previous releases and rollback', () => {
  const hash = 'f3487938786b729cb6773dbc9e83a7efab9c78c845db7094e8f539f373cbacc9';
  assert.equal(expectedCodexSchemaHash('0.154.0'),hash);
  assert.equal(expectedCodexSchemaHash('0.153.4'),REQUIRED_CODEX_SCHEMA_HASH);
  assert.notEqual(expectedCodexSchemaHash('0.154.1'),hash);
  const target = {schemaVersion:1,revision:'12345678-1234-1234-1234-123456789abc',version:'0.154.0',schemaHash:hash,artifacts:{}};
  assert.equal(parseManagedRuntimeTarget(target)!.version,'0.154.0');
  assert.throws(() => parseManagedRuntimeTarget({...target,version:'0.154.1'}));
  assert.throws(() => parseManagedRuntimeTarget({...target,schemaHash:REQUIRED_CODEX_SCHEMA_HASH}));
  assert.equal(parseManagedRuntimeTarget({...target,version:'0.153.4',schemaHash:REQUIRED_CODEX_SCHEMA_HASH,rollback:true})!.rollback,true);
});
