/**
 * POST /api/realtime-token: mints a short-lived ephemeral client secret for the
 * OpenAI Realtime API.
 *
 * The live-conversation counterpart to /api/tts. Instead of finished audio for a
 * scripted line, the browser gets a credential it can use to open its own WebRTC
 * session, so the orb can be driven by real interruptible two-way voice.
 *
 * The browser receives the ephemeral token and nothing else. OPENAI_API_KEY is
 * read from the environment here, used once for this exchange, and never put in
 * a response or a log line. The ephemeral secret covers one Realtime session and
 * expires in about a minute, so a leaked one is worth almost nothing. The
 * standing key would be worth the account.
 *
 * SECURITY: do not ship this as it stands. Anyone who can reach the URL can mint
 * tokens and spend your OpenAI credit. The wildcard CORS below is what makes the
 * hosted embed work from a customer origin and it is also what makes this
 * abusable. Fine for a demo, not for anything carrying real traffic. Before it
 * does, at minimum:
 *   - authenticate. A signed session cookie, a customer API key, or a
 *     short-lived nonce your own app issues, and an origin allow-list in place
 *     of the ACAO wildcard.
 *   - rate limit per IP and per customer, in durable storage (Vercel KV,
 *     Upstash, your own database). An in-memory counter is useless when any
 *     invocation may be a cold instance.
 *   - set a spend ceiling and alerting on the OpenAI account, as the backstop
 *     for whatever the first two miss.
 * None of it is implemented below.
 *
 * Browser side:
 *   const { client_secret } = await (await fetch(TOKEN_URL, { method: 'POST' })).json();
 *   const pc = new RTCPeerConnection();
 *   pc.ontrack = (e) => orb.setAudioSource(OrbAudioSource.fromStream(e.streams[0]));
 *   ... offer/answer against the Realtime endpoint using client_secret.value ...
 *
 * fromStream() is the source to use here: src/orb.js rebinds its
 * MediaStreamAudioSourceNode when the track set changes, which a WebRTC stream
 * arriving from ontrack does routinely.
 *
 * Request  (application/json, all fields optional):
 *   { model?: string, voice?: string }
 * Response:
 *   200 { client_secret: { value: string, expires_at: number },
 *         model: string, voice: string | null, expires_at: number }
 *   4xx/5xx { error: { message, type?, code?, status } }
 *
 * Global fetch and node builtins only. No packages, no build step.
 */

/* Speech-to-speech models. gpt-realtime is GA; the preview id stays as a
 * fallback for accounts that have not been moved over yet. */
const PRIMARY_MODEL = 'gpt-realtime';
const FALLBACK_MODEL = 'gpt-4o-realtime-preview';
const ALLOWED_MODELS = [
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  'gpt-realtime-mini',
  'gpt-4o-mini-realtime-preview',
];

/* Realtime voices. marin and cedar sound the most natural and exist only
 * here, not in the /audio/speech list. */
const VOICES = [
  'alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo',
  'marin', 'sage', 'shimmer', 'verse',
];
const DEFAULT_VOICE = 'alloy';

/* client_secrets is current, sessions is the older shape. Both are tried, so
 * this works against either API generation. */
const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const LEGACY_SESSIONS_URL = 'https://api.openai.com/v1/realtime/sessions';

const UPSTREAM_TIMEOUT_MS = 10000;

/* helpers */

/** Wide open CORS so the hosted embed works from a customer origin. See the
 *  security note above; production wants an origin allow-list instead. */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

/** Nothing key-shaped goes out, whatever upstream said. */
function redact(text) {
  return String(text == null ? '' : text).replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-***');
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function sendError(res, status, message, extra) {
  const error = { message: redact(message), status };
  if (extra && extra.type) error.type = redact(extra.type);
  if (extra && extra.code) error.code = redact(extra.code);
  sendJson(res, status, { error });
}

/** Vercel usually parses JSON onto req.body; drain the stream when it has not. */
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;

  let raw = req.body;
  if (raw == null) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 64 * 1024) throw new Error('Request body too large');
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } else if (Buffer.isBuffer(raw)) {
    raw = raw.toString('utf8');
  }

  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

/** The useful part of an OpenAI error, without the headers. */
async function describeUpstreamFailure(response) {
  let message = 'The realtime provider returned ' + response.status + '.';
  let type;
  let code;
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.error) {
        if (parsed.error.message) message = parsed.error.message;
        type = parsed.error.type;
        code = parsed.error.code;
      }
    } catch {
      if (text) message = text.slice(0, 500);
    }
  } catch {
    /* unreadable body, keep the generic message */
  }
  return { message, type, code };
}

