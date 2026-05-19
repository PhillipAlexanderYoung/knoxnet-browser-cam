import assert from "node:assert/strict";
import {
  buildReceiverUrls,
  buildPhonePairingUrl,
} from "../src/urls.ts";

const devUrls = buildReceiverUrls(
  {
    publicHost: "10.10.10.4",
    receiverPort: 8787,
    useTls: true,
  },
  "ABC123",
);

assert.equal(devUrls.dashboardUrl, "https://10.10.10.4:8787/");
assert.equal(devUrls.receiverWsUrl, "wss://10.10.10.4:8787/ws");
assert.ok(
  devUrls.phonePairingUrl.startsWith("https://10.10.10.4:5173/?"),
  "WSS dev default should open the phone app on :5173",
);
assert.ok(
  !devUrls.phonePairingUrl.startsWith(devUrls.dashboardUrl),
  "phone pairing URL must not use the receiver dashboard origin",
);

const decoded = new URL(devUrls.phonePairingUrl);
assert.equal(decoded.searchParams.get("receiver"), "wss://10.10.10.4:8787/ws");
assert.equal(decoded.searchParams.get("pair"), "ABC123");
assert.equal(decoded.searchParams.get("autostart"), "1");

const explicitPhoneUrl = buildPhonePairingUrl(
  {
    publicHost: "10.10.10.4",
    receiverPort: 8787,
    useTls: true,
    phoneAppUrl: "https://cam.example.test/app/",
  },
  "XYZ789",
);

assert.ok(explicitPhoneUrl.startsWith("https://cam.example.test/app?"));
assert.equal(new URL(explicitPhoneUrl).searchParams.get("pair"), "XYZ789");

console.log("[check-url-defaults] receiver QR URL defaults are OK");
