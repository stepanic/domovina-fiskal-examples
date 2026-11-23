#!/usr/bin/env node
/**
 * Spoji GAS izvore u jedan Code.gs po eventu.
 *
 *   gas/events/<slug>/Config.gs  (CONFIG)
 * + gas/modules/*.gs             (Mapping.gs prvi, ostali abecedno)
 * → gas/dist/<slug>/Code.gs  +  appsscript.json
 *
 * Isti bundle ide i na TEST i na PROD — okolina se razlikuje samo po
 * Script Properties (FISKAL_BASE_URL, FISKAL_API_KEY) u bound projektu.
 *
 *   node scripts/build-gas.mjs            # svi eventi
 *   node scripts/build-gas.mjs primjer-konferencija-2027 # jedan
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAS = path.join(ROOT, 'gas');
const EVENTS = path.join(GAS, 'events');
const MODULES = path.join(GAS, 'modules');
const OUT = path.join(GAS, 'dist');

export const MANIFEST = {
  timeZone: 'Europe/Zagreb',
  dependencies: {},
  exceptionLogging: 'STACKDRIVER',
  runtimeVersion: 'V8',
};

function modules() {
  const all = fs.readdirSync(MODULES).filter((f) => f.endsWith('.gs')).sort();
  return ['Mapping.gs', ...all.filter((f) => f !== 'Mapping.gs')].filter((f) => all.includes(f));
}

// OKOLINE: sheetId → Fiskal base URL iz okoline.json (bez ključeva i putanja).
// Skripta po ID-u Sheeta bira okolinu — DEV Sheet ne može na PROD i obrnuto.
function okolineSekcija(slug, sep) {
  const p = path.join(EVENTS, slug, 'okoline.json');
  if (!fs.existsSync(p)) return '';
  const o = JSON.parse(fs.readFileSync(p, 'utf8')).okoline;
  const okoline = Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, { sheetId: v.sheetId, fiskalBaseUrl: v.fiskalBaseUrl }]),
  );
  const ids = Object.values(okoline).map((v) => v.sheetId);
  if (new Set(ids).size !== ids.length) throw new Error(`${slug}: okoline imaju isti sheetId`);
  return `${sep}\n// OKOLINE — iz events/${slug}/okoline.json\n${sep}\n\n` +
    `var OKOLINE = ${JSON.stringify(okoline, null, 2)};\n\n`;
}

export function buildEvent(slug) {
  const configPath = path.join(EVENTS, slug, 'Config.gs');
  if (!fs.existsSync(configPath)) throw new Error(`Nema ${configPath}`);
  const sources = [configPath, ...modules().map((m) => path.join(MODULES, m))];
  const sep = '// ' + '═'.repeat(76);
  const rel = (p) => path.relative(GAS, p);
  let out =
    `/**\n * AUTO-GENERATED — ne uređuj ovdje. Uredi izvore pa ponovi build.\n` +
    ` * Build:   scripts/build-gas.mjs\n * Event:   ${slug}\n` +
    ` * Izvori:  ${sources.map(rel).join(', ')}\n * Built:   ${new Date().toISOString()}\n */\n\n`;
  sources.forEach((s, i) => {
    out += `${sep}\n// SECTION ${i + 1}/${sources.length} — ${rel(s)}\n${sep}\n\n`;
    out += fs.readFileSync(s, 'utf8') + '\n\n';
    if (i === 0) out += okolineSekcija(slug, sep);
  });
  const dir = path.join(OUT, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Code.gs'), out);
  fs.writeFileSync(path.join(dir, 'appsscript.json'), JSON.stringify(MANIFEST, null, 2) + '\n');
  return path.join(dir, 'Code.gs');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv[2];
  const slugs = only
    ? [only]
    : fs.readdirSync(EVENTS).filter((d) => fs.existsSync(path.join(EVENTS, d, 'Config.gs'))).sort();
  for (const s of slugs) console.log(`✓ ${s.padEnd(16)} → ${path.relative(ROOT, buildEvent(s))}`);
}
