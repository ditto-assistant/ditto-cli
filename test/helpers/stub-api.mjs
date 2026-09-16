import http from "node:http";

export const MINTED_PLAINTEXT = "ditto_inf_PLAINTEXT_MUST_NEVER_PRINT_zz99";

/** Companies the shared stub reports; listEndpoints() merges each one's endpoints in. */
export const STUB_COMPANIES = [];

/**
 * Handles the catalog routes listEndpoints() now walks: the bare endpoints
 * list (caller's own), the companies list and each company-scoped listing.
 * The stub's own endpoints route handler must run first; call this when that
 * did not match. Returns true when it answered.
 */
export function listEndpointsStubHandler(req, json, { orgEndpoints = [] } = {}) {
  if (req.url === "/api/v5/companies" && req.method === "GET") {
    json(200, { companies: STUB_COMPANIES });
    return true;
  }
  if (req.url.startsWith("/api/v5/inference/endpoints?company=") && req.method === "GET") {
    json(200, { baseUrl: "https://api.example.test/v1", endpoints: orgEndpoints });
    return true;
  }
  return false;
}

export const ALPHA = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "alpha",
  name: "Alpha",
  model: "openai/gpt-5.6-luna",
  spendPeriod: "monthly",
  spendLimitTokens: 1000000,
  spentTokens: 25000,
  recordTrace: true,
  status: "active",
};

/**
 * Minimal stub of the endpoint + key routes, for tests that care about which
 * calls the CLI makes (and, just as importantly, which it does not make when
 * a platform CLI is missing).
 */
export function startStub({ endpoints = [ALPHA] } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      const json = (status, payload) => {
        res.statusCode = status;
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      if (req.url === "/api/v5/inference/endpoints" && req.method === "GET") {
        return json(200, { baseUrl: "https://api.example.test/v1", endpoints, limit: 5, used: endpoints.length });
      }
      if (listEndpointsStubHandler(req, json)) return;
      const m = req.url.match(/^\/api\/v5\/inference\/endpoints\/([^/]+)(\/keys(?:\/([^/]+))?)?$/);
      if (m && m[2] === "/keys" && req.method === "POST") {
        const input = JSON.parse(body);
        return json(201, {
          id: "key-2",
          endpointId: m[1],
          name: input.name,
          keyHint: "zz99",
          key: MINTED_PLAINTEXT,
          expiresAt: "2027-09-05T00:00:00Z",
          spendLimitTokens: input.spendLimitTokens ?? null,
          spendPeriod: input.spendPeriod ?? "never",
        });
      }
      if (m && m[3] && req.method === "DELETE") return json(204);
      json(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        calls,
        mints: () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/keys")),
        revocations: () => calls.filter((c) => c.method === "DELETE"),
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}
