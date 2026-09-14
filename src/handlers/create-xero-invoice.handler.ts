import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { Invoice, LineItemTracking } from "xero-node";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import { invoiceCreateControlsSchema, InvoiceCreateControls } from "../helpers/invoice-create-controls.js";

interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitAmount: number;
  accountCode: string;
  taxType: string;
  itemCode?: string;
  tracking?: LineItemTracking[];
}

async function createInvoice(
  contactId: string,
  lineItems: InvoiceLineItem[],
  type: Invoice.TypeEnum,
  reference: string | undefined,
  date: string | undefined,
  controls: InvoiceCreateControls,
): Promise<Invoice | undefined> {
  const { xeroClient } = await import("../clients/xero-client.js");
  await xeroClient.authenticate();

  const invoice: Invoice = {
    type: type,
    contact: {
      contactID: contactId,
    },
    lineItems: lineItems,
    date: date || new Date().toISOString().split("T")[0], // Use provided date or today's date
    dueDate: controls.dueDate ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0], // 30 days from now
    ...(type === Invoice.TypeEnum.ACCPAY
      ? { invoiceNumber: reference }
      : { reference: reference }),
    status: Invoice.StatusEnum.DRAFT,
  };

  const response = await xeroClient.accountingApi.createInvoices(
    xeroClient.tenantId,
    {
      invoices: [invoice],
    }, // invoices
    true, //summarizeErrors
    undefined, //unitdp
    undefined, //idempotencyKey
    getClientHeaders(),
  );
  const createdInvoice = response.body.invoices?.[0];
  return createdInvoice;
}

/**
 * Create a new invoice in Xero
 */
export async function createXeroInvoice(
  contactId: string,
  lineItems: InvoiceLineItem[],
  type: Invoice.TypeEnum = Invoice.TypeEnum.ACCREC,
  reference?: string,
  date?: string,
  controls: InvoiceCreateControls = {},
): Promise<XeroClientResponse<Invoice>> {
  try {
    // Public callers may bypass the MCP schema. Validate before loading the client.
    const parsedControls = invoiceCreateControlsSchema.parse(controls);
    const createdInvoice = await createInvoice(
      contactId,
      lineItems,
      type,
      reference,
      date,
      parsedControls,
    );

    if (!createdInvoice) {
      throw new Error("Invoice creation failed.");
    }

    return {
      result: createdInvoice,
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
