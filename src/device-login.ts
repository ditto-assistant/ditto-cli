import { type DeviceIntent, type SelectedEndpoint, pollDeviceToken, requestDeviceCode } from "./api.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface DeviceLoginHooks {
  /** Why the browser is being opened; the web page specializes its copy on it. */
  intent: DeviceIntent;
  /** Called with the code and the URL the user must visit. */
  onCode: (userCode: string, url: string) => void;
  /** Called once per poll while waiting. */
  onWaiting?: () => void;
}

export interface DeviceLoginResult {
  apiKey: string;
  /** Endpoint the user picked in the browser, when the intent asked for one. */
  endpoint?: SelectedEndpoint;
  /** The browser asked the CLI to remember `endpoint` as its default. */
  setDefault?: boolean;
}

/** Builds the URL to open: the backend's complete URI, else the bare page plus the code. */
export function verificationLink(code: { verification_url: string; verification_uri_complete?: string; user_code: string }): string {
  if (code.verification_uri_complete) return code.verification_uri_complete;
  const sep = code.verification_url.includes("?") ? "&" : "?";
  return `${code.verification_url}${sep}code=${encodeURIComponent(code.user_code)}`;
}

/**
 * Runs the browser device-login flow and resolves to the minted API key plus
 * whatever the browser chose for the CLI. Polls once quickly, then at the
 * server's interval (backing off on slow_down) until approval, denial, or expiry.
 */
export async function deviceLogin(hooks: DeviceLoginHooks): Promise<DeviceLoginResult> {
  const code = await requestDeviceCode({ intent: hooks.intent });
  hooks.onCode(code.user_code, verificationLink(code));
  const deadline = Date.now() + Math.max(30, code.expires_in || 600) * 1000;
  let interval = Math.max(2, code.interval || 5) * 1000;
  let wait = 1000;
  while (Date.now() < deadline) {
    await sleep(wait);
    wait = interval;
    const result = await pollDeviceToken(code.device_code);
    switch (result.status) {
      case "ok":
        return { apiKey: result.accessToken, endpoint: result.endpoint, setDefault: result.setDefault };
      case "pending":
        hooks.onWaiting?.();
        break;
      case "slow_down":
        interval += 5000;
        wait = interval;
        break;
      case "denied":
        throw new Error("login was denied in the browser");
      case "expired":
        throw new Error("the login code expired before it was approved; run `heyditto login` again");
    }
  }
  throw new Error("timed out waiting for browser approval; run `heyditto login` again");
}
