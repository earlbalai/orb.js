/**
 * POST /api/tts: text in, real OpenAI speech audio out.
 *
 * OrbAudioSource.speech() synthesises formant babble. The motion is right but
 * nobody mistakes it for a person, so this serves actual voice instead.
 *
 * Server-side, for the key and for CORS. OPENAI_API_KEY is read here and the
 * browser only ever receives audio bytes. And createMediaElementSource() on a
 * cross-origin, non-CORS media element hands an AnalyserNode silence, so calling
 * api.openai.com from the page would leave the orb with nothing to measure;
 * src/orb.js spots that (isAnalysable) and quietly degrades to
 * OrbAudioSource.synthetic(), an envelope running alongside the sound rather
 * than measured from it. Bytes from our own origin, or from here under the CORS
 * headers below, become a Blob and an object URL, which isAnalysable() accepts.
 *
 * Browser side:
 *   const r = await fetch(TTS_URL, {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ text: 'Hello, I am your assistant.', voice: 'nova' })
 *   });
 *   if (!r.ok) throw new Error((await r.json()).error.message);
 *   const el = new Audio(URL.createObjectURL(await r.blob()));
 *   orb.setAudioSource(OrbAudioSource.fromMedia(el));  // from a user gesture
 *   await el.play();
 *
 * Request  (application/json):
 *   { text: string (1..4000), voice?: string, model?: string, format?: string,
 *     speed?: number (0.25..4.0), instructions?: string (<=1000) }
 * Response:
 *   200 audio bytes, Content-Type audio/mpeg (or the requested format's type)
 *   4xx/5xx application/json { error: { message, type?, code?, status } }
 *
 * Global fetch and node builtins only. No packages, no build step.
 */

/* OpenAI's speech voices. ballad and verse are the most expressive, nova and
 * shimmer the brightest, onyx the deepest. Anything off this list is a 400, so
 * a typo shows up here rather than as an opaque upstream error. */
const VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo',
  'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse',
];
const DEFAULT_VOICE = 'alloy';

/* gpt-4o-mini-tts sounds the most natural and is the only one that honours the
 * 'instructions' field (tone direction, e.g. "warm, unhurried"). Accounts
 * without access to it fall back to tts-1 below, so an org that has not been
 * granted the newer model gets a voice rather than an error. */
const PRIMARY_MODEL = 'gpt-4o-mini-tts';
const FALLBACK_MODEL = 'tts-1';
const ALLOWED_MODELS = [PRIMARY_MODEL, FALLBACK_MODEL, 'tts-1-hd', 'gpt-4o-audio-preview'];

/* mp3 is small and every browser decodes it. Doubles as the allow-list. */
const FORMATS = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/L16',
};
const DEFAULT_FORMAT = 'mp3';

const MAX_TEXT = 4000;            // OpenAI's own ceiling for /audio/speech
const MAX_INSTRUCTIONS = 1000;
const UPSTREAM_TIMEOUT_MS = 25000;

const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';

/* helpers */

/** Wide open CORS so the hosted embed works from any customer origin. */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Timing-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');
}

/** Belt and braces. Nothing key-shaped goes out, whatever upstream said. */
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

