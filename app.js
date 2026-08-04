/* global shaka */
'use strict';

const DEMO_MPD = 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd';
const FORBIDDEN_BROWSER_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via'
]);

let player;
let ui;
let activeSettings = {
  useProxy: false,
  headers: {}
};
let lastSkippedHeaders = [];

const elements = {};

document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
  cacheElements();
  bindEvents();

  if (typeof shaka === 'undefined') {
    setSupport(false, 'Shaka failed to load');
    setStatus('The Shaka Player library could not be loaded from the CDN.', 'error');
    return;
  }

  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) {
    setSupport(false, 'Browser unsupported');
    setStatus('This browser does not support the Media Source Extensions required for DASH playback.', 'error');
    return;
  }

  setSupport(true, 'Browser supported');

  try {
    player = new shaka.Player();
    await player.attach(elements.video);
    ui = new shaka.ui.Overlay(player, elements.videoContainer, elements.video);
    ui.configure({
      addSeekBar: true,
      enableKeyboardPlaybackControls: true,
      overflowMenuButtons: [
        'captions',
        'quality',
        'language',
        'picture_in_picture',
        'playback_rate'
      ]
    });

    player.addEventListener('error', (event) => showPlayerError(event.detail));
    installNetworkFilters();
    populateFromLocation();

    if (elements.manifestUrl.value) {
      await playFromForm();
    }
  } catch (error) {
    setStatus(`Player initialization failed: ${error.message || error}`, 'error');
  }
}

function cacheElements() {
  const ids = [
    'video',
    'video-container',
    'player-form',
    'manifest-url',
    'stream-title',
    'use-proxy',
    'request-headers',
    'clear-key',
    'widevine-url',
    'widevine-cert-url',
    'play-button',
    'stop-button',
    'demo-button',
    'copy-link-button',
    'include-private-settings',
    'status',
    'support-badge',
    'now-playing',
    'now-playing-title',
    'now-playing-url'
  ];

  for (const id of ids) {
    const key = id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    elements[key] = document.getElementById(id);
  }
}

function bindEvents() {
  elements.playerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await playFromForm();
  });

  elements.stopButton.addEventListener('click', stopPlayback);

  elements.demoButton.addEventListener('click', () => {
    elements.manifestUrl.value = DEMO_MPD;
    elements.streamTitle.value = 'Big Buck Bunny DASH demo';
    elements.useProxy.checked = false;
    setStatus('Demo manifest loaded into the form. Press Play stream.', 'info');
  });

  elements.copyLinkButton.addEventListener('click', copyPlayerLink);
}

function installNetworkFilters() {
  const networkingEngine = player.getNetworkingEngine();

  networkingEngine.registerRequestFilter((_type, request) => {
    const originalUris = [...request.uris];

    if (activeSettings.useProxy) {
      const encodedHeaders = encodeBase64Url(JSON.stringify(activeSettings.headers || {}));
      request.uris = originalUris.map((uri) => makeProxyUrl(uri));
      if (encodedHeaders) {
        request.headers['x-player-headers'] = encodedHeaders;
      }
      return;
    }

    lastSkippedHeaders = [];
    for (const [name, value] of Object.entries(activeSettings.headers || {})) {
      const normalized = name.toLowerCase();
      if (FORBIDDEN_BROWSER_HEADERS.has(normalized) || normalized.startsWith('proxy-') || normalized.startsWith('sec-')) {
        lastSkippedHeaders.push(name);
        continue;
      }
      request.headers[name] = String(value);
    }
  });

  networkingEngine.registerResponseFilter((_type, response) => {
    // Restore the upstream URI after a proxied response. Shaka uses this URI
    // as the base for relative MPD segment paths.
    try {
      const responseUri = new URL(response.uri, window.location.origin);
      if (responseUri.origin === window.location.origin && responseUri.pathname === '/api/proxy') {
        const original = responseUri.searchParams.get('url');
        if (original) {
          response.uri = original;
          response.originalUri = original;
        }
      }
    } catch {
      // Keep the response unchanged when it is not a normal URL.
    }
  });
}

function makeProxyUrl(uri) {
  try {
    const parsed = new URL(uri, window.location.href);
    if (parsed.origin === window.location.origin && parsed.pathname === '/api/proxy') {
      return parsed.href;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return uri;
    }
    const proxy = new URL('/api/proxy', window.location.origin);
    proxy.searchParams.set('url', parsed.href);
    return proxy.href;
  } catch {
    return uri;
  }
}

