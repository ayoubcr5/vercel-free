import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import { PROXY_ALLOW_HOSTS, PROXY_ALLOWED_HEADERS } from '../proxy.config.js';

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 64 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 64 });

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
  setCorsHeaders(response);
  response.setHeader('X-Proxy-Region', process.env.VERCEL_REGION || 'local');

  if (request.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }

  if (!['GET', 'HEAD'].includes(request.method)) {
    sendJson(response, 405, { error: 'Only GET and HEAD are supported.' });
    return;
  }

  const allowRules = normalizeList(PROXY_ALLOW_HOSTS);
  if (!allowRules.length) {
    sendJson(response, 503, {
      error: 'Proxy is disabled because PROXY_ALLOW_HOSTS is empty in proxy.config.js.'
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
    normalizeList(PROXY_ALLOWED_HEADERS).map((header) => header.toLowerCase())
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

  const upstreamHeaders = buildUpstreamHeaders(
    request.headers,
    customHeaders,
    allowedCustomHeaders
  );

  const controller = new AbortController();
  const overallTimeout = setTimeout(
    () => controller.abort(new Error('Upstream request timed out.')),
    280_000
  );
  response.on('close', () => {
    if (!response.writableEnded) {
      controller.abort(new Error('Client disconnected.'));
    }
  });

  try {
    const upstream = await requestWithValidatedRedirects(
      target,
      {
        method: request.method,
        headers: upstreamHeaders,
        signal: controller.signal
      },
      allowRules
    );

    response.statusCode = upstream.statusCode || 502;
    copyResponseHeaders(upstream.headers, response);
    response.setHeader('X-Proxy-Upstream', upstream.finalUrl.host);
    response.setHeader('X-Proxy-Upstream-IP', upstream.remoteAddress || 'unknown');

    if (request.method === 'HEAD') {
      upstream.resume();
      response.end();
      return;
    }

    await pipeline(upstream, response);
  } catch (error) {
    if (!response.headersSent) {
      const status = error.statusCode || (error.name === 'AbortError' ? 504 : 502);
      sendJson(response, status, serializeProxyError(error, target));
    } else {
      response.destroy(error);
    }
  } finally {
    clearTimeout(overallTimeout);
  }
}

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Range, X-Player-Headers');
  response.setHeader(
    'Access-Control-Expose-Headers',
    [
      'Accept-Ranges',
      'Content-Range',
      'Content-Length',
      'Content-Type',
      'ETag',
      'X-Proxy-Region',
      'X-Proxy-Upstream',
      'X-Proxy-Upstream-IP'
    ].join(', ')
  );
}

async function requestWithValidatedRedirects(initialUrl, options, allowRules) {
  let current = initialUrl;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const addresses = await validateAndResolveTarget(current, allowRules);
    const upstream = await requestWithAddressFallback(current, options, addresses);

    if (![301, 302, 303, 307, 308].includes(upstream.statusCode)) {
      upstream.finalUrl = current;
      return upstream;
    }

    const location = getNodeResponseHeader(upstream.headers, 'location');
    if (!location) {
      upstream.finalUrl = current;
      return upstream;
    }

    upstream.resume();

    if (redirects === MAX_REDIRECTS) {
      const error = new Error('Too many upstream redirects.');
      error.statusCode = 508;
      throw error;
    }

    current = new URL(location, current);
  }

  throw new Error('Redirect processing failed.');
}

async function requestWithAddressFallback(url, options, addresses) {
  // A number of television/media origins publish both IPv4 and IPv6 but only
  // accept one family reliably from serverless networks. Match the successful
  // browser/curl path by trying public IPv4 addresses first, then IPv6.
  const ordered = [...addresses].sort((a, b) => {
    const familyA = normalizeFamily(a.family);
    const familyB = normalizeFamily(b.family);
    if (familyA === familyB) return 0;
    return familyA === 4 ? -1 : 1;
  });

  let lastError;
  for (const candidate of ordered) {
    try {
      return await requestSingleAddress(url, options, candidate);
    } catch (error) {
      lastError = error;
      if (!isRetryableConnectionError(error)) throw error;
    }
  }

  throw lastError || new Error('No usable upstream address was found.');
}

