// Minimal Hocuspocus/Yjs wire-protocol encoder for k6 load tests.
//
// Hocuspocus frames every message as:
//   varString(documentName) + varUint(messageType) + payload
// (see @hocuspocus/provider OutgoingMessage). We only need three things to
// exercise the expensive server paths — authenticate, sync-step-1, and parse
// the server's replies — so this re-implements just enough of lib0's varint /
// varString codec rather than bundling yjs into k6.
//
// Assumption: documentName (uuid) and token are ASCII, so byte length == char
// length. That holds for `mkp_`/`dev-token` tokens and uuid doc ids.

// --- message-type enums (from @hocuspocus/provider + @hocuspocus/common) ---
export const MessageType = { Sync: 0, Awareness: 1, Auth: 2, QueryAwareness: 3, Stateless: 5, SyncStatus: 8 };
const YjsSyncStep1 = 0;
const AuthToken = 0;
const AuthPermissionDenied = 1;
const AuthAuthenticated = 2;

// --- encoders (LEB128 varuint + length-prefixed varstring) ---
function writeVarUint(arr, num) {
  while (num > 127) {
    arr.push(128 | (num & 127));
    num = Math.floor(num / 128);
  }
  arr.push(num & 127);
}

function writeVarString(arr, str) {
  writeVarUint(arr, str.length);
  for (let i = 0; i < str.length; i++) arr.push(str.charCodeAt(i) & 0xff);
}

/** Auth message: the provider sends this first to hand the server its token. */
export function authMessage(documentName, token) {
  const a = [];
  writeVarString(a, documentName);
  writeVarUint(a, MessageType.Auth);
  writeVarUint(a, AuthToken);
  writeVarString(a, token);
  return new Uint8Array(a).buffer;
}

/**
 * Sync step 1 with an empty state vector — asks the server for the full doc.
 * An empty Y.Doc's state vector is the single byte 0x00, length-prefixed.
 */
export function syncStep1(documentName) {
  const a = [];
  writeVarString(a, documentName);
  writeVarUint(a, MessageType.Sync);
  writeVarUint(a, YjsSyncStep1);
  writeVarUint(a, 1); // varUint8Array length
  a.push(0); // the empty state vector
  return new Uint8Array(a).buffer;
}

// --- decoders (just enough to classify server replies) ---
function reader(buf) {
  return { b: new Uint8Array(buf), p: 0 };
}
function readVarUint(r) {
  let num = 0;
  let mult = 1;
  for (;;) {
    const byte = r.b[r.p++];
    num += (byte & 127) * mult;
    if (byte < 128) return num;
    mult *= 128;
  }
}
function skipVarString(r) {
  const len = readVarUint(r);
  r.p += len;
}

/**
 * Classify a server frame: returns 'authenticated', 'denied', 'sync',
 * 'awareness', or 'other'. The first sync reply is our "doc is live" signal;
 * 'denied' means auth/ACL rejected the connection.
 */
export function classify(buf) {
  const r = reader(buf);
  skipVarString(r); // documentName
  const type = readVarUint(r);
  if (type === MessageType.Auth) {
    const sub = readVarUint(r);
    if (sub === AuthAuthenticated) return 'authenticated';
    if (sub === AuthPermissionDenied) return 'denied';
    return 'other';
  }
  if (type === MessageType.Sync) return 'sync';
  if (type === MessageType.Awareness) return 'awareness';
  return 'other';
}
