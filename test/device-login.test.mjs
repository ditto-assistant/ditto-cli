import assert from "node:assert/strict";
import test from "node:test";
import { deviceLogin } from "../dist/device-login.js";

const cases = [
  ["https://heyditto.ai/device", "https://app.heyditto.ai/device?code=TEST-1234"],
  ["https://app.heyditto.ai/device", "https://app.heyditto.ai/device?code=TEST-1234"],
  ["http://localhost:3000/device?source=cli#approve", "http://localhost:3000/device?source=cli&code=TEST-1234#approve"],
  ["https://heyditto.ai/device?code=old&source=cli", "https://app.heyditto.ai/device?code=TEST-1234&source=cli"],
];

for (const [verificationURL, expectedURL] of cases) {
  test(`device login builds the browser link from ${verificationURL}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json({
      device_code: "test-device-code",
      user_code: "TEST-1234",
      verification_url: verificationURL,
      expires_in: 600,
      interval: 5,
    }));
    const stopBeforePolling = new Error("captured browser link");
    let displayed;
    await assert.rejects(deviceLogin({
      onCode: (code, url) => {
        displayed = { code, url };
        throw stopBeforePolling;
      },
    }), (error) => error === stopBeforePolling);
    assert.deepEqual(displayed, { code: "TEST-1234", url: expectedURL });
  });
}
