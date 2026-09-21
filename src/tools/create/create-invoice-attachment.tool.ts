import { createXeroInvoiceAttachment } from "../../handlers/create-xero-invoice-attachment.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";
import { invoiceAttachmentUploadShape } from "../../helpers/invoice-attachment-input.js";

const CreateInvoiceAttachmentTool = CreateXeroTool(
  "create-invoice-attachment",
  "Attach a file to an existing invoice in Xero. \
 The file content must be supplied inline as base64 - this server runs on the connector host \
 and cannot read a local file path from the caller's machine. \
 If an attachment with the same file name already exists on the invoice, its contents are replaced. \
 This tool only adds files: it never changes an invoice's status, so a draft invoice stays a draft, \
 and it cannot authorise, send or pay an invoice.",
  invoiceAttachmentUploadShape,
  async ({ invoiceId, fileName, mimeType, content }) => {
    const result = await createXeroInvoiceAttachment(
      invoiceId,
      fileName,
      mimeType,
      content,
    );

    if (result.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error attaching file to invoice: ${result.error}`,
          },
        ],
      };
    }

    const attachment = result.result;

    return {
      content: [
        {
          type: "text" as const,
          text: [
            "Attachment uploaded successfully:",
            `Invoice ID: ${invoiceId}`,
            `File: ${attachment.fileName}`,
            attachment.attachmentID
              ? `Attachment ID: ${attachment.attachmentID}`
              : null,
            attachment.mimeType ? `Mime Type: ${attachment.mimeType}` : null,
            attachment.contentLength !== undefined
              ? `Size: ${attachment.contentLength} bytes`
              : null,
            attachment.url ? `Link to view: ${attachment.url}` : null,
            "The invoice status was not modified.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  },
);

export default CreateInvoiceAttachmentTool;
