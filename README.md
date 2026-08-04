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
- Allowlisted Vercel proxy mode for sources requiring server-side headers or CORS handling
- Shareable URLs
- Compatibility with the extension-style hash form: `/#https://example.com/manifest.mpd`

## Deploy to Vercel

1. Create a new GitHub repository and upload these files.
2. In Vercel, choose **Add New → Project** and import the repository.
3. Keep the framework preset as **Other**.
4. Deploy.

Direct playback works without environment variables when the media and license servers permit browser CORS requests.

### Enable the proxy

The proxy is deliberately disabled until you configure an allowlist. Add this environment variable in **Vercel → Project Settings → Environment Variables**:

```text
PROXY_ALLOW_HOSTS=media.example.com,license.example.com,*.cdn.example.com
```

The proxy supports exact hosts and wildcard subdomains. It does not support a global `*`, localhost, private networks, or reserved IP ranges.

Headers allowed by default:

```text
Authorization, Origin, Referer, User-Agent, X-API-Key
```

To change that list, set:

```text
PROXY_ALLOWED_HEADERS=authorization,origin,referer,user-agent,x-api-key,x-custom-token
```

Redeploy after changing environment variables.

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
