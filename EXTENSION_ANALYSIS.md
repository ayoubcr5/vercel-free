# Extension analysis

Analyzed package: `26.1.6.8388_0.zip`

## Identity

- Name: VideoPlayer MPD/M3U8/IPTV/EPG
- Author: Sharkiller
- Version: 26.1.6.8388
- Manifest: Chrome Manifest V3
- Public repository: `github.com/sharkiller/Reproductor-MPD-M3U8`
- Chrome extension ID from the manifest key/store listing: `opmeopcambhfimffbomjgemehjkbbmji`

## Relevant behavior

The service worker uses `chrome.declarativeNetRequest` to:

1. Redirect top-level `.mpd` and `.m3u8` navigations to `pages/player.html`.
2. Redirect `.m3u` navigations to the IPTV page.
3. Add permissive CORS response headers.
4. Apply custom request headers to player requests.

The direct player:

- Reads the media URL from the page hash.
- Uses the bundled JW Player integration with a Shaka provider.
- Supports MPD and M3U8.
- Supports ClearKey maps/JWK data and ClearKey endpoints.
- Supports a Widevine license URL and optional service-certificate URL.
- Supports Base64-encoded custom headers, title, and image parameters.

## Why the Vercel implementation differs

A website cannot call `chrome.declarativeNetRequest`, cannot freely override forbidden browser headers such as `Origin`, `Referer`, or `User-Agent`, and remains subject to upstream CORS policy. The project therefore uses:

- Shaka Player directly in the browser.
- A Shaka networking request filter.
- An allowlisted Vercel function that proxies manifests, segments, and license requests when enabled.
- A Shaka response filter that restores the original upstream URI so relative DASH segment paths resolve correctly.

## Licensing note

The extension files declare `CC BY-NC-ND 4.0`, which does not permit distributing modified derivatives. This project is a fresh implementation and does not reuse its minified application code, branding, artwork, or JW Player bundle.
