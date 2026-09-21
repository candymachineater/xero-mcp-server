import { describe, it, expect } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import { formatError } from "../format-error.js";

function makeAxiosError(status: number, detail?: string): AxiosError {
  const headers = new AxiosHeaders();
  const config = { headers };
  const err = new AxiosError(
    "Request failed",
    String(status),
    config as never,
    null,
    {
      status,
      data: detail ? { Detail: detail } : {},
      statusText: "",
      headers: {},
      config,
    } as never,
  );
  return err;
}

describe("formatError", () => {
  describe("AxiosError mapping", () => {
    it("maps 401 to authentication message", () => {
      expect(formatError(makeAxiosError(401))).toBe(
        "Authentication failed. Please check your Xero credentials.",
      );
    });

    it("maps 403 to permission message", () => {
      expect(formatError(makeAxiosError(403))).toBe(
        "You don't have permission to access this resource in Xero.",
      );
    });

    it("maps 404 to not-found message", () => {
      expect(formatError(makeAxiosError(404))).toBe(
        "The requested resource was not found in Xero.",
      );
    });

    it("maps 429 to rate-limit message", () => {
      expect(formatError(makeAxiosError(429))).toBe(
        "Too many requests to Xero. Please try again in a moment.",
      );
    });

    it("returns response.data.Detail for non-mapped statuses", () => {
      expect(formatError(makeAxiosError(400, "Field is required"))).toBe(
        "Field is required",
      );
    });

    it("returns generic message when no Detail is provided", () => {
      expect(formatError(makeAxiosError(500))).toBe(
        "An error occurred while communicating with Xero.",
      );
    });
  });

  describe("xero-node SDK error shape", () => {
    it("extracts problem.detail and title without leaking request headers", () => {
      const sdkError = {
        response: {
          statusCode: 405,
          body: {
            httpStatusCode: "MethodNotAllowed",
            problem: {
              title: "MethodNotAllowed",
              detail: "Method not allowed for the current customer jurisdiction.",
              status: 405,
            },
          },
          headers: { "set-cookie": "ak_bmsc=secret" },
        },
        request: {
          headers: { authorization: "Bearer eyJSECRET" },
        },
      };

      const result = formatError(sdkError);

      expect(result).toBe(
        "405 MethodNotAllowed: Method not allowed for the current customer jurisdiction.",
      );
      expect(result).not.toContain("Bearer");
      expect(result).not.toContain("eyJSECRET");
      expect(result).not.toContain("set-cookie");
    });

    it("maps 401 SDK error to the standard auth message", () => {
      const sdkError = {
        response: { statusCode: 401, body: {} },
        request: { headers: { authorization: "Bearer leaky" } },
      };

      const result = formatError(sdkError);
      expect(result).toBe(
        "Authentication failed. Please check your Xero credentials.",
      );
      expect(result).not.toContain("Bearer");
    });

    it("falls back to status code + title when detail is missing", () => {
      const sdkError = {
        response: {
          statusCode: 502,
          body: { httpStatusCode: "BadGateway" },
        },
      };

      expect(formatError(sdkError)).toBe("502 BadGateway");
    });

    it("falls back to a generic title when neither problem nor httpStatusCode is present", () => {
      const sdkError = { response: { statusCode: 502 } };
      expect(formatError(sdkError)).toBe("502 HTTP error");
    });
  });

  describe("plain Error", () => {
    it("returns the error message", () => {
      expect(formatError(new Error("Employee ID is required"))).toBe(
        "Employee ID is required",
      );
    });
  });

  describe("unknown error shapes", () => {
    it("returns a generic message and never stringifies the object", () => {
      const leakyUnknown = {
        request: { headers: { authorization: "Bearer LEAKY_TOKEN" } },
      };

      const result = formatError(leakyUnknown);

      expect(result).toBe(
        "An unexpected error occurred while communicating with Xero.",
      );
      expect(result).not.toContain("Bearer");
      expect(result).not.toContain("LEAKY_TOKEN");
    });

    it("handles string errors safely", () => {
      expect(formatError("something blew up")).toBe(
        "An unexpected error occurred while communicating with Xero.",
      );
    });

    it("handles null safely", () => {
      expect(formatError(null)).toBe(
        "An unexpected error occurred while communicating with Xero.",
      );
    });
  });
});

