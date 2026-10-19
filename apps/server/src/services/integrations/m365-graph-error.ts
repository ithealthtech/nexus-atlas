// Never display arbitrary upstream text: it may contain credentials, claims challenges or customer data.
// Codes and explanations below are fixed strings; only a validated Microsoft request ID is copied through.
const ERRORS: Record<string, [string, string]> = {
  badrequest: ['BadRequest', 'Microsoft rejected the request as invalid.'],
  request_badrequest: ['Request_BadRequest', 'Microsoft rejected the request as invalid.'],
  request_unsupportedquery: ['Request_UnsupportedQuery', 'Microsoft does not support this query.'],
  authorization_requestdenied: ['Authorization_RequestDenied', 'Microsoft denied the requested directory operation.'],
  erroraccessdenied: ['ErrorAccessDenied', 'Microsoft denied access to this resource.'],
  accessdenied: ['accessDenied', 'Microsoft denied access to this resource.'],
  forbidden: ['Forbidden', 'Microsoft denied access to this resource.'],
  invalidauthenticationtoken: ['InvalidAuthenticationToken', 'Microsoft rejected the access token.'],
  insufficient_claims: ['insufficient_claims', 'Microsoft requires additional authentication claims.'],
  invalidrequest: ['invalidRequest', 'Microsoft rejected the request as invalid.'],
  request_resourcenotfound: ['Request_ResourceNotFound', 'Microsoft could not find the requested resource.'],
  resourcenotfound: ['ResourceNotFound', 'Microsoft could not find the requested resource.'],
  itemnotfound: ['itemNotFound', 'Microsoft could not find the requested resource.'],
  toomanyrequests: ['TooManyRequests', 'Microsoft is limiting requests. Try again later.'],
  activitylimitreached: ['activityLimitReached', 'Microsoft is limiting requests. Try again later.'],
  serviceunavailable: ['ServiceUnavailable', 'Microsoft Graph is temporarily unavailable.'],
  internalservererror: ['InternalServerError', 'Microsoft Graph encountered an internal error.'],
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A bounded diagnostic safe for saved tenant status and import job notes, never a raw response dump. */
export async function graphErrorDetail(res: Response): Promise<string> {
  const body = record(await res.json().catch(() => undefined));
  const error = record(body?.error);
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : '';
  const known = Object.hasOwn(ERRORS, code) ? ERRORS[code] : undefined;
  let detail = known ? ` Microsoft code ${known[0]}. ${known[1]}` : '';
  // Refine broad 400 codes with fixed explanations, without echoing any part of Microsoft's message.
  if (known && ['badrequest', 'request_badrequest', 'invalidrequest'].includes(code)) {
    const message = typeof error?.message === 'string' ? error.message.slice(0, 4096) : '';
    if (/unsupported query|query (?:is )?not supported/i.test(message))
      detail = ` Microsoft code ${known[0]}. Microsoft does not support this query.`;
    else if (/invalid (?:filter|select)|syntax error|query syntax/i.test(message))
      detail = ` Microsoft code ${known[0]}. Microsoft rejected the query syntax or selected fields.`;
  }
  const inner = record(error?.innerError) ?? record(error?.innererror);
  const candidates = [res.headers.get('request-id'), inner?.['request-id']];
  const requestId = candidates.find(
    (id): id is string => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id),
  );
  if (requestId) detail += ` Microsoft request ID ${requestId}.`;
  return detail;
}
