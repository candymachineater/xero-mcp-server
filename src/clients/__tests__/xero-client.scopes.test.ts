import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scope negotiation for Custom Connections (client_credentials).
 *
 * Nothing here touches Xero. The only fakes are at the transport seam: axios
 * (every token/connections call goes through it) and dotenv (so no real .env
 * on the machine running the tests can leak into the client). The client, its
 * scope lists and its fallback chain are the real ones.
 */
const transport = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
}));

vi.mock("axios", () => {
  class AxiosError extends Error {}

  return {
    default: { post: transport.post, get: transport.get },
    AxiosError,
  };
});

vi.mock("dotenv", () => ({ default: { config: () => ({ parsed: {} }) } }));

const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONNECTIONS_URL = "https://api.xero.com/connections";
const ATTACHMENTS_SCOPE = "accounting.attachments";

/**
 * The exact scope strings that shipped before attachments existed. Pinned on
 * purpose: a change that alters which permissions a working connection ends
 * up with cannot pass without editing these literals.
 */
const V1_SCOPES = [
  "accounting.transactions",
  "accounting.contacts",
  "accounting.settings",
  "accounting.reports.read",
  "payroll.settings",
  "payroll.employees",
  "payroll.timesheets",
].join(" ");

const V2_SCOPES = [
  "accounting.invoices",
  "accounting.payments",
  "accounting.banktransactions",
  "accounting.manualjournals",
  "accounting.reports.aged.read",
  "accounting.reports.balancesheet.read",
  "accounting.reports.profitandloss.read",
  "accounting.reports.trialbalance.read",
  "accounting.contacts",
  "accounting.settings",
  "payroll.settings",
  "payroll.employees",
  "payroll.timesheets",
].join(" ");

const V1_PLUS_ATTACHMENTS = `${V1_SCOPES} ${ATTACHMENTS_SCOPE}`;
const V2_PLUS_ATTACHMENTS = `${V2_SCOPES} ${ATTACHMENTS_SCOPE}`;

type TokenOutcome =
  | { kind: "token"; accessToken: string }
  | { kind: "http"; status: number; data: unknown }
  | { kind: "network" };

type TokenResponseBody = { access_token: string };

type ScopeNegotiatingClient = {
  tenantId: string;
  authenticate(): Promise<void>;
  getClientCredentialsToken(): Promise<TokenResponseBody>;
};

function token(accessToken: string): TokenOutcome {
  return { kind: "token", accessToken };
}

function refused(status: number, error: string): TokenOutcome {
  return { kind: "http", status, data: { error } };
}

function httpError(status: number, data: unknown): Error {
  const error = new Error(
    `Request failed with status code ${status}`,
  ) as Error & { response: { status: number; data: unknown } };
  error.response = { status, data };

  return error;
}

/** Drive the fake token endpoint from the scope string that was requested. */
function tokenEndpoint(respond: (scope: string) => TokenOutcome): void {
  transport.post.mockImplementation(async (url: string, body: string) => {
    if (url !== TOKEN_URL) {
      throw new Error(`Unexpected POST to ${url}`);
    }

    const scope = new URLSearchParams(body).get("scope") ?? "";
    const outcome = respond(scope);

    if (outcome.kind === "token") {
      return {
        data: {
          access_token: outcome.accessToken,
          expires_in: 1800,
          token_type: "Bearer",
        },
      };
    }

    if (outcome.kind === "network") {
      throw new Error("socket hang up");
    }

    throw httpError(outcome.status, outcome.data);
  });
}

/** Every scope string sent to the token endpoint, in order. */
function requestedScopes(): string[] {
  return transport.post.mock.calls.map(
    (call) => new URLSearchParams(call[1] as string).get("scope") ?? "",
  );
}

async function loadClient(): Promise<ScopeNegotiatingClient> {
  const clientModule = await import("../xero-client.js");

  return clientModule.xeroClient as unknown as ScopeNegotiatingClient;
}

