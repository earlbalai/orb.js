/**
 * Pre-generates the demo phrase audio once, so the site never spends API credit
 * at runtime.
 *
 * The phrase set is fixed, so hitting a TTS API on every visitor click costs
 * money per play, adds a round trip, and dies outright when the key is missing
 * or rate-limited. Generated once and committed, the demo is free, instant, and
 * works with no key configured.
 *
 * Keeps the audio same-origin too: an AnalyserNode cannot read cross-origin
 * audio, so a CDN-hosted clip would drive the orb from a fake envelope instead
 * of the real waveform.
 *
 * Run locally, never on Vercel:
 *
 *   OPENAI_API_KEY=sk-... node scripts/generate-phrases.mjs
 *   OPENAI_API_KEY=sk-... node scripts/generate-phrases.mjs --voice=nova --force
 *
 * Then commit audio/. Vercel serves it statically.
 *
 * Output goes to the repo root rather than public/, because vercel.json sets
 * outputDirectory "." and a file in public/audio would be served at
 * /public/audio/... while the page asks for /audio/...
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PHRASES } from '../src/phrases.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'audio');

// gpt-4o-mini-tts is the cheap steerable one. Override for tts-1 if needed.
const MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';
const ENDPOINT = 'https://api.openai.com/v1/audio/speech';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const FORCE = args.includes('--force');
const VOICE = flag('voice', 'alloy');

const exists = (p) => access(p, constants.F_OK).then(() => true, () => false);

async function synth(text) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      voice: VOICE,
      input: text,
      response_format: 'mp3',
    }),
  });

  if (!res.ok) {
    // The API's own message, never the key or the request headers.
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(`OpenAI ${res.status} ${res.statusText}: ${detail.slice(0, 400)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      'OPENAI_API_KEY is not set.\n' +
      '  PowerShell:  $env:OPENAI_API_KEY="sk-..."; node scripts/generate-phrases.mjs\n' +
      '  bash:        OPENAI_API_KEY=sk-... node scripts/generate-phrases.mjs'
    );
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });

  const chars = PHRASES.reduce((n, p) => n + p.text.length, 0);
  console.log(
    `${PHRASES.length} phrases, ${chars} characters, model ${MODEL}, voice ${VOICE}`
  );
  console.log(`output: ${OUT_DIR}\n`);

  const manifest = [];
  let generated = 0;
  let skipped = 0;

  for (const phrase of PHRASES) {
    const file = `${phrase.id}.mp3`;
    const path = join(OUT_DIR, file);

    if (!FORCE && (await exists(path))) {
      console.log(`  skip   ${file}  (exists, pass --force to regenerate)`);
      skipped++;
    } else {
      process.stdout.write(`  synth  ${file} ... `);
      const audio = await synth(phrase.text);
      await writeFile(path, audio);
      console.log(`${(audio.length / 1024).toFixed(1)} KB`);
      generated++;
    }

    manifest.push({
      id: phrase.id,
      label: phrase.label,
      state: phrase.state,
      text: phrase.text,
      src: `/audio/${file}`,
    });
  }

  await writeFile(
    join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ model: MODEL, voice: VOICE, phrases: manifest }, null, 2) + '\n'
  );

  console.log(
    `\ndone: ${generated} generated, ${skipped} skipped, manifest written.\n` +
    'Commit audio/ so the deployed demo costs nothing to play.'
  );
}

main().catch((err) => {
  console.error(`\nfailed: ${err.message}`);
  process.exit(1);
});
