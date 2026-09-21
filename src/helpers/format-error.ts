import { AxiosError } from "axios";

/**
 * A failed Xero API call, reduced to the two things worth reporting: the HTTP
 * status and whatever Xero put in the response body.
 */
interface XeroApiFailure {
  status: number;
  body: unknown;
}

/** Longest piece of Xero-supplied text copied into a returned message. */
const MAX_DETAIL_LENGTH = 300;

/**
 * Defence in depth. Nothing we extract is supposed to contain credentials,
 * but a response body is attacker- and upstream-controlled text, so strip
 * anything shaped like a bearer token or a JWT before it can be returned.
 */
const CREDENTIAL_PATTERN =
  /(?:bearer\s+[A-Za-z0-9._~+/-]+=*)|(?:eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)/gi;

function sanitize(text: string): string {
  const cleaned = text
    .replace(CREDENTIAL_PATTERN, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.length > MAX_DETAIL_LENGTH
    ? `${cleaned.slice(0, MAX_DETAIL_LENGTH)}...`
    : cleaned;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Recognise an object carrying an HTTP response from Xero.
 *
 * xero-node 13.3.0 produces two such shapes: the ApiError envelope
 * (`response.statusCode` + `response.body`, see
 * node_modules/xero-node/dist/model/ApiError.js) and the raw axios pair
 * (`response.status` + `response.data`) it rejects with when a non-2xx answer
 * reaches the resolve branch. Only the status and body are read; the same
 * objects also carry `request.headers.authorization` and response cookies,
 * which must never be surfaced.
 */
function readApiFailure(error: unknown): XeroApiFailure | null {
  if (typeof error !== "object" || error === null) return null;

  const { response, body } = error as { response?: unknown; body?: unknown };
  if (typeof response !== "object" || response === null) return null;

  const {
    statusCode,
    status,
    body: responseBody,
    data,
  } = response as {
    statusCode?: unknown;
    status?: unknown;
    body?: unknown;
    data?: unknown;
  };

  const httpStatus =
    typeof statusCode === "number"
      ? statusCode
      : typeof status === "number"
        ? status
        : undefined;

  if (httpStatus === undefined) return null;

  return { status: httpStatus, body: responseBody ?? data ?? body };
}

/**
 * xero-node 13.3.0 does not reject with an Error or with an object: every
 * failed Accounting API call ends in
 * `reject(JSON.stringify(new ApiError(axiosError).generateError()))`
 * (node_modules/xero-node/dist/gen/api/accountingApi.js). A thrown string
 * matched none of the branches below, so real HTTP failures were reported as
 * "An unexpected error occurred" with the status and Xero's explanation
 * thrown away. Parse that envelope back and pull out the whitelisted fields.
 */
function parseSdkErrorEnvelope(error: unknown): XeroApiFailure | null {
  if (typeof error !== "string") return null;

  const trimmed = error.trim();
  if (!trimmed.startsWith("{")) return null;

  try {
    return readApiFailure(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function formatHttpStatus(status: number): string {
  switch (status) {
    case 401:
      return "Authentication failed. Please check your Xero credentials.";
    case 403:
      return "You don't have permission to access this resource in Xero.";
    case 404:
      return "The requested resource was not found in Xero.";
    case 429:
      return "Too many requests to Xero. Please try again in a moment.";
    default:
      return "";
  }
}

function formatApiFailure({ status, body }: XeroApiFailure): string {
  const bodyObject =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : undefined;
  const problem =
    typeof bodyObject?.problem === "object" && bodyObject.problem !== null
      ? (bodyObject.problem as Record<string, unknown>)
      : undefined;

  const title = firstString(
    problem?.title,
    bodyObject?.Title,
    bodyObject?.Type,
    bodyObject?.httpStatusCode,
  );
  const detail = firstString(
    problem?.detail,
    bodyObject?.Detail,
    bodyObject?.Message,
    bodyObject?.error_description,
    typeof body === "string" ? body : undefined,
  );

  if (detail) {
    return title
      ? `${status} ${sanitize(title)}: ${sanitize(detail)}`
      : `${status}: ${sanitize(detail)}`;
  }

  const mapped = formatHttpStatus(status);
  if (mapped) return mapped;

  return `${status} ${title ? sanitize(title) : "HTTP error"}`;
}

/**
 * Format error messages for return to the LLM.
 *
 * Never stringify unknown error objects - the xero-node SDK rejects with a
 * payload whose `request.headers.authorization` field contains the caller's
 * Bearer token. Whitelist the fields we extract so secrets never reach the
 * response.
 */
export function formatError(error: unknown): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    const detail = error.response?.data?.Detail;

    if (status !== undefined) {
      const mapped = formatHttpStatus(status);
      if (mapped) return mapped;
    }
    return detail || "An error occurred while communicating with Xero.";
  }

  const failure = readApiFailure(error) ?? parseSdkErrorEnvelope(error);
  if (failure) return formatApiFailure(failure);

  if (error instanceof Error) {
    return error.message;
  }

  return "An unexpected error occurred while communicating with Xero.";
}