beforeEach(() => {
  vi.resetModules();
  transport.post.mockReset();
  transport.get.mockReset();
  transport.get.mockResolvedValue({
    data: [{ tenantId: "SYNTHETIC-TENANT" }],
  });
  vi.stubEnv("XERO_CLIENT_ID", "SYNTHETIC-CLIENT-ID");
  vi.stubEnv("XERO_CLIENT_SECRET", "SYNTHETIC-CLIENT-SECRET");
  vi.stubEnv("XERO_CLIENT_BEARER_TOKEN", "");
  vi.stubEnv("XERO_SCOPES", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CustomConnectionsXeroClient scope negotiation", () => {
  it("asks for accounting.attachments on the first token request", async () => {
    tokenEndpoint(() => token("token-v1-attachments"));

    const client = await loadClient();
    const result = await client.getClientCredentialsToken();

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(requestedScopes()).toEqual([V1_PLUS_ATTACHMENTS]);
    expect(requestedScopes()[0].split(" ")).toContain(ATTACHMENTS_SCOPE);
    expect(result.access_token).toBe("token-v1-attachments");
    expect(transport.get).toHaveBeenCalledWith(
      CONNECTIONS_URL,
      expect.anything(),
    );
  });

  it("asks for the read+write attachments scope only, never the read-only one", async () => {
    tokenEndpoint(() => token("token-v1-attachments"));

    const client = await loadClient();
    await client.getClientCredentialsToken();

    const scopes = requestedScopes()[0].split(" ");

    expect(scopes.filter((scope) => scope === ATTACHMENTS_SCOPE)).toHaveLength(
      1,
    );
    expect(scopes).not.toContain("accounting.attachments.read");
  });

  // ANTI-REGRESSION: a connection that was never granted attachments must end
  // up exactly where it is today - authenticated on the V1 scope list.
  it("falls back to today's V1 scopes and still succeeds when attachments is refused", async () => {
    tokenEndpoint((scope) =>
      scope.split(" ").includes(ATTACHMENTS_SCOPE)
        ? refused(400, "invalid_scope")
        : token("token-v1"),
    );

    const client = await loadClient();
    const result = await client.getClientCredentialsToken();

    expect(transport.post).toHaveBeenCalledTimes(3);
    expect(requestedScopes()).toEqual([
      V1_PLUS_ATTACHMENTS,
      V2_PLUS_ATTACHMENTS,
      V1_SCOPES,
    ]);
    expect(result.access_token).toBe("token-v1");
  });

  // ANTI-REGRESSION: same for a granular (V2) connection without attachments.
  it("falls back to today's V2 scopes and still succeeds when attachments and V1 are refused", async () => {
    tokenEndpoint((scope) =>
      scope === V2_SCOPES ? token("token-v2") : refused(400, "invalid_scope"),
    );

    const client = await loadClient();
    const result = await client.getClientCredentialsToken();

    expect(transport.post).toHaveBeenCalledTimes(4);
    expect(requestedScopes()).toEqual([
      V1_PLUS_ATTACHMENTS,
      V2_PLUS_ATTACHMENTS,
      V1_SCOPES,
      V2_SCOPES,
    ]);
    expect(result.access_token).toBe("token-v2");
  });

  // ANTI-REGRESSION: a refusal that is not invalid_scope must not break a
  // connection either - Xero does not document the code for an ungranted
  // scope, so the optional attempt degrades on any refusal.
  it("falls back to today's chain when the attachments attempt is refused with another 4xx code", async () => {
    tokenEndpoint((scope) =>
      scope.split(" ").includes(ATTACHMENTS_SCOPE)
        ? refused(400, "invalid_request")
        : token("token-v1"),
    );

    const client = await loadClient();
    const result = await client.getClientCredentialsToken();

    expect(transport.post).toHaveBeenCalledTimes(3);
    expect(requestedScopes()).toEqual([
      V1_PLUS_ATTACHMENTS,
      V2_PLUS_ATTACHMENTS,
      V1_SCOPES,
    ]);
    expect(result.access_token).toBe("token-v1");
  });

  it("gets attachments on the granular list when only that combination is granted", async () => {
    tokenEndpoint((scope) =>
      scope === V2_PLUS_ATTACHMENTS
        ? token("token-v2-attachments")
        : refused(400, "invalid_scope"),
    );

    const client = await loadClient();
    const result = await client.getClientCredentialsToken();

    expect(transport.post).toHaveBeenCalledTimes(2);
    expect(requestedScopes()).toEqual([
      V1_PLUS_ATTACHMENTS,
      V2_PLUS_ATTACHMENTS,
    ]);
    expect(result.access_token).toBe("token-v2-attachments");
  });

  it("makes no extra token requests when the first attempt fails with a server error", async () => {
    tokenEndpoint(() => ({
      kind: "http",
      status: 500,
      data: { error: "server_error" },
    }));

    const client = await loadClient();

    await expect(client.getClientCredentialsToken()).rejects.toThrow(
      'Failed to get Xero token with V1 scopes plus attachments: {"error":"server_error"}',
    );
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it("makes no extra token requests when the first attempt is rate limited", async () => {
    tokenEndpoint(() => ({
      kind: "http",
      status: 429,
      data: { error: "rate_limit_exceeded" },
    }));

    const client = await loadClient();

    await expect(client.getClientCredentialsToken()).rejects.toThrow(
      "Failed to get Xero token with V1 scopes plus attachments",
    );
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it("makes no extra token requests when the first attempt has no HTTP response", async () => {
    tokenEndpoint(() => ({ kind: "network" }));

    const client = await loadClient();

    await expect(client.getClientCredentialsToken()).rejects.toThrow(
      "Failed to get Xero token with V1 scopes plus attachments: socket hang up",
    );
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it("does not try V2 when the unchanged V1 attempt fails for a non-invalid_scope reason", async () => {
    tokenEndpoint((scope) =>
      scope.split(" ").includes(ATTACHMENTS_SCOPE)
        ? refused(400, "invalid_scope")
        : refused(400, "invalid_client"),
    );

    const client = await loadClient();

    await expect(client.getClientCredentialsToken()).rejects.toThrow(
      'Failed to get Xero token with V1 scopes: {"error":"invalid_client"}',
    );
    expect(transport.post).toHaveBeenCalledTimes(3);
    expect(requestedScopes()).not.toContain(V2_SCOPES);
  });

  it("reports the V2 failure when every attempt is refused for scope", async () => {
    tokenEndpoint(() => refused(400, "invalid_scope"));

    const client = await loadClient();

    await expect(client.getClientCredentialsToken()).rejects.toThrow(
      'Failed to get Xero token with V2 scopes: {"error":"invalid_scope"}',
    );
    expect(transport.post).toHaveBeenCalledTimes(4);
  });

  it("honours XERO_SCOPES verbatim and never appends attachments", async () => {
    const override = "accounting.transactions accounting.contacts";
    vi.stubEnv("XERO_SCOPES", override);
    tokenEndpoint(() => token("token-override"));

    const client = await loadClient();
    const result = await client.getClientCredentialsToken();

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(requestedScopes()).toEqual([override]);
    expect(result.access_token).toBe("token-override");
  });

  it("does not fall back to the default scopes when XERO_SCOPES is refused", async () => {
    vi.stubEnv("XERO_SCOPES", `accounting.transactions ${ATTACHMENTS_SCOPE}`);
    tokenEndpoint(() => refused(400, "invalid_scope"));

    const client = await loadClient();

    await expect(client.getClientCredentialsToken()).rejects.toThrow(
      'Failed to get Xero token with XERO_SCOPES: {"error":"invalid_scope"}',
    );
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it("authenticate() completes through the fallback chain for a connection without attachments", async () => {
    tokenEndpoint((scope) =>
      scope.split(" ").includes(ATTACHMENTS_SCOPE)
        ? refused(400, "invalid_scope")
        : token("token-v1"),
    );

    const client = await loadClient();

    await expect(client.authenticate()).resolves.toBeUndefined();
    expect(transport.post).toHaveBeenCalledTimes(3);
    expect(client.tenantId).toBe("SYNTHETIC-TENANT");
  });
});
