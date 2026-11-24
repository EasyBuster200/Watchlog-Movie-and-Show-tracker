// The API's routing table and response helpers, shared by the route modules (routes/*.js) and
// api.js. Kept apart from api.js so route modules can import `route` without a circular import.

export const API_PREFIX = '/v1';

const ROUTES = [];

// route('GET', '/sessions/:id', handler): handlers get { request, env, ctx, params } and return a
// Response. They may throw an ApiError for an expected failure (401, 400, 429...). A pattern
// ending in '/*' matches the rest of the path as params.path ('/tmdb/*' -> 'movie/550').
export function route(method, pattern, handler) {
  const names = [];
  let source = pattern.replace(/:(\w+)/g, (m, name) => { names.push(name); return '([^/]+)'; });
  if (source.endsWith('/*')) {
    names.push('path');
    source = `${source.slice(0, -2)}/(.+)`;
  }
  const regex = new RegExp(`^${API_PREFIX}${source}$`);
  ROUTES.push({ method, regex, names, handler });
}

export function findRoutes(pathname) {
  return ROUTES.filter(r => r.regex.test(pathname));
}

export function paramsFor(match, pathname) {
  const values = pathname.match(match.regex).slice(1).map(decodeURIComponent);
  return Object.fromEntries(match.names.map((name, i) => [name, values[i]]));
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export function noContent() {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

export function apiError(status, error, message, extra = {}) {
  return json({ error, message, ...extra }, status, extra.retryAfter ? { 'Retry-After': String(extra.retryAfter) } : {});
}

// An expected failure a handler can throw; api.js turns it into apiError().
export class ApiError extends Error {
  constructor(status, error, message, extra = {}) {
    super(message);
    this.status = status;
    this.error = error;
    this.extra = extra;
  }
}

const MAX_BODY_BYTES = 16 * 1024;

// Parses a JSON object body (at most 16 KB). Throws a 400 ApiError otherwise.
export async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, 'body_too_large', 'That request is too large.');
  if (!text) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_json', 'The request body must be a JSON object.');
  return body;
}