async function playFromForm() {
  if (!player) {
    setStatus('The player is not initialized.', 'error');
    return;
  }

  const manifestUrl = elements.manifestUrl.value.trim();
  if (!manifestUrl) {
    setStatus('Enter an MPD or M3U8 manifest URL.', 'warning');
    return;
  }

  let parsedManifest;
  try {
    parsedManifest = new URL(manifestUrl);
    if (!['http:', 'https:'].includes(parsedManifest.protocol)) {
      throw new Error('Only HTTP and HTTPS URLs are supported.');
    }
  } catch (error) {
    setStatus(`Invalid manifest URL: ${error.message}`, 'error');
    return;
  }

  let headers;
  try {
    headers = parseHeaders(elements.requestHeaders.value);
  } catch (error) {
    setStatus(`Headers JSON error: ${error.message}`, 'error');
    return;
  }

  let clearKeyConfig;
  try {
    clearKeyConfig = parseClearKey(elements.clearKey.value);
  } catch (error) {
    setStatus(`ClearKey error: ${error.message}`, 'error');
    return;
  }

  activeSettings = {
    useProxy: elements.useProxy.checked,
    headers
  };

  elements.playButton.disabled = true;
  setStatus('Loading manifest…', 'info');

  try {
    await player.unload();
    player.resetConfiguration();

    const drm = {
      servers: {},
      clearKeys: {}
    };

    if (clearKeyConfig) {
      if (clearKeyConfig.serverUrl) {
        drm.servers['org.w3.clearkey'] = clearKeyConfig.serverUrl;
      } else {
        drm.clearKeys = clearKeyConfig.keys;
      }
    }

    const widevineUrl = elements.widevineUrl.value.trim();
    const widevineCertUrl = elements.widevineCertUrl.value.trim();

    if (widevineUrl) {
      drm.servers['com.widevine.alpha'] = assertHttpUrl(widevineUrl, 'Widevine license URL');
    }

    const configuration = {
      drm,
      preferredAudioLanguage: navigator.language || 'en',
      preferredTextLanguage: navigator.language || 'en',
      streaming: {
        lowLatencyMode: false,
        rebufferingGoal: 2,
        bufferingGoal: 20
      }
    };

    if (widevineCertUrl) {
      configuration.drm.advanced = {
        'com.widevine.alpha': {
          serverCertificateUri: assertHttpUrl(widevineCertUrl, 'Widevine certificate URL')
        }
      };
    }

    player.configure(configuration);
    await player.load(parsedManifest.href);

    const title = elements.streamTitle.value.trim() || 'Untitled stream';
    document.title = `${title} · MPD Player`;
    elements.nowPlayingTitle.textContent = title;
    elements.nowPlayingUrl.textContent = parsedManifest.href;
    elements.nowPlaying.hidden = false;

    try {
      await elements.video.play();
    } catch {
      // Autoplay can be blocked. The Shaka controls remain available.
    }

    const skipped = !activeSettings.useProxy && lastSkippedHeaders.length
      ? ` Browser-blocked headers skipped: ${lastSkippedHeaders.join(', ')}. Enable proxy mode if the source requires them.`
      : '';
    setStatus(`Stream loaded successfully.${skipped}`, skipped ? 'warning' : 'success');
  } catch (error) {
    showPlayerError(error);
  } finally {
    elements.playButton.disabled = false;
  }
}

async function stopPlayback() {
  if (!player) return;
  try {
    await player.unload();
    elements.nowPlaying.hidden = true;
    setStatus('Playback stopped.', 'info');
  } catch (error) {
    setStatus(`Could not stop playback: ${error.message || error}`, 'error');
  }
}

function parseHeaders(raw) {
  const value = raw.trim();
  if (!value) return {};
  const parsed = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Headers must be a JSON object.');
  }

  const result = {};
  for (const [name, headerValue] of Object.entries(parsed)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`Invalid header name: ${name}`);
    }
    if (headerValue === null || typeof headerValue === 'object') {
      throw new Error(`Header ${name} must have a string or number value.`);
    }
    result[name] = String(headerValue);
  }
  return result;
}

function parseClearKey(raw) {
  const value = raw.trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    return { serverUrl: assertHttpUrl(value, 'ClearKey license URL') };
  }

  if (/^[0-9a-fA-F]{32}\s*:\s*[0-9a-fA-F]{32}$/.test(value)) {
    const [kid, key] = value.split(':').map((part) => part.trim().toLowerCase());
    return { keys: { [kid]: key } };
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    // Support the extension's quoted-pair format without braces.
    try {
      parsed = JSON.parse(`{${value}}`);
    } catch {
      throw new Error('Use a hex key map, kid:key, an EME JWK set, or a license URL.');
    }
  }

  if (parsed && Array.isArray(parsed.keys)) {
    const keys = {};
    for (const item of parsed.keys) {
      if (!item || typeof item.kid !== 'string' || typeof item.k !== 'string') {
        throw new Error('Invalid JWK ClearKey entry.');
      }
      keys[base64UrlToHex(item.kid)] = base64UrlToHex(item.k);
    }
    validateClearKeyMap(keys);
    return { keys };
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('ClearKey data must be an object.');
  }

  const keys = {};
  for (const [kid, key] of Object.entries(parsed)) {
    keys[kid.toLowerCase()] = String(key).toLowerCase();
  }
  validateClearKeyMap(keys);
  return { keys };
}

