import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { Attachment } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";

/**
 * List the files attached to an invoice.
 */
export async function listXeroInvoiceAttachments(
  invoiceId: string,
): Promise<XeroClientResponse<Attachment[]>> {
  try {
    if (!invoiceId) {
      throw new Error("Invoice ID is required.");
    }

    await xeroClient.authenticate();

    const response = await xeroClient.accountingApi.getInvoiceAttachments(
      xeroClient.tenantId,
      invoiceId, // invoiceID
      getClientHeaders(), // options
    );

    return {
      result: response.body.attachments ?? [],
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
