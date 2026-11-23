#!/usr/bin/env bash
# Read-only provjera tenanta u Domovina Fiskalu: GET /api/v1/postavke
# (poslovni prostori + cis_status, naplatni uređaji, operateri, PDV status).
# Ne izdaje ništa.
#
#   scripts/fiskal-postavke.sh <slug> <test|prod>
set -euo pipefail
cd "$(dirname "$0")/.."
slug=${1:?slug}; okolina=${2:?test|prod}
cfg="gas/events/$slug/okoline.json"
base=$(node -e "console.log(require('./$cfg').okoline['$okolina'].fiskalBaseUrl)")
kljuc_dat=$(node -e "console.log(require('./$cfg').okoline['$okolina'].apiKljucDatoteka)")
kljuc_dat="${kljuc_dat/#\~/$HOME}"
[ -f "$kljuc_dat" ] || { echo "✖ nema ključa: $kljuc_dat" >&2; exit 1; }
kljuc=$(tr -d '[:space:]' < "$kljuc_dat")
curl -sS -H "Authorization: Bearer $kljuc" "$base/postavke" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s),null,2))}catch{console.log(s)}})'