function validateClearKeyMap(keys) {
  if (!Object.keys(keys).length) {
    throw new Error('At least one ClearKey pair is required.');
  }
  for (const [kid, key] of Object.entries(keys)) {
    if (!/^[0-9a-f]{32}$/.test(kid) || !/^[0-9a-f]{32}$/.test(key)) {
      throw new Error('Each ClearKey ID and key must be 32 hexadecimal characters.');
    }
  }
}

function base64UrlToHex(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('Invalid base64url value in JWK ClearKey data.');
  }
  return Array.from(binary, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function assertHttpUrl(value, label) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  return parsed.href;
}

function populateFromLocation() {
  const query = new URLSearchParams(window.location.search);
  let source = query.get('src') || '';
  let title = query.get('title') || '';
  let headers = query.get('headers') || '';
  let clearKey = query.get('ck') || '';
  let widevine = query.get('wv') || '';
  let certificate = query.get('wvc') || '';
  let proxy = query.get('proxy') === '1';

  const rawHash = window.location.hash.slice(1);
  if (rawHash && /^https?:\/\//i.test(rawHash)) {
    try {
      const extensionStyleUrl = new URL(rawHash);
      title ||= extensionStyleUrl.searchParams.get('title') || '';
      headers ||= extensionStyleUrl.searchParams.get('headers') || '';
      clearKey ||= extensionStyleUrl.searchParams.get('ck') || '';
      widevine ||= extensionStyleUrl.searchParams.get('wv') || '';
      certificate ||= extensionStyleUrl.searchParams.get('wvc') || '';
      proxy ||= extensionStyleUrl.searchParams.get('proxy') === '1';

      for (const parameter of ['title', 'headers', 'ck', 'wv', 'wvc', 'wvh', 'image', 'manifest_type', 'multistream', 'proxy']) {
        extensionStyleUrl.searchParams.delete(parameter);
      }
      source = extensionStyleUrl.href;
    } catch {
      source = rawHash;
    }
  }

  elements.manifestUrl.value = source;
  elements.streamTitle.value = title;
  elements.useProxy.checked = proxy;
  elements.requestHeaders.value = decodeMaybeBase64(headers);
  elements.clearKey.value = decodeMaybeBase64(clearKey);
  elements.widevineUrl.value = decodeMaybeBase64(widevine);
  elements.widevineCertUrl.value = decodeMaybeBase64(certificate);
}

function decodeMaybeBase64(value) {
  if (!value) return '';
  if (/^https?:\/\//i.test(value) || value.trim().startsWith('{') || value.includes(':')) {
    return value;
  }

  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}

async function copyPlayerLink() {
  const source = elements.manifestUrl.value.trim();
  if (!source) {
    setStatus('Enter a manifest URL before copying a link.', 'warning');
    return;
  }

  const link = new URL(window.location.origin + window.location.pathname);
  link.searchParams.set('src', source);
  if (elements.streamTitle.value.trim()) link.searchParams.set('title', elements.streamTitle.value.trim());
  if (elements.useProxy.checked) link.searchParams.set('proxy', '1');

  if (elements.includePrivateSettings.checked) {
    const privateFields = [
      ['headers', elements.requestHeaders.value.trim()],
      ['ck', elements.clearKey.value.trim()],
      ['wv', elements.widevineUrl.value.trim()],
      ['wvc', elements.widevineCertUrl.value.trim()]
    ];
    for (const [name, value] of privateFields) {
      if (value) link.searchParams.set(name, encodeBase64Url(value));
    }
  }

  try {
    await navigator.clipboard.writeText(link.href);
    setStatus(
      elements.includePrivateSettings.checked
        ? 'Player link copied. Warning: it contains DRM/header data in the URL.'
        : 'Player link copied without private DRM/header fields.',
      elements.includePrivateSettings.checked ? 'warning' : 'success'
    );
  } catch {
    setStatus(`Copy failed. Link:\n${link.href}`, 'warning');
  }
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function showPlayerError(error) {
  const code = error && typeof error.code !== 'undefined' ? `Shaka ${error.code}` : 'Playback error';
  const details = error && error.data ? `\n${safeStringify(error.data)}` : '';
  const message = error && error.message ? `: ${error.message}` : '';
  setStatus(`${code}${message}${details}`, 'error');
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function setStatus(message, type = 'info') {
  elements.status.textContent = message;
  elements.status.className = `status ${type}`;
}

function setSupport(supported, text) {
  elements.supportBadge.textContent = text;
  elements.supportBadge.style.borderColor = supported ? 'rgba(74, 222, 128, 0.35)' : 'rgba(248, 113, 113, 0.4)';
  elements.supportBadge.style.color = supported ? '#bbf7d0' : '#fecaca';
}