/**
 * The two API generations put the secret in different places:
 *   /v1/realtime/client_secrets -> { value, expires_at, session }
 *   /v1/realtime/sessions       -> { client_secret: { value, expires_at }, ... }
 * One shape out, so the browser does not have to care which one ran.
 */
function normaliseSecret(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.value === 'string') {
    return { value: payload.value, expires_at: payload.expires_at ?? null, session: payload.session ?? null };
  }
  if (payload.client_secret && typeof payload.client_secret.value === 'string') {
    return {
      value: payload.client_secret.value,
      expires_at: payload.client_secret.expires_at ?? null,
      session: payload,
    };
  }
  return null;
}

/* handler */

export default async function handler(req, res) {
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    sendError(res, 405, 'Method not allowed. Use POST.');
    return;
  }

  // Read here and only here. Never returned, never logged.
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // 501, not 500: nothing has crashed, the deployment is unconfigured.
    sendJson(res, 501, {
      error: {
        message:
          'This Orb deployment has no realtime provider configured. The operator ' +
          'must set the OPENAI_API_KEY environment variable in the Vercel project ' +
          'settings (Settings -> Environment Variables) and redeploy. The key is ' +
          'read server-side only; the browser only ever receives the short-lived ' +
          'ephemeral token minted from it.',
        type: 'configuration_error',
        code: 'missing_openai_api_key',
        status: 501,
      },
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendError(res, 400, err && err.message ? err.message : 'Malformed request body.');
    return;
  }

  const model = body.model === undefined ? PRIMARY_MODEL : body.model;
  if (typeof model !== 'string' || !ALLOWED_MODELS.includes(model)) {
    sendError(res, 400, 'Field "model" must be one of: ' + ALLOWED_MODELS.join(', ') + '.');
    return;
  }

  const voice = body.voice === undefined ? DEFAULT_VOICE : body.voice;
  if (typeof voice !== 'string' || !VOICES.includes(voice)) {
    sendError(res, 400, 'Field "voice" must be one of: ' + VOICES.join(', ') + '.');
    return;
  }

  async function post(url, payload, extraHeaders) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'POST',
        headers: Object.assign(
          {
            Authorization: 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
          },
          extraHeaders || {},
        ),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /* Current shape.
   *   POST /v1/realtime/client_secrets
   *     { session: { type: 'realtime', model, audio: { output: { voice } } } }
   *   -> { value, expires_at, session } */
  const currentPayload = {
    session: {
      type: 'realtime',
      model,
      audio: { output: { voice } },
    },
  };

  /* Older generation, needs the OpenAI-Beta: realtime=v1 header.
   *   POST /v1/realtime/sessions { model, voice }
   *   -> { client_secret: { value, expires_at }, ... } */
  const legacyPayload = { model, voice };

  let response;
  let usedLegacy = false;
  try {
    response = await post(CLIENT_SECRETS_URL, currentPayload);

    // Fall back when this account's API generation does not know the newer
    // endpoint or its request shape. 429 and 5xx are real failures rather than
    // shape mismatches, so they pass straight through.
    if (!response.ok && (response.status === 404 || response.status === 400)) {
      const detail = await describeUpstreamFailure(response);
      response = await post(LEGACY_SESSIONS_URL, legacyPayload, { 'OpenAI-Beta': 'realtime=v1' });
      usedLegacy = true;
      if (!response.ok) {
        // Prefer the legacy endpoint's complaint, fall back to the first one's.
        const legacyDetail = await describeUpstreamFailure(response);
        const chosen = legacyDetail.message ? legacyDetail : detail;
        const status = response.status >= 500 ? 502 : response.status;
        sendError(res, status, chosen.message, chosen);
        return;
      }
    }
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    sendError(
      res,
      aborted ? 504 : 502,
      aborted
        ? 'The realtime provider did not respond in time.'
        : 'Could not reach the realtime provider.',
    );
    return;
  }

  if (!response.ok) {
    const detail = await describeUpstreamFailure(response);
    const status = response.status >= 500 ? 502 : response.status;
    sendError(res, status, detail.message, detail);
    return;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    sendError(res, 502, 'The realtime provider returned an unreadable response.');
    return;
  }

  const secret = normaliseSecret(payload);
  if (!secret) {
    sendError(res, 502, 'The realtime provider returned no ephemeral client secret.');
    return;
  }

  // Back to the browser: the ephemeral secret and the session facts needed to
  // open the connection. Nothing else from the upstream payload.
  sendJson(res, 200, {
    client_secret: { value: secret.value, expires_at: secret.expires_at },
    model,
    voice,
    expires_at: secret.expires_at,
    api: usedLegacy ? 'realtime/sessions' : 'realtime/client_secrets',
  });
}
