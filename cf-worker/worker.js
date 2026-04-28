/**
 * HDREZKA proxy worker for Lampa plugin.
 *
 * Solves the problem that Lampa Android (OkHttp jar) drops HttpOnly cookies
 * between requests, making login-by-credentials impossible on Android directly.
 *
 * Endpoints (all return JSON, CORS allowed for any origin):
 *
 *   GET  /                — health check
 *   POST /login           — body: {login, password, domain?}  → {ok, cookie, error}
 *   POST /proxy           — body: {url, method?, headers?, body?, cookie?}
 *                            → {ok, status, body, setCookie, headers}
 *
 * Cookie is returned to client as a single string (e.g.
 * "PHPSESSID=abc; dle_user_id=123; dle_password=xyz; dle_hash=..."), client
 * persists it locally. Subsequent /proxy calls must include this cookie.
 *
 * Deploy:
 *   1. Cloudflare → Workers & Pages → Create Worker
 *   2. Paste this file into the editor (Quick edit)
 *   3. Deploy. Worker URL is something like:
 *        https://<name>.<account>.workers.dev
 *   4. Paste that URL into the HDREZKA plugin "CORS-proxy" field.
 */

const DEFAULT_DOMAIN = 'https://rezka.fi';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-rezka-cookie',
  'Access-Control-Max-Age': '86400'
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS)
  });
}

function textErr(msg, status) {
  return json({ ok: false, error: msg }, status || 500);
}

/**
 * Parse Set-Cookie header lines into "name=value" pairs. Cloudflare Workers
 * expose multiple Set-Cookie headers via headers.getSetCookie() (Web API).
 * Falls back to splitting the joined header if not available.
 */
function extractCookies(resp) {
  try {
    if (typeof resp.headers.getSetCookie === 'function') {
      return resp.headers.getSetCookie();
    }
  } catch (e) {}
  // Fallback (browsers/older runtimes)
  const raw = resp.headers.get('set-cookie') || '';
  // Single Set-Cookie header may contain commas inside expires=; split smart.
  return raw ? [raw] : [];
}

/**
 * Returns "name=value" pair from a single Set-Cookie line, or null if expired/deleted.
 */
function parseCookieLine(line) {
  // line like: "dle_user_id=123; expires=Wed, 01-Jan-2026 ...; HttpOnly; Path=/"
  const first = line.split(';')[0].trim();
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (value === '' || value === 'deleted') return null;
  return name + '=' + value;
}

function buildCookieHeader(cookies) {
  return cookies
    .map(parseCookieLine)
    .filter(Boolean)
    .join('; ');
}

/**
 * Merge two cookie strings: take all of "base", then override with "extra".
 */
function mergeCookies(base, extra) {
  const out = {};
  function add(s) {
    if (!s) return;
    s.split(';').forEach(function (kv) {
      const t = kv.trim();
      if (!t) return;
      const eq = t.indexOf('=');
      if (eq <= 0) return;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    });
  }
  add(base);
  add(extra);
  return Object.keys(out)
    .map(function (k) { return k + '=' + out[k]; })
    .join('; ');
}

