import assert from "node:assert/strict";
import {
  createRoomToken,
  createReconnectToken,
  getActiveRoomIdleTtlMs,
  getHeartbeatIntervalSeconds,
  getPeerGraceMs,
  getRoomJoinTtlMs,
  isValidRoomToken,
  parseClientMessage,
  validClientId,
  validReconnectToken,
} from "./security";
import type { Env } from "./types";

const emptyEnv = {} as Env;

const token = createRoomToken();
assert.equal(isValidRoomToken(token), true, "token should match room token format");
assert.equal(token.length, 43, "32 random bytes should encode to 43 base64url chars");
assert.notEqual(createRoomToken(), createRoomToken(), "tokens should not repeat");
assert.equal(createReconnectToken().length, 43, "reconnect tokens should be base64url random values");
assert.equal(validClientId("abc1234567890xyz"), "abc1234567890xyz");
assert.equal(validClientId("bad token"), null);
assert.equal(validReconnectToken(createReconnectToken())?.length, 43);
assert.equal(getRoomJoinTtlMs(emptyEnv), 300_000);
assert.equal(getActiveRoomIdleTtlMs(emptyEnv), 120_000);
assert.equal(getHeartbeatIntervalSeconds(emptyEnv), 20);
assert.equal(getPeerGraceMs(emptyEnv), 45_000);

assert.deepEqual(parseClientMessage('{"type":"ping"}', 1024), { type: "ping" });
assert.throws(() => parseClientMessage('{"type":"unknown"}', 1024), /Unknown/);
assert.throws(() => parseClientMessage("x".repeat(2048), 1024), /large/);
assert.throws(
  () =>
    parseClientMessage(
      JSON.stringify({ type: "offer", sdp: { type: "bogus", sdp: "not allowed" } }),
      2048,
    ),
  /Invalid SDP type/,
);

const viewerHello = parseClientMessage(
  JSON.stringify({
    type: "viewer-hello",
    device: {
      label: "Desktop Chrome",
      userAgent: "Mozilla/5.0",
      platform: "Linux",
    },
  }),
  2048,
);
assert.equal(viewerHello.type, "viewer-hello");

console.log("security validation tests passed");
