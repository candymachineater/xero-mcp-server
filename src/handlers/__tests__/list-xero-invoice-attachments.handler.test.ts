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
