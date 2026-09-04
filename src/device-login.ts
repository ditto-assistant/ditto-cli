import { pollDeviceToken, requestDeviceCode } from "./api.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface DeviceLoginHooks {
  /** Called with the code and URL the user must visit. */
  onCode: (userCode: string, url: string) => void;
  /** Called once per poll while waiting. */
  onWaiting?: () => void;
}

/**
 * Runs the browser device-login flow and resolves to the minted API key.
 * Polls at the server's interval (backing off on slow_down) until approval,
 * denial, or the code's expiry.
 */
export async function deviceLogin(hooks: DeviceLoginHooks): Promise<string> {
  const code = await requestDeviceCode();
  const url = `${code.verification_url}${code.verification_url.includes("?") ? "&" : "?"}code=${encodeURIComponent(code.user_code)}`;
  hooks.onCode(code.user_code, url);
  const deadline = Date.now() + Math.max(30, code.expires_in || 600) * 1000;
  let interval = Math.max(2, code.interval || 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const result = await pollDeviceToken(code.device_code);
    switch (result.status) {
      case "ok":
        return result.accessToken;
      case "pending":
        hooks.onWaiting?.();
        break;
      case "slow_down":
        interval += 5000;
        break;
      case "denied":
        throw new Error("login was denied in the browser");
      case "expired":
        throw new Error("the login code expired before it was approved; run `heyditto login` again");
    }
  }
  throw new Error("timed out waiting for browser approval; run `heyditto login` again");
}
