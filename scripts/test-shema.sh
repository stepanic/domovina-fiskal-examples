#!/usr/bin/env bash
# Provjeri payloade iz scripts/test-gas.mjs pravom zod shemom Domovina Fiskala
# (racunModelShema iz github.com/domovinatv/domovina-fiskal, backend/src/validacija.ts).
# Bez mreže. Treba lokalni klon domovina-fiskal s instaliranim backend/node_modules:
#
#   git clone https://github.com/domovinatv/domovina-fiskal ../domovina-fiskal
#   (cd ../domovina-fiskal/backend && npm ci)
#   FISKAL_REPO=../domovina-fiskal scripts/test-shema.sh [slug]
#
# Bez klona se test preskače (exit 0), da `npm test` radi i bez njega.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${FISKAL_REPO:-$ROOT/../domovina-fiskal}"
B="$REPO/backend"
if [ ! -x "$B/node_modules/.bin/esbuild" ]; then
  echo "↷ test-shema preskočen: nema $B/node_modules (postavi FISKAL_REPO na klon domovina-fiskal)"
  exit 0
fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"; rm -f "$B/.shema-provjera.ts"' EXIT
ISPIS_PAYLOAD="$TMP/payloadi.json" node "$ROOT/scripts/test-gas.mjs" "${1:-primjer-konferencija-2027}" >/dev/null
cat > "$B/.shema-provjera.ts" <<'TS'
import { racunModelShema } from './src/validacija';
import fs from 'node:fs';
let palo = false;
for (const p of JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))) {
  const r = racunModelShema.safeParse(p);
  if (!r.success) palo = true;
  console.log(r.success ? '✓ shema OK ' + p.vanjskaReferenca : '✖ ' + JSON.stringify(r.error.issues));
}
process.exit(palo ? 1 : 0);
TS
(cd "$B" && ./node_modules/.bin/esbuild .shema-provjera.ts --bundle --platform=node --format=esm --outfile="$TMP/shema.mjs" --log-level=warning)
node "$TMP/shema.mjs" "$TMP/payloadi.json"
