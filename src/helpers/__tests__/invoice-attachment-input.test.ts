import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  MAX_ATTACHMENT_BYTES,
  decodeAttachmentContent,
  invoiceAttachmentListShape,
  invoiceAttachmentUploadShape,
} from "../invoice-attachment-input.js";

const uploadSchema = z.object(invoiceAttachmentUploadShape);
const listSchema = z.object(invoiceAttachmentListShape);

const validInput = {
  invoiceId: "inv-1",
  fileName: "claims-progress.pdf",
  mimeType: "application/pdf",
  content: Buffer.from("%PDF-1.4 fake").toString("base64"),
};

describe("decodeAttachmentContent", () => {
  it("decodes valid base64 to the original bytes", () => {
    const bytes = Buffer.from("MPI claims progress");
    const decoded = decodeAttachmentContent(bytes.toString("base64"));
    expect(decoded.equals(bytes)).toBe(true);
  });

  it("tolerates line-wrapped base64", () => {
    const bytes = Buffer.alloc(300, 7);
    const wrapped =
      bytes.toString("base64").match(/.{1,76}/g)?.join("\n") ?? "";
    expect(decodeAttachmentContent(wrapped).equals(bytes)).toBe(true);
  });

  it("rejects content outside the base64 alphabet instead of silently truncating", () => {
    // Buffer.from would quietly drop "!!" and upload corrupt bytes.
    expect(() => decodeAttachmentContent("YWJj!!")).toThrow(
      "Attachment content must be valid base64.",
    );
  });

  it("rejects badly padded base64", () => {
    expect(() => decodeAttachmentContent("YWJjZA=")).toThrow(
      "Attachment content must be valid base64.",
    );
  });

  it("rejects empty content", () => {
    expect(() => decodeAttachmentContent("   ")).toThrow(
      "Attachment content is empty.",
    );
  });

  it("rejects content over the decoded size limit", () => {
    const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1);
    expect(() => decodeAttachmentContent(oversized.toString("base64"))).toThrow(
      /exceeds the \d+ byte limit/,
    );
  });

  it("accepts content exactly at the decoded size limit", () => {
    const atLimit = Buffer.alloc(MAX_ATTACHMENT_BYTES, 1);
    expect(decodeAttachmentContent(atLimit.toString("base64")).length).toBe(
      MAX_ATTACHMENT_BYTES,
    );
  });
});

describe("invoiceAttachmentUploadShape", () => {
  it("accepts a well-formed upload", () => {
    expect(uploadSchema.parse(validInput)).toMatchObject({
      invoiceId: "inv-1",
      fileName: "claims-progress.pdf",
    });
  });

  it.each([
    ["../../etc/passwd", "parent directory traversal"],
    ["reports/claims.pdf", "forward slash"],
    ["reports\\claims.pdf", "backslash"],
  ])("rejects file name %s (%s)", (fileName) => {
    expect(uploadSchema.safeParse({ ...validInput, fileName }).success).toBe(
      false,
    );
  });

  it("rejects a file name with no extension", () => {
    expect(
      uploadSchema.safeParse({ ...validInput, fileName: "claims" }).success,
    ).toBe(false);
  });

  it("rejects an empty file name", () => {
    expect(
      uploadSchema.safeParse({ ...validInput, fileName: "" }).success,
    ).toBe(false);
  });

  it("rejects a mime type that is not type/subtype", () => {
    expect(
      uploadSchema.safeParse({ ...validInput, mimeType: "pdf" }).success,
    ).toBe(false);
  });

  it("requires a mime type", () => {
    const withoutMimeType = {
      invoiceId: validInput.invoiceId,
      fileName: validInput.fileName,
      content: validInput.content,
    };
    expect(uploadSchema.safeParse(withoutMimeType).success).toBe(false);
  });

  it("requires an invoice id", () => {
    expect(
      uploadSchema.safeParse({ ...validInput, invoiceId: "" }).success,
    ).toBe(false);
  });

  it("requires content", () => {
    expect(uploadSchema.safeParse({ ...validInput, content: "" }).success).toBe(
      false,
    );
  });

  it("exposes no status, authorise, send or payment input", () => {
    const keys = Object.keys(invoiceAttachmentUploadShape);
    expect(keys).toEqual(["invoiceId", "fileName", "mimeType", "content"]);
    expect(
      keys.some((key) => /status|authoris|approve|send|email|pay/i.test(key)),
    ).toBe(false);
  });

  it("does not accept a local file path input", () => {
    // The server runs on the connector host, so a caller-side path is unusable.
    expect(Object.keys(invoiceAttachmentUploadShape)).not.toContain("path");
    expect(Object.keys(invoiceAttachmentUploadShape)).not.toContain("filePath");
  });
});

describe("invoiceAttachmentListShape", () => {
  it("accepts an invoice id", () => {
    expect(listSchema.parse({ invoiceId: "inv-1" })).toEqual({
      invoiceId: "inv-1",
    });
  });

  it("requires a non-empty invoice id", () => {
    expect(listSchema.safeParse({ invoiceId: "" }).success).toBe(false);
  });
});