function requestSingleAddress(url, options, candidate) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const family = normalizeFamily(candidate.family);
    const requestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      agent: url.protocol === 'https:' ? HTTPS_AGENT : HTTP_AGENT,
      family,
      servername: url.protocol === 'https:' && net.isIP(url.hostname) === 0 ? url.hostname : undefined,
      lookup(_hostname, _lookupOptions, callback) {
        callback(null, candidate.address, family);
      }
    };

    const upstreamRequest = transport.request(requestOptions, (upstreamResponse) => {
      upstreamResponse.remoteAddress = upstreamResponse.socket?.remoteAddress || candidate.address;
      resolve(upstreamResponse);
    });

    upstreamRequest.setTimeout(CONNECT_TIMEOUT_MS, () => {
      const error = new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS} ms.`);
      error.code = 'ETIMEDOUT';
      error.address = candidate.address;
      error.port = Number(requestOptions.port);
      upstreamRequest.destroy(error);
    });

    upstreamRequest.once('error', (error) => {
      if (!error.address) error.address = candidate.address;
      if (!error.port) error.port = Number(requestOptions.port);
      reject(error);
    });

    upstreamRequest.end();
  });
}

async function validateAndResolveTarget(url, allowRules) {
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
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await dns.lookup(hostname, { all: true, verbatim: true });

  if (!addresses.length || addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    const error = new Error('Private or reserved upstream addresses are blocked.');
    error.statusCode = 403;
    throw error;
  }

  return deduplicateAddresses(addresses);
}

function hostMatchesAllowlist(hostname, rules) {
  return rules.some((rule) => {
    const normalized = rule.toLowerCase().trim();
    if (normalized === '*') return true;

    const hostRule = normalized.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    if (hostRule.startsWith('*.')) {
      const suffix = hostRule.slice(1);
      return hostname.endsWith(suffix) && hostname !== hostRule.slice(2);
    }
    return hostname === hostRule;
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
  const headers = {};
  const passthrough = [
    'accept',
    'accept-language',
    'cache-control',
    'if-modified-since',
    'if-none-match',
    'if-range',
    'pragma',
    'range',
    'user-agent'
  ];

  for (const name of passthrough) {
    const value = getSingleHeader(incoming[name]);
    if (value) headers[name] = value;
  }

  headers.accept ||= '*/*';
  headers['accept-language'] ||= 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7';
  headers['cache-control'] ||= 'no-cache';
  headers.pragma ||= 'no-cache';
  headers['user-agent'] ||= DEFAULT_BROWSER_UA;
  headers['accept-encoding'] = 'identity';

  for (const [rawName, rawValue] of Object.entries(custom)) {
    const name = rawName.toLowerCase();
    if (!allowedCustomHeaders.has(name) || BLOCKED_FORWARD_HEADERS.has(name)) continue;
    headers[name] = String(rawValue);
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
    'content-length',
    'content-range',
    'content-type',
    'etag',
    'expires',
    'last-modified',
    'vary'
  ];

  for (const name of names) {
    const value = getNodeResponseHeader(upstreamHeaders, name);
    if (value !== undefined) response.setHeader(name, value);
  }
}

function getNodeResponseHeader(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function isRetryableConnectionError(error) {
  return new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'EAI_AGAIN'
  ]).has(error?.code);
}

function serializeProxyError(error, target) {
  const cause = error?.cause || error;
  const body = {
    error: error?.message || 'The upstream request failed.',
    targetHost: target.hostname,
    region: process.env.VERCEL_REGION || 'local'
  };

  if (cause?.code) body.code = cause.code;
  if (cause?.address) body.address = cause.address;
  if (cause?.port) body.port = cause.port;
  if (cause?.syscall) body.syscall = cause.syscall;

  if (cause?.code === 'ECONNREFUSED') {
    body.hint =
      'The origin refused the Vercel server connection. This is usually an origin firewall, geolocation, or datacenter-IP restriction rather than a CORS/header problem.';
  }

  return body;
}

function deduplicateAddresses(addresses) {
  const seen = new Set();
  return addresses.filter(({ address }) => {
    if (seen.has(address)) return false;
    seen.add(address);
    return true;
  });
}

function normalizeFamily(family) {
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return net.isIP(String(family)) || 0;
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
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
