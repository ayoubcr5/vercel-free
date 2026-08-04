/**
 * Proxy configuration stored in the project source.
 *
 * Add every media, segment, subtitle, certificate, or DRM-license hostname
 * that the player is authorized to contact through /api/proxy.
 *
 * Exact host example: media.example.com
 * Wildcard example: *.cdn.example.com
 *
 * A global "*" is intentionally not supported.
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
