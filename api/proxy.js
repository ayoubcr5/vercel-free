import dns from 'node:dns/promises';
import net from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_REDIRECTS = 5;
const DEFAULT_ALLOWED_HEADERS = [
  'authorization',
  'origin',
  'referer',
  'user-agent',
  'x-api-key'
];
const BLOCKED_FORWARD_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Range, X-Player-Headers');
  response.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range, Content-Length, Content-Type, ETag');

  if (request.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }

  if (!['GET', 'HEAD'].includes(request.method)) {
    sendJson(response, 405, { error: 'Only GET and HEAD are supported.' });
    return;
  }

  const allowRules = parseCsv(process.env.PROXY_ALLOW_HOSTS);
  if (!allowRules.length) {
    sendJson(response, 503, {
      error: 'Proxy is disabled.',
      setup: 'Set PROXY_ALLOW_HOSTS in Vercel, for example: media.example.com,license.example.com,*.cdn.example.com'
    });
    return;
  }

  const rawUrl = getSingleQueryValue(request.query?.url);
  if (!rawUrl) {
    sendJson(response, 400, { error: 'Missing url query parameter.' });
    return;
  }

  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    sendJson(response, 400, { error: 'Invalid upstream URL.' });
    return;
  }

  const allowedCustomHeaders = new Set(
    parseCsv(process.env.PROXY_ALLOWED_HEADERS || DEFAULT_ALLOWED_HEADERS.join(','))
      .map((header) => header.toLowerCase())
  );

  let customHeaders = {};
  const encodedHeaders = getSingleHeader(request.headers['x-player-headers']);
  if (encodedHeaders) {
    try {
      customHeaders = decodeHeaderPayload(encodedHeaders);
    } catch (error) {
      sendJson(response, 400, { error: `Invalid X-Player-Headers value: ${error.message}` });
      return;
    }
  }

  const upstreamHeaders = buildUpstreamHeaders(request.headers, customHeaders, allowedCustomHeaders);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Upstream timeout')), 280_000);
  response.on('close', () => controller.abort(new Error('Client disconnected')));

  try {
    const upstream = await fetchWithValidatedRedirects(target, {
      method: request.method,
      headers: upstreamHeaders,
      signal: controller.signal
    }, allowRules);

    response.statusCode = upstream.status;
    copyResponseHeaders(upstream.headers, response);
    response.setHeader('X-Proxy-Upstream', new URL(upstream.url).host);

    if (request.method === 'HEAD' || !upstream.body) {
      response.end();
      return;
    }

    await pipeline(Readable.fromWeb(upstream.body), response);
  } catch (error) {
    if (!response.headersSent) {
      const status = error.statusCode || (error.name === 'AbortError' ? 504 : 502);
      sendJson(response, status, { error: error.message || 'The upstream request failed.' });
    } else {
      response.destroy(error);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithValidatedRedirects(initialUrl, options, allowRules) {
  let current = initialUrl;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await validateTarget(current, allowRules);
    const upstream = await fetch(current, {
      ...options,
      redirect: 'manual'
    });

    if (![301, 302, 303, 307, 308].includes(upstream.status)) {
      return upstream;
    }

    const location = upstream.headers.get('location');
    if (!location) return upstream;
    if (redirects === MAX_REDIRECTS) {
      const error = new Error('Too many upstream redirects.');
      error.statusCode = 508;
      throw error;
    }
    current = new URL(location, current);
  }

  throw new Error('Redirect processing failed.');
}

async function validateTarget(url, allowRules) {
  if (!['http:', 'https:'].includes(url.protocol)) {
    const error = new Error('Only HTTP and HTTPS upstream URLs are allowed.');
    error.statusCode = 400;
    throw error;
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostMatchesAllowlist(hostname, allowRules)) {
    const error = new Error(`Upstream host is not allowed: ${hostname}`);
    error.statusCode = 403;
    throw error;
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    const error = new Error('Localhost targets are blocked.');
    error.statusCode = 403;
    throw error;
  }

  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true });

  if (!addresses.length || addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    const error = new Error('Private or reserved upstream addresses are blocked.');
    error.statusCode = 403;
    throw error;
  }
}

function hostMatchesAllowlist(hostname, rules) {
  return rules.some((rule) => {
    const normalized = rule.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    if (normalized.startsWith('*.')) {
      const suffix = normalized.slice(1); // includes the leading dot
      return hostname.endsWith(suffix) && hostname !== normalized.slice(2);
    }
    return hostname === normalized;
  });
}

function isPrivateOrReservedIp(address) {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  const value = (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
  const inRange = (base, bits) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  };
  const ip = (a, b = 0, c = 0, d = 0) => (((a * 256 + b) * 256 + c) * 256 + d) >>> 0;

  return [
    [ip(0), 8],
    [ip(10), 8],
    [ip(100, 64), 10],
    [ip(127), 8],
    [ip(169, 254), 16],
    [ip(172, 16), 12],
    [ip(192, 0, 0), 24],
    [ip(192, 0, 2), 24],
    [ip(192, 168), 16],
    [ip(198, 18), 15],
    [ip(198, 51, 100), 24],
    [ip(203, 0, 113), 24],
    [ip(224), 4],
    [ip(240), 4]
  ].some(([base, bits]) => inRange(base, bits));
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('2001:db8:')) return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    return net.isIP(mapped) === 4 ? isPrivateIpv4(mapped) : true;
  }
  return false;
}

function buildUpstreamHeaders(incoming, custom, allowedCustomHeaders) {
  const headers = new Headers();
  const passthrough = ['accept', 'accept-language', 'if-modified-since', 'if-none-match', 'if-range', 'range'];

  for (const name of passthrough) {
    const value = getSingleHeader(incoming[name]);
    if (value) headers.set(name, value);
  }
  headers.set('accept-encoding', 'identity');

  for (const [rawName, rawValue] of Object.entries(custom)) {
    const name = rawName.toLowerCase();
    if (!allowedCustomHeaders.has(name) || BLOCKED_FORWARD_HEADERS.has(name)) continue;
    headers.set(rawName, String(rawValue));
  }

  return headers;
}

function decodeHeaderPayload(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Expected a JSON object.');
  }

  const result = {};
  for (const [name, headerValue] of Object.entries(parsed)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`Invalid header name: ${name}`);
    }
    if (headerValue === null || typeof headerValue === 'object') {
      throw new Error(`Invalid value for header: ${name}`);
    }
    result[name] = String(headerValue);
  }
  return result;
}

function copyResponseHeaders(upstreamHeaders, response) {
  const names = [
    'accept-ranges',
    'cache-control',
    'content-disposition',
    'content-range',
    'content-type',
    'etag',
    'expires',
    'last-modified',
    'vary'
  ];
  for (const name of names) {
    const value = upstreamHeaders.get(name);
    if (value) response.setHeader(name, value);
  }
}

function parseCsv(value = '') {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function getSingleHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function getSingleQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response, status, body) {
  response.status(status);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}