/**
 * Vercel's Node runtime usually parses JSON onto req.body, but not for every
 * content-type or local runner, so drain the stream when it has not.
 */
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;

  let raw = req.body;
  if (raw == null) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 256 * 1024) throw new Error('Request body too large');
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
  let message = 'The speech provider returned ' + response.status + '.';
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
    /* consumed or unreadable, keep the generic message */
  }
  return { message, type, code };
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
    sendError(res, 405, 'Method not allowed. Use POST with a JSON body.');
    return;
  }

  // Read here and only here. Never returned, never logged.
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // 501, not 500: nothing has crashed, the deployment is unconfigured.
    sendJson(res, 501, {
      error: {
        message:
          'This Orb deployment has no speech provider configured. The operator ' +
          'must set the OPENAI_API_KEY environment variable in the Vercel project ' +
          'settings (Settings -> Environment Variables) and redeploy. The key is ' +
          'read server-side only and is never sent to the browser.',
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

  /* validate */

  const text = body.text;
  if (typeof text !== 'string') {
    sendError(res, 400, 'Field "text" is required and must be a string.');
    return;
  }
  const input = text.trim();
  if (input.length === 0) {
    sendError(res, 400, 'Field "text" must not be empty.');
    return;
  }
  if (input.length > MAX_TEXT) {
    sendError(res, 400, 'Field "text" must be at most ' + MAX_TEXT + ' characters (received ' + input.length + ').');
    return;
  }

  const voice = body.voice === undefined ? DEFAULT_VOICE : body.voice;
  if (typeof voice !== 'string' || !VOICES.includes(voice)) {
    sendError(res, 400, 'Field "voice" must be one of: ' + VOICES.join(', ') + '.');
    return;
  }

  const model = body.model === undefined ? PRIMARY_MODEL : body.model;
  if (typeof model !== 'string' || !ALLOWED_MODELS.includes(model)) {
    sendError(res, 400, 'Field "model" must be one of: ' + ALLOWED_MODELS.join(', ') + '.');
    return;
  }

  const format = body.format === undefined ? DEFAULT_FORMAT : body.format;
  if (typeof format !== 'string' || !Object.prototype.hasOwnProperty.call(FORMATS, format)) {
    sendError(res, 400, 'Field "format" must be one of: ' + Object.keys(FORMATS).join(', ') + '.');
    return;
  }

  let speed;
  if (body.speed !== undefined) {
    if (typeof body.speed !== 'number' || !Number.isFinite(body.speed) || body.speed < 0.25 || body.speed > 4) {
      sendError(res, 400, 'Field "speed" must be a number between 0.25 and 4.0.');
      return;
    }
    speed = body.speed;
  }

  let instructions;
  if (body.instructions !== undefined) {
    if (typeof body.instructions !== 'string' || body.instructions.length > MAX_INSTRUCTIONS) {
      sendError(res, 400, 'Field "instructions" must be a string of at most ' + MAX_INSTRUCTIONS + ' characters.');
      return;
    }
    instructions = body.instructions;
  }

  /* POST /v1/audio/speech { model, input, voice, response_format, speed?,
   * instructions? } -> raw audio bytes, or a JSON error envelope. No fields we
   * do not need. */

  const requestBody = { model, input, voice, response_format: format };
  if (speed !== undefined) requestBody.speed = speed;
  // The tts-1 family rejects unknown fields, so 'instructions' only goes to the
  // gpt-4o-* models.
  if (instructions !== undefined && model.startsWith('gpt-4o')) {
    requestBody.instructions = instructions;
  }

  async function callOpenAI(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      return await fetch(OPENAI_SPEECH_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  let response;
  try {
    response = await callOpenAI(requestBody);

    // Retry once on tts-1 when the account cannot reach gpt-4o-mini-tts, so the
    // demo still speaks. 404 / 400 / 403 are the statuses that complain about
    // the model rather than the request. 429 and 5xx pass straight through.
    const modelRejected = !response.ok
      && (response.status === 404 || response.status === 400 || response.status === 403)
      && requestBody.model === PRIMARY_MODEL;

    if (modelRejected) {
      const detail = await describeUpstreamFailure(response);
      const looksLikeModelProblem = /model/i.test(detail.message)
        || detail.code === 'model_not_found'
        || response.status === 404;
      if (looksLikeModelProblem) {
        const retry = { model: FALLBACK_MODEL, input, voice, response_format: format };
        if (speed !== undefined) retry.speed = speed;
        response = await callOpenAI(retry);
      } else {
        // Our request's fault, so report it instead of retrying.
        sendError(res, response.status, detail.message, detail);
        return;
      }
    }
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    sendError(
      res,
      aborted ? 504 : 502,
      aborted
        ? 'The speech provider did not respond in time.'
        : 'Could not reach the speech provider.',
    );
    return;
  }

  if (!response.ok) {
    const detail = await describeUpstreamFailure(response);
    // Mirror the upstream status where a client can act on it. Upstream 5xx
    // collapses to 502 so the fault clearly is not here.
    const status = response.status >= 500 ? 502 : response.status;
    sendError(res, status, detail.message, detail);
    return;
  }

  let audio;
  try {
    audio = Buffer.from(await response.arrayBuffer());
  } catch {
    sendError(res, 502, 'The speech provider returned an unreadable response.');
    return;
  }

  if (audio.length === 0) {
    sendError(res, 502, 'The speech provider returned empty audio.');
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', FORMATS[format]);
  res.setHeader('Content-Length', String(audio.length));
  res.setHeader('Cache-Control', 'no-store');
  // Play it, do not offer it as a download.
  res.setHeader('Content-Disposition', 'inline');
  res.end(audio);
}
