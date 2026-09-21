import { z } from "zod";

/**
 * Maximum decoded attachment size this server will forward to Xero.
 *
 * NOTE ON PROVENANCE: Xero publishes a per-attachment ceiling in its
 * Accounting API documentation. That page is rendered client-side and could
 * not be retrieved from the environment this change was built in, so the
 * value below is a deliberately conservative server-side bound that this
 * project enforces on its own behalf - it is NOT a transcription of Xero's
 * published figure. Xero remains the authority: a payload under this bound
 * may still be rejected upstream, and that rejection is surfaced verbatim.
 * Kept as a single constant so raising it to the documented value, once
 * confirmed, is a one-line change.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB decoded

/**
 * Base64 inflates payloads by 4/3. Bounding the encoded string as well as the
 * decoded buffer means a mistaken or hostile caller cannot force a large
 * allocation before the size check runs.
 */
export const MAX_ATTACHMENT_BASE64_LENGTH =
  Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4;

const FILE_NAME_MAX_LENGTH = 255;

// type/subtype, per RFC 6838 restricted-name characters.
const MIME_TYPE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

const attachmentFileName = z
  .string()
  .min(1)
  .max(FILE_NAME_MAX_LENGTH)
  .refine(
    (value) => !/[\\/]/.test(value),
    "File name must not contain a path separator - pass a bare file name.",
  )
  .refine(
    (value) => !value.includes("\0"),
    "File name must not contain a null byte.",
  )
  .refine(
    (value) => !value.split(".").includes(".."),
    "File name must not contain a parent-directory segment.",
  )
  .refine(
    (value) => /\.[A-Za-z0-9]{1,16}$/.test(value),
    "File name must include a file extension, for example claims-progress.pdf",
  );

const attachmentMimeType = z
  .string()
  .min(1)
  .refine(
    (value) => MIME_TYPE_PATTERN.test(value),
    "Expected a type/subtype media type, for example application/pdf",
  );

const attachmentContent = z.string().min(1).max(MAX_ATTACHMENT_BASE64_LENGTH);

/**
 * Decode and bound-check base64 attachment content.
 *
 * Buffer.from(value, "base64") silently discards characters it does not
 * recognise, so a corrupt payload would otherwise be uploaded to Xero as
 * truncated-but-plausible bytes. Validate the alphabet and padding first.
 */
export function decodeAttachmentContent(value: string): Buffer {
  const compact = value.replace(/\s+/g, "");

  if (compact.length === 0) {
    throw new Error("Attachment content is empty.");
  }

  if (compact.length > MAX_ATTACHMENT_BASE64_LENGTH) {
    throw new Error(
      `Attachment content exceeds the maximum encoded length of ${MAX_ATTACHMENT_BASE64_LENGTH} characters.`,
    );
  }

  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error("Attachment content must be valid base64.");
  }

  const buffer = Buffer.from(compact, "base64");

  if (buffer.length === 0) {
    throw new Error("Attachment content is empty.");
  }

  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment is ${buffer.length} bytes, which exceeds the ${MAX_ATTACHMENT_BYTES} byte limit.`,
    );
  }

  return buffer;
}

/**
 * Tool schema shape for uploading an invoice attachment.
 *
 * Content is accepted inline as base64 rather than as a local file path: this
 * MCP server runs on the connector host, so a path supplied by a caller
 * refers to a filesystem the server cannot see.
 */
export const invoiceAttachmentUploadShape = {
  invoiceId: z
    .string()
    .min(1)
    .describe(
      "The ID of the invoice to attach the file to. Can be obtained from the list-invoices tool.",
    ),
  fileName: attachmentFileName.describe(
    "The file name to store the attachment under, including its extension. \
If an attachment with this name already exists on the invoice its contents are replaced.",
  ),
  mimeType: attachmentMimeType.describe(
    "The media type of the content, for example application/pdf or image/png.",
  ),
  content: attachmentContent.describe(
    `The file content, base64 encoded. This server runs on the connector host and cannot read \
the caller's local filesystem, so the bytes must be supplied inline. Maximum ${MAX_ATTACHMENT_BYTES} bytes once decoded.`,
  ),
};

export const invoiceAttachmentListShape = {
  invoiceId: z
    .string()
    .min(1)
    .describe(
      "The ID of the invoice to list attachments for. Can be obtained from the list-invoices tool.",
    ),
};