async function handleLogin(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return textErr('invalid json: ' + (e && e.message), 400);
  }
  const login = String(body.login || '').trim();
  const password = String(body.password || '').trim();
  const domain = String(body.domain || DEFAULT_DOMAIN).replace(/\/+$/, '');
  if (!login || !password) return textErr('login/password required', 400);

  const post =
    'login_name=' + encodeURIComponent(login) +
    '&login_password=' + encodeURIComponent(password) +
    '&login_not_save=0';

  let resp;
  try {
    resp = await fetch(domain + '/ajax/login/?t=' + Date.now(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': UA,
        'Origin': domain,
        'Referer': domain + '/'
      },
      body: post
    });
  } catch (e) {
    return textErr('upstream fetch failed: ' + (e && e.message), 502);
  }

  let respJson = {};
  let respText = '';
  try {
    respText = await resp.text();
    respJson = JSON.parse(respText);
  } catch (e) {
    return json({
      ok: false,
      error: 'login response not JSON',
      status: resp.status,
      body: respText.slice(0, 300)
    }, 200);
  }

  if (!respJson.success) {
    return json({
      ok: false,
      error: respJson.message || respJson.log || 'login rejected',
      raw: respJson
    }, 200);
  }

  const setCookies = extractCookies(resp);
  const cookieStr = buildCookieHeader(setCookies);

  if (!/dle_user_id=/.test(cookieStr) || !/dle_password=/.test(cookieStr)) {
    return json({
      ok: false,
      error: 'login OK but no dle cookies received',
      cookie: cookieStr,
      raw_set_cookie: setCookies
    }, 200);
  }

  // Verify by hitting the homepage with these cookies.
  let verifyResp, verifyText = '';
  try {
    verifyResp = await fetch(domain + '/?t=' + Date.now(), {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,en;q=0.9',
        'Cookie': cookieStr,
        'Referer': domain + '/'
      }
    });
    verifyText = await verifyResp.text();
  } catch (e) {}

  const loggedIn = /\/logout\/|dle_login_hash|logout=yes/i.test(verifyText);
  const loginPage = /<title>\s*Вход\s*<\/title>|id="login_name"|action="\/ajax\/login\/"/i.test(verifyText);

  // Если verify провалился — возможно сервер вернул новые куки на homepage; докинем их.
  if (!loggedIn && verifyResp) {
    const homeCookies = extractCookies(verifyResp);
    const merged = mergeCookies(cookieStr, buildCookieHeader(homeCookies));
    if (merged !== cookieStr && /dle_user_id=/.test(merged)) {
      return json({
        ok: true,
        cookie: merged,
        verified: false,
        verify_hint: loginPage ? 'login page' : 'no markers',
        domain: domain
      });
    }
  }

  return json({
    ok: true,
    cookie: cookieStr,
    verified: loggedIn,
    verify_hint: loggedIn ? 'logout marker found' : (loginPage ? 'login page' : 'no markers'),
    domain: domain
  });
}

async function handleProxy(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return textErr('invalid json: ' + (e && e.message), 400);
  }
  const url = String(body.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return textErr('url required', 400);

  const method = (body.method || 'GET').toUpperCase();
  const cookie = String(body.cookie || '').trim();
  const headersIn = body.headers || {};

  // Build outgoing headers
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru,en;q=0.9'
  };
  Object.keys(headersIn).forEach(function (k) {
    if (typeof headersIn[k] === 'string') headers[k] = headersIn[k];
  });
  // Force cookie if provided
  if (cookie) headers['Cookie'] = cookie;
  // Strip hop-by-hop / problematic headers
  delete headers['host'];
  delete headers['Host'];

  // Optional referer
  try {
    const u = new URL(url);
    if (!headers['Referer'] && !headers['referer']) {
      headers['Referer'] = u.origin + '/';
    }
  } catch (e) {}

  const init = { method: method, headers: headers, redirect: 'follow' };
  if (method !== 'GET' && method !== 'HEAD' && body.body !== undefined && body.body !== null) {
    init.body = typeof body.body === 'string' ? body.body : JSON.stringify(body.body);
  }

  let resp;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    return textErr('fetch failed: ' + (e && e.message), 502);
  }

  const respText = await resp.text();
  const respHeaders = {};
  resp.headers.forEach(function (v, k) {
    if (k.toLowerCase() !== 'set-cookie') respHeaders[k] = v;
  });
  const setCookies = extractCookies(resp);
  const newCookieFragment = buildCookieHeader(setCookies);

  return json({
    ok: true,
    status: resp.status,
    body: respText,
    headers: respHeaders,
    setCookie: newCookieFragment, // "name=value; name2=value2" (only fresh)
    setCookieRaw: setCookies
  });
}

async function handle(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  if (url.pathname === '/' || url.pathname === '/health') {
    return json({ ok: true, name: 'rezka-proxy', version: 1 });
  }
  if (url.pathname === '/login' && request.method === 'POST') {
    return handleLogin(request);
  }
  if (url.pathname === '/proxy' && request.method === 'POST') {
    return handleProxy(request);
  }
  return json({ ok: false, error: 'not found' }, 404);
}

addEventListener('fetch', function (event) {
  event.respondWith(handle(event.request).catch(function (e) {
    return textErr('worker error: ' + (e && e.message), 500);
  }));
});