/**
 * Reproduce what xero-node 13.3.0 actually rejects with on a failed Accounting
 * API call: `JSON.stringify(new ApiError(axiosError).generateError())` - a
 * string, not an Error and not an object. The envelope embeds the request
 * headers (bearer token included) and the response cookies, so these tests
 * double as leak checks.
 */
function sdkRejection(status: number, body: unknown): string {
  return JSON.stringify({
    response: {
      statusCode: status,
      body,
      headers: {
        "set-cookie": "ak_bmsc=COOKIE_SECRET; path=/",
        "xero-correlation-id": "corr-1",
      },
      request: {
        url: {
          protocol: "https:",
          port: 443,
          host: "api.xero.com",
          path: "/api.xro/2.0/Invoices/inv-1/Attachments",
        },
        headers: {
          authorization: "Bearer eyJSECRETTOKEN.payload.signature",
          "xero-tenant-id": "tenant-123",
        },
        method: "GET",
      },
    },
    body,
  });
}

describe("formatError with xero-node's stringified ApiError envelope", () => {
  it("surfaces the HTTP status and Xero's error body", () => {
    const rejection = sdkRejection(403, {
      Type: null,
      Title: "Forbidden",
      Status: 403,
      Detail: "AuthorizationUnsuccessful",
      Instance: "b0f1c3a2-0000-0000-0000-000000000000",
      Extensions: {},
    });

    expect(formatError(rejection)).toBe("403 Forbidden: AuthorizationUnsuccessful");
  });

  it("never leaks the bearer token, request headers or cookies", () => {
    const rejection = sdkRejection(403, {
      Title: "Forbidden",
      Detail: "AuthorizationUnsuccessful",
    });

    const result = formatError(rejection);

    expect(result).not.toContain("Bearer");
    expect(result).not.toContain("eyJSECRETTOKEN");
    expect(result).not.toContain("authorization");
    expect(result).not.toContain("set-cookie");
    expect(result).not.toContain("COOKIE_SECRET");
    expect(result).not.toContain("tenant-123");
  });

  it("surfaces a Xero validation body", () => {
    const rejection = sdkRejection(400, {
      ErrorNumber: 10,
      Type: "ValidationException",
      Message: "A validation exception occurred",
    });

    expect(formatError(rejection)).toBe(
      "400 ValidationException: A validation exception occurred",
    );
  });

  it("surfaces a plain-text body", () => {
    expect(formatError(sdkRejection(403, "AuthorizationUnsuccessful"))).toBe(
      "403: AuthorizationUnsuccessful",
    );
  });

  it("falls back to the mapped status message when Xero sends no body", () => {
    expect(formatError(sdkRejection(403, ""))).toBe(
      "You don't have permission to access this resource in Xero.",
    );
  });

  it("keeps the status when an unmapped failure has no body", () => {
    expect(formatError(sdkRejection(500, {}))).toBe("500 HTTP error");
  });

  it("redacts credential-shaped text inside the body and bounds its length", () => {
    const rejection = sdkRejection(400, {
      Detail: `rejected token Bearer eyJLEAKED.aaaaaaaa.bbbbbbbb ${"x".repeat(500)}`,
    });

    const result = formatError(rejection);

    expect(result).not.toContain("eyJLEAKED");
    expect(result).not.toContain("Bearer eyJ");
    expect(result).toContain("[redacted]");
    expect(result.length).toBeLessThanOrEqual(320);
    expect(result.endsWith("...")).toBe(true);
  });

  it("ignores a JSON string that is not an HTTP failure envelope", () => {
    expect(formatError('{"foo":1}')).toBe(
      "An unexpected error occurred while communicating with Xero.",
    );
  });

  it("does not echo a non-JSON string that contains credential material", () => {
    const result = formatError("Bearer eyJSECRETTOKEN.payload.signature expired");

    expect(result).toBe(
      "An unexpected error occurred while communicating with Xero.",
    );
    expect(result).not.toContain("eyJSECRETTOKEN");
  });
});

describe("formatError with the raw axios response pair", () => {
  it("surfaces status and body from a response/data object", () => {
    const rejection = {
      response: {
        status: 403,
        data: { Detail: "AuthorizationUnsuccessful" },
        headers: { "set-cookie": "ak_bmsc=COOKIE_SECRET" },
      },
      request: { headers: { authorization: "Bearer eyJSECRETTOKEN" } },
    };

    const result = formatError(rejection);

    expect(result).toBe("403: AuthorizationUnsuccessful");
    expect(result).not.toContain("Bearer");
    expect(result).not.toContain("COOKIE_SECRET");
  });
});
