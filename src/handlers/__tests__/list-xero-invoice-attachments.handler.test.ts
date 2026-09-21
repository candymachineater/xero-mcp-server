import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../clients/xero-client.js", () => ({
  xeroClient: {
    tenantId: "tenant-123",
    authenticate: vi.fn(async () => {}),
    accountingApi: {
      getInvoiceAttachments: vi.fn(),
      updateInvoice: vi.fn(),
    },
  },
}));

import { xeroClient } from "../../clients/xero-client.js";
import { listXeroInvoiceAttachments } from "../list-xero-invoice-attachments.handler.js";

const api = xeroClient.accountingApi as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;

beforeEach(() => {
  vi.clearAllMocks();
  (xeroClient.authenticate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    undefined,
  );
});

describe("listXeroInvoiceAttachments", () => {
  it("returns the attachments on an invoice", async () => {
    api.getInvoiceAttachments.mockResolvedValue({
      body: {
        attachments: [
          { attachmentID: "att-1", fileName: "claims-progress.pdf" },
          { attachmentID: "att-2", fileName: "site-photo.png" },
        ],
      },
    });

    const result = await listXeroInvoiceAttachments("inv-1");

    expect(result.isError).toBe(false);
    expect(result.result).toHaveLength(2);
    expect(result.result?.[0].fileName).toBe("claims-progress.pdf");
  });

  it("passes the tenant and invoice id to the SDK", async () => {
    api.getInvoiceAttachments.mockResolvedValue({ body: { attachments: [] } });

    await listXeroInvoiceAttachments("inv-1");

    const args = api.getInvoiceAttachments.mock.calls[0];
    expect(args[0]).toBe("tenant-123");
    expect(args[1]).toBe("inv-1");
  });

  it("returns an empty list when Xero omits the attachments field", async () => {
    api.getInvoiceAttachments.mockResolvedValue({ body: {} });

    const result = await listXeroInvoiceAttachments("inv-1");

    expect(result.isError).toBe(false);
    expect(result.result).toEqual([]);
  });

  it("rejects a missing invoice id before authenticating", async () => {
    const result = await listXeroInvoiceAttachments("");

    expect(result.isError).toBe(true);
    expect(result.error).toBe("Invoice ID is required.");
    expect(xeroClient.authenticate).not.toHaveBeenCalled();
    expect(api.getInvoiceAttachments).not.toHaveBeenCalled();
  });

  it("propagates an SDK error without leaking the bearer token", async () => {
    api.getInvoiceAttachments.mockRejectedValue({
      response: { statusCode: 403, body: {} },
      request: { headers: { authorization: "Bearer eyJSECRET" } },
    });

    const result = await listXeroInvoiceAttachments("inv-1");

    expect(result.isError).toBe(true);
    expect(result.result).toBeNull();
    expect(result.error).toBe(
      "You don't have permission to access this resource in Xero.",
    );
    expect(result.error).not.toContain("eyJSECRET");
  });

  it("never mutates the invoice", async () => {
    api.getInvoiceAttachments.mockResolvedValue({ body: { attachments: [] } });

    await listXeroInvoiceAttachments("inv-1");

    expect(api.updateInvoice).not.toHaveBeenCalled();
  });
});

/**
 * The live failure this covers: xero-node 13.3.0 rejects a failed Accounting
 * API call with `JSON.stringify(new ApiError(axiosError).generateError())`,
 * which is a string. That reached the caller as a bare
 * "An unexpected error occurred while communicating with Xero." with no status
 * and no Xero explanation.
 */
function sdkRejection(status: number, body: unknown): string {
  return JSON.stringify({
    response: {
      statusCode: status,
      body,
      headers: { "set-cookie": "ak_bmsc=COOKIE_SECRET; path=/" },
      request: {
        url: {
          protocol: "https:",
          port: 443,
          host: "api.xero.com",
          path: "/api.xro/2.0/Invoices/inv-1/Attachments",
        },
        headers: {
          authorization: "Bearer eyJSECRETTOKEN.payload.signature",
          "xero-tenant-id": "tenant-123",
        },
        method: "GET",
      },
    },
    body,
  });
}

describe("listXeroInvoiceAttachments error surfacing", () => {
  it("reports the HTTP status and Xero error body from the SDK's stringified rejection", async () => {
    api.getInvoiceAttachments.mockRejectedValue(
      sdkRejection(403, {
        Title: "Forbidden",
        Detail: "AuthorizationUnsuccessful",
      }),
    );

    const result = await listXeroInvoiceAttachments("inv-1");

    expect(result.isError).toBe(true);
    expect(result.result).toBeNull();
    expect(result.error).toBe("403 Forbidden: AuthorizationUnsuccessful");
  });

  it("leaks no credential or header material from that rejection", async () => {
    api.getInvoiceAttachments.mockRejectedValue(
      sdkRejection(403, { Detail: "AuthorizationUnsuccessful" }),
    );

    const result = await listXeroInvoiceAttachments("inv-1");

    expect(result.error).not.toContain("Bearer");
    expect(result.error).not.toContain("eyJSECRETTOKEN");
    expect(result.error).not.toContain("set-cookie");
    expect(result.error).not.toContain("COOKIE_SECRET");
    expect(result.error).not.toContain("tenant-123");
  });

  it("degrades safely when the rejection carries no HTTP response", async () => {
    api.getInvoiceAttachments.mockRejectedValue("socket hang up");

    const result = await listXeroInvoiceAttachments("inv-1");

    expect(result.isError).toBe(true);
    expect(result.error).toBe(
      "An unexpected error occurred while communicating with Xero.",
    );
  });

  it("still reports a plain Error message unchanged", async () => {
    api.getInvoiceAttachments.mockRejectedValue(
      new Error("Required parameter xeroTenantId was null or undefined"),
    );

    const result = await listXeroInvoiceAttachments("inv-1");

    expect(result.isError).toBe(true);
    expect(result.error).toBe(
      "Required parameter xeroTenantId was null or undefined",
    );
  });
});
