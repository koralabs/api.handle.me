#!/usr/bin/env bash
set -euo pipefail

# Run with:
# ./shell/build-valkeyutility-zip.sh

for cmd in node npm npx zip; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Missing required command: $cmd" >&2
        exit 1
    fi
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR="$(mktemp -d /tmp/valkeyutility-build.XXXXXX)"
OUT_DIR="${REPO_ROOT}/tmp"
OUT_ZIP="${OUT_DIR}/valkeyutility.zip"
MAX_BYTES=$((10 * 1024 * 1024))

cleanup() {
    rm -rf "$WORKDIR"
}
trap cleanup EXIT

IOREDIS_VERSION="$(cd "$REPO_ROOT" && node -e "const lock=require('./package-lock.json'); const pkg=require('./package.json'); const v=lock?.packages?.['node_modules/ioredis']?.version || (pkg.dependencies?.ioredis||'').replace(/^[^0-9]*/, ''); if(!v) throw new Error('Unable to resolve ioredis version'); process.stdout.write(v);")"

mkdir -p "$WORKDIR/build" "$OUT_DIR"

cat > "$WORKDIR/package.json" <<JSON
{
  "name": "valkeyutility-lambda",
  "version": "0.0.0",
  "private": true,
  "type": "commonjs",
  "dependencies": {
    "ioredis": "${IOREDIS_VERSION}"
  }
}
JSON

(cd "$REPO_ROOT" && npx tsc lambdas/valkeyutility.ts --target ES2022 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck --outDir "$WORKDIR/build")

COMPILED_JS="$(find "$WORKDIR/build" -maxdepth 4 -type f -name 'valkeyutility.js' | head -n 1)"
if [[ -z "$COMPILED_JS" ]]; then
    echo "Failed to locate compiled valkeyutility.js output" >&2
    exit 1
fi
cp "$COMPILED_JS" "$WORKDIR/index.js"
rm -rf "$WORKDIR/build"

(cd "$WORKDIR" && npm install --omit=dev --no-package-lock --silent)

rm -f "$OUT_ZIP"
(cd "$WORKDIR" && zip -qr "$OUT_ZIP" index.js node_modules package.json)

ZIP_BYTES="$(wc -c < "$OUT_ZIP")"
ZIP_MIB="$(awk "BEGIN { printf \"%.2f\", ${ZIP_BYTES} / 1048576 }")"

echo "Created $OUT_ZIP (${ZIP_MIB} MiB)"

if (( ZIP_BYTES > MAX_BYTES )); then
    echo "ERROR: Zip exceeds 10 MiB limit (${ZIP_BYTES} bytes > ${MAX_BYTES} bytes)." >&2
    exit 1
fi

echo "Zip is under 10 MiB."
