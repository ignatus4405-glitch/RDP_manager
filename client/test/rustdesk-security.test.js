'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const path = require('node:path');
const Module = require('node:module');

test('RustDesk server public key verifies the remote peer identity', () => {
  const entry = `
    export { verifyPeerLongTermKey } from './client/vendor/rdweb/src/crypto.ts';
    export { IdPkSchema } from './client/vendor/rdweb/src/proto/session_pb.ts';
    export { create, toBinary } from '@bufbuild/protobuf';
    export { default as nacl } from 'tweetnacl';
  `;
  const result = esbuild.buildSync({ stdin: { contents: entry, resolveDir: path.join(__dirname, '../..'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false });
  const mod = new Module('rdweb-test');
  mod.filename = path.join(__dirname, 'rdweb-test.js');
  mod.paths = module.paths;
  mod._compile(result.outputFiles[0].text, mod.filename);
  const { verifyPeerLongTermKey, IdPkSchema, create, toBinary, nacl } = mod.exports;
  const server = nacl.sign.keyPair();
  const peer = nacl.sign.keyPair();
  const payload = toBinary(IdPkSchema, create(IdPkSchema, { id: '123456', pk: peer.publicKey }));
  const signed = nacl.sign(payload, server.secretKey);
  assert.deepEqual(verifyPeerLongTermKey(signed, server.publicKey, '123456'), peer.publicKey);
  assert.throws(() => verifyPeerLongTermKey(signed, server.publicKey, 'wrong'), /identity/);
  const impostor = nacl.sign.keyPair();
  assert.throws(() => verifyPeerLongTermKey(signed, impostor.publicKey, '123456'), /signature/);
  signed[0] ^= 1;
  assert.throws(() => verifyPeerLongTermKey(signed, server.publicKey, '123456'), /signature/);
});
