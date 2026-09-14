import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Synthetic dependencies only: no real Xero client/auth module or SDK constructor.
const fake = vi.hoisted(() => ({
  loads: 0,
  deepLinkLoads: 0,
  auth: vi.fn(),
  write: vi.fn(),
  headers: vi.fn(() => ({})),
  link: vi.fn(async () => "https://example.invalid/synthetic"),
}));
vi.mock("../../clients/xero-client.js", () => {
  fake.loads++;
  return {
    xeroClient: {
      tenantId: "SYNTHETIC",
      authenticate: fake.auth,
      accountingApi: { createInvoices: fake.write },
    },
  };
});
vi.mock("xero-node", () => ({
  Invoice: {
    TypeEnum: { ACCREC: "ACCREC", ACCPAY: "ACCPAY" },
    StatusEnum: { DRAFT: "DRAFT" },
  },
}));
vi.mock("../../helpers/get-client-headers.js", () => ({
  getClientHeaders: fake.headers,
}));
vi.mock("../../helpers/get-deeplink.js", () => {
  fake.deepLinkLoads++;
  return {
    DeepLinkType: { INVOICE: "INVOICE", BILL: "BILL" },
    getDeepLink: fake.link,
  };
});
const base = {
  contactId: "SYNTHETIC-CONTACT",
  type: "ACCREC",
  reference: "SYNTHETIC",
  date: "2026-09-15",
  lineItems: [
    {
      description: "Synthetic line one\nSynthetic line two",
      quantity: 2,
      unitAmount: 12.34,
      accountCode: "SYNTHETIC",
      taxType: "SYNTHETIC",
      itemCode: "SYNTHETIC",
      tracking: [
        {
          name: "SYNTHETIC",
          option: "SYNTHETIC",
          trackingCategoryID: "SYNTHETIC",
        },
      ],
    },
  ],
};
const invalid = [
  ...[
    "AUTHORISED",
    "SUBMITTED",
    "PAID",
    "DELETED",
    "VOIDED",
    "draft",
    "DRAFT\n",
    null,
    1,
  ].map((status) => ({ status })),
  ...[
    "2026-02-30",
    "2025-02-29",
    "1900-02-29",
    "2026-04-31",
    "0000-01-01",
    "2026-00-10",
    "2026-13-01",
    "2026-09-00",
    "2026-9-15",
    "2026-09-15T00:00:00Z",
    "2026-09-15\n",
    "2026-09-15\r\n",
    " 2026-09-15",
    "",
    null,
    14,
  ].map((dueDate) => ({ dueDate })),
];
let client: Client;
let server: McpServer;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  fake.loads = 0;
  fake.deepLinkLoads = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-15T04:05:00Z"));
  fake.write.mockImplementation(async (_tenant, payload) => ({
    body: { invoices: payload.invoices },
  }));
  const tool = (await import("./create-invoice.tool.js")).default();
  server = new McpServer({ name: "synthetic-test", version: "1" });
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.schema },
    tool.handler,
  );
  client = new Client({ name: "synthetic-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
});
afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.useRealTimers();
});
function sent() {
  expect(fake.write).toHaveBeenCalledTimes(1);
  return fake.write.mock.calls[0][1].invoices[0];
}
function untouched() {
  expect(fake.loads).toBe(0);
  expect(fake.deepLinkLoads).toBe(0);
  expect(fake.auth).not.toHaveBeenCalled();
  expect(fake.headers).not.toHaveBeenCalled();
  expect(fake.link).not.toHaveBeenCalled();
  expect(fake.write).not.toHaveBeenCalled();
}
async function create(args: Record<string, unknown>) {
  return client.callTool({ name: "create-invoice", arguments: args });
}
async function direct(controls: unknown) {
  const { createXeroInvoice } =
    await import("../../handlers/create-xero-invoice.handler.js");
  return Reflect.apply(createXeroInvoice, undefined, [
    base.contactId,
    base.lineItems,
    base.type,
    base.reference,
    base.date,
    controls,
  ]);
}
describe("create-invoice actual MCP schema, callback and SDK payload", () => {
  it("publishes optional DRAFT-only status and date-only dueDate in tools/list without loading a client", async () => {
    const { tools } = await client.listTools();
    const s = tools[0].inputSchema;
    expect(Object.keys(s.properties!)).toEqual([
      "contactId",
      "lineItems",
      "type",
      "reference",
      "date",
      "status",
      "dueDate",
    ]);
    expect(s.required).toEqual(["contactId", "lineItems", "type"]);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties!.status).toMatchObject({
      type: "string",
      const: "DRAFT",
    });
    expect(s.properties!.dueDate).toMatchObject({
      type: "string",
      minLength: 10,
      maxLength: 10,
    });
    untouched();
  });
  it("accepts the explicit controls in generated JSON Schema and rejects unsafe status/timestamps/newlines/null", async () => {
    const { tools } = await client.listTools();
    const validate = new AjvJsonSchemaValidator().getValidator(
      tools[0].inputSchema,
    );
    expect(
      validate({ ...base, status: "DRAFT", dueDate: "2026-10-06" }).valid,
    ).toBe(true);
    for (const controls of [
      { status: "AUTHORISED" },
      { status: null },
      { dueDate: null },
      { dueDate: "2026-09-15\n" },
      { dueDate: "2026-09-15T00:00:00Z" },
    ]) {
      expect(validate({ ...base, ...controls }).valid).toBe(false);
    }
    untouched();
  });
  it.each(["ACCREC", "ACCPAY"])(
    "forwards explicit draft/date in the only %s write",
    async (type) => {
      fake.write.mockImplementationOnce(async (_tenant, payload) => ({
        body: {
          invoices: [
            { ...payload.invoices[0], invoiceID: "SYNTHETIC-INVOICE" },
          ],
        },
      }));
      const r = await create({
        ...base,
        type,
        status: "DRAFT",
        dueDate: "2026-10-06",
      });
      expect(r.isError).not.toBe(true);
      expect(sent()).toMatchObject({
        type,
        status: "DRAFT",
        dueDate: "2026-10-06",
        date: base.date,
      });
      expect(fake.auth).toHaveBeenCalledTimes(1);
      expect(fake.headers).toHaveBeenCalledTimes(1);
      expect(fake.link).toHaveBeenCalledWith(
        type === "ACCREC" ? "INVOICE" : "BILL",
        "SYNTHETIC-INVOICE",
      );
      expect(fake.auth.mock.invocationCallOrder[0]).toBeLessThan(
        fake.write.mock.invocationCallOrder[0],
      );
      expect(fake.write.mock.invocationCallOrder[0]).toBeLessThan(
        fake.link.mock.invocationCallOrder[0],
      );
      expect(JSON.stringify(r.content)).toContain("Due date: 2026-10-06");
      expect(sent()).not.toHaveProperty("sentToContact");
    },
  );
  it("rejects invalid controls through the MCP runtime before client/auth/write", async () => {
    for (const controls of invalid) {
      expect(
        (await create({ ...base, ...controls })).isError,
        JSON.stringify(controls),
      ).toBe(true);
      untouched();
    }
  });
  it("rejects invalid controls through the public handler before client/auth/write", async () => {
    for (const controls of [
      ...invalid,
      null,
      { status: "DRAFT", dueDate: "2026-02-30" },
    ]) {
      expect((await direct(controls)).isError, JSON.stringify(controls)).toBe(
        true,
      );
      untouched();
    }
  });
  it.each(["ACCREC", "ACCPAY"])(
    "preserves the complete omitted-control %s payload and SDK options",
    async (type) => {
      await create({ ...base, type });
      expect(fake.write.mock.calls).toEqual([
        [
          "SYNTHETIC",
          {
            invoices: [
              {
                type,
                contact: { contactID: base.contactId },
                lineItems: base.lineItems,
                date: base.date,
                dueDate: "2026-10-15",
                ...(type === "ACCPAY"
                  ? { invoiceNumber: base.reference }
                  : { reference: base.reference }),
                status: "DRAFT",
              },
            ],
          },
          true,
          undefined,
          undefined,
          {},
        ],
      ]);
    },
  );
  it("preserves omitted date/reference and historical invoice-date behavior", async () => {
    vi.setSystemTime(new Date("2026-09-15T13:30:00Z")); // NZ already September 16.
    const args: Record<string, unknown> = { ...base };
    delete args.date;
    delete args.reference;
    await create(args);
    expect(sent()).toMatchObject({
      date: "2026-09-15",
      dueDate: "2026-10-15",
      status: "DRAFT",
    });
    expect(Object.hasOwn(sent(), "reference")).toBe(true);
    expect(sent().reference).toBeUndefined();
    fake.write.mockClear();
    await create({ ...base, date: "2020-01-01" });
    expect(sent()).toMatchObject({ date: "2020-01-01", dueDate: "2026-10-15" });
  });
  it("preserves legacy date validation and lower-handler default type", async () => {
    await create({ ...base, date: "LEGACY\nDATE" });
    expect(sent().date).toBe("LEGACY\nDATE");
    fake.write.mockClear();
    const { createXeroInvoice } =
      await import("../../handlers/create-xero-invoice.handler.js");
    await createXeroInvoice(base.contactId, base.lineItems);
    expect(sent().type).toBe("ACCREC");
  });
  it("keeps DRAFT with only explicit dueDate", async () => {
    await create({ ...base, dueDate: "2026-09-22" });
    expect(sent()).toMatchObject({ dueDate: "2026-09-22", status: "DRAFT" });
  });
  it("keeps the legacy dueDate with only explicit DRAFT", async () => {
    await create({ ...base, status: "DRAFT" });
    expect(sent()).toMatchObject({ dueDate: "2026-10-15", status: "DRAFT" });
  });
  it("preserves chosen calendar dates across month/year/leap/NZ DST and UTC boundaries without calculating terms", async () => {
    // Explicit date choices, NOT a working-day calendar calculation.
    const cases = [
      ["2026-01-28", "2026-02-04", "2026-01-28T13:30:00Z"],
      ["2026-12-28", "2027-01-04", "2026-12-28T13:30:00Z"],
      ["2028-02-22", "2028-02-29", "2028-02-22T13:30:00Z"],
      ["2026-09-24", "2026-10-01", "2026-09-26T14:30:00Z"],
      ["2026-04-02", "2026-04-09", "2026-04-04T14:30:00Z"],
      ["2000-02-22", "2000-02-29", "2000-02-22T13:30:00Z"],
      ["0001-01-01", "0001-01-01", "2026-09-15T13:30:00Z"],
      ["9999-12-31", "9999-12-31", "2026-09-15T13:30:00Z"],
    ];
    for (const [date, dueDate, now] of cases) {
      fake.write.mockClear();
      vi.setSystemTime(new Date(now));
      await create({ ...base, date, dueDate, status: "DRAFT" });
      expect(sent()).toMatchObject({ date, dueDate, status: "DRAFT" });
    }
  });
  it("also guards direct callback invocation bypassing the MCP parser", async () => {
    const tool = (await import("./create-invoice.tool.js")).default();
    const r = await Reflect.apply(tool.handler, undefined, [
      { ...base, status: "AUTHORISED" },
      {},
    ]);
    expect(JSON.stringify(r.content)).toContain("Error creating invoice:");
    untouched();
  });
});
