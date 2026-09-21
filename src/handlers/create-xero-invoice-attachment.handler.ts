import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { Attachment } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import { decodeAttachmentContent } from "../helpers/invoice-attachment-input.js";

/**
 * The generated xero-node client never sets a Content-Type for attachment
 * uploads; it merges `options.headers` over its own defaults instead. The
 * caller's media type therefore has to travel on the request options or Xero
 * stores the file with the wrong type.
 */
function attachmentRequestOptions(mimeType: string): {
  headers: { [name: string]: string };
} {
  return {
    headers: {
      ...getClientHeaders().headers,
      "Content-Type": mimeType,
    },
  };
}

async function getExistingFileNames(invoiceId: string): Promise<string[]> {
  const response = await xeroClient.accountingApi.getInvoiceAttachments(
    xeroClient.tenantId,
    invoiceId, // invoiceID
    getClientHeaders(), // options
  );

  return (response.body.attachments ?? [])
    .map((attachment) => attachment.fileName)
    .filter((fileName): fileName is string => typeof fileName === "string");
}

/**
 * Upload a file to an existing invoice, replacing it if the file name is
 * already in use.
 *
 * Xero creates attachments with PUT and replaces them with POST, and creating
 * over an existing file name fails. Deciding between the two from the current
 * attachment list makes the tool idempotent by file name.
 *
 * This never sends invoice fields. Attaching a file does not transition an
 * invoice, so a DRAFT invoice stays DRAFT.
 */
export async function createXeroInvoiceAttachment(
  invoiceId: string,
  fileName: string,
  mimeType: string,
  content: string,
): Promise<XeroClientResponse<Attachment>> {
  try {
    if (!invoiceId) {
      throw new Error("Invoice ID is required.");
    }

    if (!fileName) {
      throw new Error("File name is required.");
    }

    if (!mimeType) {
      throw new Error("Mime type is required.");
    }

    // Validate before authenticating so bad input costs no API call.
    const body = decodeAttachmentContent(content);

    await xeroClient.authenticate();

    const existingFileNames = await getExistingFileNames(invoiceId);
    const replacing = existingFileNames.includes(fileName);

    const response = replacing
      ? await xeroClient.accountingApi.updateInvoiceAttachmentByFileName(
          xeroClient.tenantId,
          invoiceId, // invoiceID
          fileName, // fileName
          body, // body
          undefined, // idempotencyKey
          attachmentRequestOptions(mimeType), // options
        )
      : await xeroClient.accountingApi.createInvoiceAttachmentByFileName(
          xeroClient.tenantId,
          invoiceId, // invoiceID
          fileName, // fileName
          body, // body
          undefined, // includeOnline - never surface the file on the online invoice
          undefined, // idempotencyKey
          attachmentRequestOptions(mimeType), // options
        );

    const attachment = response.body.attachments?.[0];

    if (!attachment) {
      throw new Error("Attachment upload failed.");
    }

    return {
      result: attachment,
      isError: false,
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
