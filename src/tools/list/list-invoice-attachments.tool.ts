import { listXeroInvoiceAttachments } from "../../handlers/list-xero-invoice-attachments.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";
import { invoiceAttachmentListShape } from "../../helpers/invoice-attachment-input.js";

const ListInvoiceAttachmentsTool = CreateXeroTool(
  "list-invoice-attachments",
  "List the files attached to an invoice in Xero. \
 Use this to check which attachments an invoice already has, \
 for example before uploading a file with the create-invoice-attachment tool.",
  invoiceAttachmentListShape,
  async ({ invoiceId }) => {
    const response = await listXeroInvoiceAttachments(invoiceId);

    if (response.error !== null) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error listing invoice attachments: ${response.error}`,
          },
        ],
      };
    }

    const attachments = response.result;

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${attachments.length} attachments on invoice ${invoiceId}:`,
        },
        ...attachments.map((attachment) => ({
          type: "text" as const,
          text: [
            `File: ${attachment.fileName}`,
            attachment.attachmentID
              ? `Attachment ID: ${attachment.attachmentID}`
              : null,
            attachment.mimeType ? `Mime Type: ${attachment.mimeType}` : null,
            attachment.contentLength !== undefined
              ? `Size: ${attachment.contentLength} bytes`
              : null,
            attachment.includeOnline !== undefined
              ? `Included On Online Invoice: ${attachment.includeOnline}`
              : null,
            attachment.url ? `Link to view: ${attachment.url}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        })),
      ],
    };
  },
);

export default ListInvoiceAttachmentsTool;
