#!/data/data/com.termux/files/usr/bin/bash
# tools/export_manifest.sh
# Schrijft ZEEBESLAG_MANIFEST.txt in de projectroot.
cd "$(dirname "$0")/.." || exit 1
OUT=ZEEBESLAG_MANIFEST.txt
HAVE_NODE=$(command -v node >/dev/null 2>&1 && echo 1 || echo 0)

{
echo "ZEEBESLAG MANIFEST"
echo "gegenereerd: $(date -Iseconds)"
echo "projectroot: $(pwd)"
echo "node:        $([ "$HAVE_NODE" = 1 ] && node -v || echo 'niet aanwezig')"
echo

echo "=== BUILD ==="
grep -h "export const BUILD" src/main.js 2>/dev/null || echo "geen BUILD gevonden"
grep -o 'babylon-[0-9.]*\.js' index.html 2>/dev/null | head -1
echo

echo "=== BOOM (bestanden met grootte) ==="
find . -type f \
  -not -path './.git/*' -not -path './node_modules/*' \
  -not -name 'ZEEBESLAG_MANIFEST.txt' \
  -printf '%12s  %TY-%Tm-%Td %TH:%TM  %p\n' 2>/dev/null | sort -k4 \
  || find . -type f -not -path './.git/*' | sort
echo

echo "=== TOTALEN PER MAP ==="
find . -type d -not -path './.git*' -not -path './node_modules*' | sort | while read -r d; do
  n=$(find "$d" -maxdepth 1 -type f | wc -l)
  s=$(du -sh "$d" 2>/dev/null | cut -f1)
  printf '%-40s %3s bestanden  %8s\n' "$d/" "$n" "$s"
done
echo

echo "=== ATLASSEN: afmetingen uit de PNG-header ==="
if [ "$HAVE_NODE" = 1 ]; then
node - <<'JS'
const fs=require('fs'),path=require('path');
function png(p){const b=fs.readFileSync(p);
  if(b.length<24||b.readUInt32BE(0)!==0x89504e47) return null;
  return {w:b.readUInt32BE(16),h:b.readUInt32BE(20)};}
function walk(d,o=[]){for(const f of fs.readdirSync(d)){const p=path.join(d,f);
  const st=fs.statSync(p);
  if(st.isDirectory()){ if(!/\.git|node_modules/.test(p)) walk(p,o); }
  else if(/\.png$/i.test(f)) o.push(p);} return o;}
for(const p of walk('.').sort()){
  const d=png(p); const kb=(fs.statSync(p).size/1024).toFixed(0);
  console.log(`${p.padEnd(48)} ${d?`${d.w}x${d.h}`.padEnd(12):'(geen png?)   '} ${kb} kB`);
}
JS
else
  echo "node ontbreekt: draai 'pkg install nodejs' voor atlasafmetingen"
  find . -iname '*.png' | sort
fi
echo

echo "=== ASSETPADEN DIE DE CODE VERWACHT ==="
grep -rhoE "'\./[^']*\.(png|glb|webm|mp4|jpg|hdr|env)'" src/ index.html 2>/dev/null \
  | tr -d "'" | sort -u | while read -r u; do
    f="${u#./}"
    if [ -f "$f" ]; then printf 'OK       %s\n' "$u"
    else printf 'ONTBREEKT %s\n' "$u"; fi
  done
echo

echo "=== ASSETS DIE OP SCHIJF STAAN MAAR NERGENS IN DE CODE ==="
find . -type f \( -iname '*.png' -o -iname '*.glb' -o -iname '*.webm' -o -iname '*.mp4' \) \
  -not -path './.git/*' | sed 's|^\./||' | sort | while read -r f; do
    grep -rq "$(basename "$f")" src/ index.html 2>/dev/null || echo "  ongebruikt: $f"
  done
echo

echo "=== FX_PATHS uit atlasFx.js ==="
sed -n '/export const FX_PATHS/,/};/p' src/game/atlasFx.js 2>/dev/null
echo

echo "=== EERSTE REGEL VAN ELKE MODULE (padcommentaar) ==="
find src -name '*.js' | sort | while read -r f; do
  printf '%-42s %s\n' "$f" "$(head -1 "$f" | cut -c1-70)"
done
echo

echo "=== SYNTAXCONTROLE ==="
if [ "$HAVE_NODE" = 1 ]; then
  bad=0
  for f in $(find src -name '*.js'); do
    node --check "$f" 2>/dev/null || { echo "FOUT $f"; bad=1; }
  done
  [ $bad -eq 0 ] && echo "alle modules parsen schoon"
else
  echo "overgeslagen, geen node"
fi
} > "$OUT" 2>&1

echo "geschreven: $(pwd)/$OUT  ($(wc -l < "$OUT") regels)"
