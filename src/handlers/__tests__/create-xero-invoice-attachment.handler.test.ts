import { describe, it, expect, vi, beforeEach } from "vitest";

// Fake only the SDK/transport seam: the real handler, validation and error
// shaping all run. Nothing here manufactures a successful result.
vi.mock("../../clients/xero-client.js", () => ({
  xeroClient: {
    tenantId: "tenant-123",
    authenticate: vi.fn(async () => {}),
    accountingApi: {
      getInvoiceAttachments: vi.fn(),
      createInvoiceAttachmentByFileName: vi.fn(),
      updateInvoiceAttachmentByFileName: vi.fn(),
      // Present so a test can prove the handler never touches the invoice.
      updateInvoice: vi.fn(),
      getInvoice: vi.fn(),
    },
  },
}));

import { xeroClient } from "../../clients/xero-client.js";
import { createXeroInvoiceAttachment } from "../create-xero-invoice-attachment.handler.js";
import { MAX_ATTACHMENT_BYTES } from "../../helpers/invoice-attachment-input.js";

const api = xeroClient.accountingApi as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;

const PDF = Buffer.from("%PDF-1.4 claims progress");
const CONTENT = PDF.toString("base64");

function attachmentResponse(fileName = "claims-progress.pdf") {
  return {
    body: {
      attachments: [
        {
          attachmentID: "att-1",
          fileName,
          mimeType: "application/pdf",
          contentLength: PDF.length,
          url: "https://api.xero.com/files/att-1",
        },
      ],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (xeroClient.authenticate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    undefined,
  );
  api.getInvoiceAttachments.mockResolvedValue({ body: { attachments: [] } });
  api.createInvoiceAttachmentByFileName.mockResolvedValue(
    attachmentResponse(),
  );
  api.updateInvoiceAttachmentByFileName.mockResolvedValue(
    attachmentResponse(),
  );
});

describe("createXeroInvoiceAttachment", () => {
  describe("successful upload", () => {
    it("creates a new attachment and returns it", async () => {
      const result = await createXeroInvoiceAttachment(
        "inv-1",
        "claims-progress.pdf",
        "application/pdf",
        CONTENT,
      );

      expect(result.isError).toBe(false);
      expect(result.result).toMatchObject({
        attachmentID: "att-1",
        fileName: "claims-progress.pdf",
      });
      expect(api.createInvoiceAttachmentByFileName).toHaveBeenCalledTimes(1);
      expect(api.updateInvoiceAttachmentByFileName).not.toHaveBeenCalled();
    });

    it("sends the tenant, invoice, file name and decoded bytes to the SDK", async () => {
      await createXeroInvoiceAttachment(
        "inv-1",
        "claims-progress.pdf",
        "application/pdf",
        CONTENT,
      );

      const args = api.createInvoiceAttachmentByFileName.mock.calls[0];
      expect(args[0]).toBe("tenant-123");
      expect(args[1]).toBe("inv-1");
      expect(args[2]).toBe("claims-progress.pdf");
      expect(Buffer.isBuffer(args[3])).toBe(true);
      expect((args[3] as Buffer).equals(PDF)).toBe(true);
    });

    it("passes the caller's mime type as Content-Type, which the SDK does not set itself", async () => {
      await createXeroInvoiceAttachment(
        "inv-1",
        "claims-progress.pdf",
        "application/pdf",
        CONTENT,
      );

      const options = api.createInvoiceAttachmentByFileName.mock.calls[0][6] as {
        headers: Record<string, string>;
      };
      expect(options.headers["Content-Type"]).toBe("application/pdf");
      expect(options.headers["user-agent"]).toMatch(/^xero-mcp-server-/);
    });

    it("never opts the file into the online invoice", async () => {
      await createXeroInvoiceAttachment(
        "inv-1",
        "claims-progress.pdf",
        "application/pdf",
        CONTENT,
      );

      // includeOnline argument
      expect(api.createInvoiceAttachmentByFileName.mock.calls[0][4]).toBeUndefined();
    });

    it("replaces an existing attachment with the same file name", async () => {
      api.getInvoiceAttachments.mockResolvedValue({
        body: { attachments: [{ fileName: "claims-progress.pdf" }] },
      });

      const result = await createXeroInvoiceAttachment(
        "inv-1",
        "claims-progress.pdf",
        "application/pdf",
        CONTENT,
      );

      expect(result.isError).toBe(false);
      expect(api.updateInvoiceAttachmentByFileName).toHaveBeenCalledTimes(1);
      expect(api.createInvoiceAttachmentByFileName).not.toHaveBeenCalled();
    });

    it("creates rather than replaces when a different file name exists", async () => {
      api.getInvoiceAttachments.mockResolvedValue({
        body: { attachments: [{ fileName: "something-else.pdf" }] },
      });

      await createXeroInvoiceAttachment(
        "inv-1",
        "claims-progress.pdf",
        "application/pdf",
        CONTENT,
      );

      expect(api.createInvoiceAttachmentByFileName).toHaveBeenCalledTimes(1);
      expect(api.updateInvoiceAttachmentByFileName).not.toHaveBeenCalled();
    });
  });

  describe("no invoice mutation", () => {
    it("never sends a status, authorise, send or payment field", async () => {
      await createXeroInvoiceAttachment(
        "inv-1",
        "claims-progress.pdf",
        "application/pdf",
        CONTENT,
      );

      expect(api.updateInvoice).not.toHaveBeenCalled();

      const args = api.createInvoiceAttachmentByFileName.mock.calls[0];
      const nonBinaryArgs = args.filter((arg) => !Buffer.isBuffer(arg));
      const serialised = JSON.stringify(nonBinaryArgs);

      expect(serialised).not.toMatch(/status/i);
      expect(serialised).not.toMatch(/authoris/i);
      expect(serialised).not.toMatch(/\bsend\b/i);
      expect(serialised).not.toMatch(/payment/i);
      expect(serialised).not.toMatch(/AUTHORISED|SUBMITTED|PAID|VOIDED/);
    });

    it("does not delete or void anything", async () => {
      await createXeroInvoiceAttachment(
        "inv-1",
        "claims-progress.pdf",
        "application/pdf",
        CONTENT,
      );

      const called = Object.entries(api)
        .filter(([, fn]) => fn.mock.calls.length > 0)
        .map(([name]) => name)
        .sort();

      expect(called).toEqual([
        "createInvoiceAttachmentByFileName",
        "getInvoiceAttachments",
      ]);
    });
  });

  describe("invalid input", () => {
    it("rejects a missing invoice id before authenticating", async () => {
      const result = await createXeroInvoiceAttachment(
        "",
        "claims-progress.pdf",
        "application/pdf",
        CONTENT,
      );

      expect(result.isError).toBe(true);
      expect(result.error).toBe("Invoice ID is required.");
      expect(xeroClient.authenticate).not.toHaveBeenCalled();
      expect(api.createInvoiceAttachmentByFileName).not.toHaveBeenCalled();
    });

    it("rejects a missing file name", async () => {
      const result = await createXeroInvoiceAttachment(
        "inv-1",
        "",
        "application/pdf",
        CONTENT,
      );

      expect(result.isError).toBe(true);
      expect(result.error).toBe("File name is required.");
      expect(api.createInvoiceAttachmentByFileName).not.toHaveBeenCalled();
    });

    it("rejects a missing mime type", async () => {
      const result = await createXeroInvoiceAttachment(
        "inv-1",
        "claims-progress.pdf",
        "",
        CONTENT,
      );

      expect(result.isError).toBe(true);
      expect(result.error).toBe("Mime type is required.");
      expect(api.createInvoiceAttachmentByFileName).not.toHaveBeenCalled();
    });

    it("rejects oversized content without calling Xero", async () => {
      const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1).toString(
        "base64",
      );

      const result = await createXeroInvoiceAttachment(
        "inv-1",
        "claims-progress.pdf",
        "application/pdf",
        oversized,
      );

      expect(result.isError).toBe(true);
      expect(result.error).toMatch(/exceeds the \d+ byte limit/);
      expect(xeroClient.authenticate).not.toHaveBeenCalled();
      expect(api.createInvoiceAttachmentByFileName).not.toHaveBeenCalled();
    });

    it("rejects malformed base64 without calling Xero", async () => {
      const result = await createXeroInvoiceAttachment(
        "inv-1",
        "claims-progress.pdf",
        "application/pdf",
        "not base64!!",
      );

      expect(result.isError).toBe(true);
      expect(result.error).toBe("Attachment content must be valid base64.");
      expect(api.createInvoiceAttachmentByFileName).not.toHaveBeenCalled();
    });
  });

  describe("SDK error propagation", () => {
    it("maps a 404 from the upload to the standard not-found message", async () => {
      api.createInvoiceAttachmentByFileName.mockRejectedValue({
        response: { statusCode: 404, body: {} },
        request: { headers: { authorization: "Bearer eyJSECRET" } },
      });

      const result = await createXeroInvoiceAttachment(
        "missing-invoice",
        "claims-progress.pdf",
        "application/pdf",
        CONTENT,
      );

      expect(result.isError).toBe(true);
      expect(result.result).toBeNull();
      expect(result.error).toBe(
        "The requested resource was not found in Xero.",
      );
      expect(result.error).not.toContain("Bearer");
      expect(result.error).not.toContain("eyJSECRET");
    });

    it("propagates a validation detail from Xero", async () => {
      api.createInvoiceAttachmentByFileName.mockRejectedValue({
        response: {
          statusCode: 400,
          body: {
            httpStatusCode: "BadRequest",
            problem: {
              title: "BadRequest",
              detail: "The file size exceeds the maximum allowed.",
            },
          },
        },
      });

      const result = await createXeroInvoiceAttachment(
        "inv-1",
        "claims-progress.pdf",
        "application/pdf",
        CONTENT,
      );

      expect(result.isError).toBe(true);
      expect(result.error).toBe(
        "400 BadRequest: The file size exceeds the maximum allowed.",
      );
    });

    it("propagates an error raised while listing existing attachments", async () => {
      api.getInvoiceAttachments.mockRejectedValue({
        response: { statusCode: 401, body: {} },
      });

      const result = await createXeroInvoiceAttachment(
        "inv-1",
        "claims-progress.pdf",
        "application/pdf",
        CONTENT,
      );

      expect(result.isError).toBe(true);
      expect(result.error).toBe(
        "Authentication failed. Please check your Xero credentials.",
      );
      expect(api.createInvoiceAttachmentByFileName).not.toHaveBeenCalled();
    });

    it("reports a response that carries no attachment", async () => {
      api.createInvoiceAttachmentByFileName.mockResolvedValue({
        body: { attachments: [] },
      });

      const result = await createXeroInvoiceAttachment(
        "inv-1",
        "claims-progress.pdf",
        "application/pdf",
        CONTENT,
      );

      expect(result.isError).toBe(true);
      expect(result.error).toBe("Attachment upload failed.");
    });
  });
});
