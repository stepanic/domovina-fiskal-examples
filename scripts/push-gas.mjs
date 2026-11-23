#!/usr/bin/env node
/**
 * Build + clasp push jednog eventa u bound GAS projekt jedne okoline.
 *
 *   node scripts/push-gas.mjs <slug> <test|prod>
 *
 * scriptId se čita iz gas/events/<slug>/okoline.json → okoline.<okolina>.scriptId
 * (upiši ga tamo nakon `clasp create`, vidi docs/google-forms.md).
 * Radni dir za clasp: gas/dist/<slug>/<okolina>/ (Code.gs + appsscript.json + .clasp.json).
 *
 * PROD push traži potvrdu: dodaj --da-prod.
 * clasp nije u PATH-u (nvm v24)? CLASP=~/.nvm/versions/node/v22.18.0/bin/clasp
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildEvent } from './build-gas.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [slug, okolina, ...flags] = process.argv.slice(2);
const fail = (m) => { console.error(`✖ ${m}`); process.exit(1); };

if (!slug || !['test', 'prod'].includes(okolina)) fail('Upotreba: node scripts/push-gas.mjs <slug> <test|prod> [--da-prod]');
if (okolina === 'prod' && !flags.includes('--da-prod')) fail('PROD push: ponovi s --da-prod (pravi Sheet, pravi CIS).');

const okoline = JSON.parse(fs.readFileSync(path.join(ROOT, 'gas/events', slug, 'okoline.json'), 'utf8'));
const env = okoline.okoline[okolina];
if (!env?.scriptId) fail(`Nema scriptId za ${slug}/${okolina} u okoline.json — prvo clasp create (docs/google-forms.md).`);
if (/^</.test(env.sheetId || '<')) fail(`sheetId za ${slug}/${okolina} je još placeholder — upiši ID svog Sheeta u okoline.json.`);

const code = buildEvent(slug);
const dir = path.join(path.dirname(code), okolina);
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(code, path.join(dir, 'Code.gs'));
fs.copyFileSync(path.join(path.dirname(code), 'appsscript.json'), path.join(dir, 'appsscript.json'));
fs.writeFileSync(path.join(dir, '.clasp.json'), JSON.stringify({ scriptId: env.scriptId, rootDir: dir }, null, 2) + '\n');

console.log(`▶ clasp push ${slug}/${okolina} (scriptId ${env.scriptId})`);
const r = spawnSync(process.env.CLASP || 'clasp', ['push', '-f'], { cwd: dir, stdio: 'inherit' });
if (r.status !== 0) fail(`clasp push nije uspio (exit ${r.status})`);
console.log(`✓ ${slug}/${okolina} pushan. Sheet: https://docs.google.com/spreadsheets/d/${env.sheetId}/edit`);
