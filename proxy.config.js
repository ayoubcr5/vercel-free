/**
 * Proxy host configuration stored in the project source.
 *
 * `*` permits any public HTTP or HTTPS hostname. The proxy still blocks
 * localhost, private networks, link-local addresses, reserved ranges, and
 * cloud metadata endpoints through DNS/IP validation in api/proxy.js.
 */
export const PROXY_ALLOW_HOSTS = ['*'];

/**
 * Custom request headers that links/player input may forward upstream.
 * Header names are matched case-insensitively.
 */
export const PROXY_ALLOWED_HEADERS = [
  'authorization',
  'origin',
  'referer',
  'user-agent',
  'x-api-key'
];
