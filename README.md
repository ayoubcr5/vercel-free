# Vercel MPD Player

A clean-room web implementation inspired by the behavior of the Chrome extension **VideoPlayer MPD/M3U8/IPTV/EPG**. It uses the open-source Apache-2.0-licensed Shaka Player library and does not copy the extension's minified application code.

## Features

- MPEG-DASH (`.mpd`) and HLS (`.m3u8`) playback
- Shaka quality, audio-language, subtitle, PiP, and playback-speed controls
- ClearKey input as:
  - `{ "hex-kid": "hex-key" }`
  - `hex-kid:hex-key`
  - EME JWK set
  - authorized ClearKey license URL
- Widevine license server and optional service-certificate URL
- Custom request headers
- Direct mode for CORS-enabled sources
- Vercel proxy mode for public sources requiring server-side headers or CORS handling
- Shareable URLs
- Compatibility with the extension-style hash form: `/#https://example.com/manifest.mpd`

## Deploy to Vercel

1. Create a new GitHub repository and upload these files.
2. In Vercel, choose **Add New → Project** and import the repository.
3. Keep the framework preset as **Other**.
4. Deploy.

Direct playback works without environment variables when the media and license servers permit browser CORS requests.

### Proxy configuration in the project

No Vercel environment variable is required. The project is configured to allow every **public HTTP/HTTPS host**:

```js
export const PROXY_ALLOW_HOSTS = ['*'];
```

The `*` rule does not permit internal network access. The proxy continues to reject localhost, private IP ranges, link-local addresses, reserved/documentation ranges, and redirects that resolve to those destinations. Only `GET`, `HEAD`, and `OPTIONS` requests are accepted.

Allowed custom request headers are configured in `proxy.config.js` through `PROXY_ALLOWED_HEADERS`. Redeploy after editing the configuration file.

## Player URL formats

Normal query format:

```text
https://your-project.vercel.app/?src=https%3A%2F%2Fexample.com%2Fmanifest.mpd&title=Channel&proxy=1
```

Extension-style hash format:

```text
https://your-project.vercel.app/#https://example.com/manifest.mpd
```

The app also understands Base64/Base64URL values for `headers`, `ck`, `wv`, and `wvc`, mirroring the extension's link-generator style.

## Embed

```html
<iframe
  src="https://your-project.vercel.app/?src=https%3A%2F%2Fexample.com%2Fmanifest.mpd"
  allow="autoplay; encrypted-media; picture-in-picture"
  width="1280"
  height="720"
></iframe>
```

## Important limitations

- A normal website cannot use Chrome extension APIs such as `declarativeNetRequest`. The included server-side proxy is the replacement.
- Browser DRM support varies. Widevine generally requires a secure HTTPS context and a compatible browser/CDM.
- Proxying every video segment through Vercel increases bandwidth, execution time, and cost. It is suitable for testing and light/private use. For a public high-traffic service, use a dedicated media proxy or CDN.
- Do not place reusable secrets in a share URL. The player excludes DRM/header fields from copied links unless you explicitly enable them.
- Use only media, keys, headers, and license servers you are legally authorized to use.

## Local syntax check

```bash
npm run check
```

For a full local Vercel environment, install the Vercel CLI and run `vercel dev`.

## Proxad / init-segment troubleshooting

Version 1.0.2 pins the proxy function to Vercel's Paris region (`cdg1`) and no longer uses the global `fetch()` implementation for upstream media. It resolves and validates the origin once, tries public IPv4 addresses before IPv6, keeps the original TLS hostname/SNI, forwards browser `User-Agent`, `Accept`, language, cache, pragma, conditional, and range headers, and retries alternate resolved addresses for connection-level failures.

Test the init object after redeploying:

```bash
curl -i 'https://YOUR-PROJECT.vercel.app/api/proxy?url=https%3A%2F%2Fmedia4.stream.proxad.net%2Fmedia%2F0_1_376_init' \
  -H 'accept: */*' \
  -H 'cache-control: no-cache' \
  -H 'pragma: no-cache'
```

Successful responses include `X-Proxy-Region: cdg1`, `X-Proxy-Upstream`, and `X-Proxy-Upstream-IP`.

When a connection fails, the JSON now exposes the network code, attempted IP, port, and Vercel region. If it still reports `ECONNREFUSED` from `cdg1`, the Proxad origin is rejecting Vercel/datacenter egress at the TCP layer. Browser headers cannot repair a TCP refusal; use direct extension playback or a proxy/VPS on an accepted French consumer or hosting network.
