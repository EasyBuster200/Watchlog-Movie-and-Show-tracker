// The server API, under /v1/. Deliberately not /api/: the app's fetch shim
// (public/scripts/localApi.js) answers every /api/... request on the device itself.
//
// Every response is JSON. Errors are { error: '<code>', message: '<text for a person>' } and
// never include internal details (those go to the Worker's logs).
//
// CORS: a page on the same address (the web app, any preview) can always call the API. Other
// origins only when listed in ALLOWED_ORIGINS (wrangler.jsonc vars, comma-separated): the
// Android app runs at https://localhost. CORS only stops other websites' pages from reading
// responses in a browser; it isn't authentication (that's the session token, auth.js).
//
// Routes live in routes/*.js and register themselves with router.js's route().

import { API_PREFIX, ApiError, apiError, findRoutes, paramsFor } from './router.js';
import './routes/health.js';
import './routes/accounts.js';
import './routes/tmdb.js';
import './routes/sync.js';
import './routes/push.js';
import './routes/admin.js';

export { API_PREFIX };

export function isApiPath(pathname) {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Returns the Access-Control-Allow-Origin value for this request, or null if its origin isn't
// allowed. Same-origin requests and requests without an Origin (curl, server to server) need none.
function corsOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  if (origin === new URL(request.url).origin) return origin;
  return allowedOrigins(env).includes(origin) ? origin : null;
}

function withCors(response, origin) {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.append('Vary', 'Origin');
  headers.set('Access-Control-Expose-Headers', 'Retry-After');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function preflight(request, origin) {
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  });
}

export async function handleApi(request, env, ctx) {
  const origin = corsOrigin(request, env);
  const crossOrigin = request.headers.has('Origin') && request.headers.get('Origin') !== new URL(request.url).origin;
  if (request.method === 'OPTIONS') return preflight(request, origin);
  if (crossOrigin && !origin) return apiError(403, 'origin_not_allowed', 'This site is not allowed to use the Watchlog API.');

  const { pathname } = new URL(request.url);
  let response;
  try {
    const matches = findRoutes(pathname);
    const match = matches.find(r => r.method === request.method);
    if (match) {
      response = await match.handler({ request, env, ctx, params: paramsFor(match, pathname) });
    } else if (matches.length) {
      response = apiError(405, 'method_not_allowed', `${request.method} is not supported here.`);
    } else {
      response = apiError(404, 'not_found', 'There is nothing at this address.');
    }
  } catch (error) {
    if (error instanceof ApiError) {
      response = apiError(error.status, error.error, error.message, error.extra);
    } else {
      console.error('API error', request.method, pathname, error && error.stack ? error.stack : error);
      response = apiError(500, 'server_error', 'Something went wrong on the server.');
    }
  }
  return withCors(response, origin);
}
