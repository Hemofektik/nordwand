#!/usr/bin/env bash
set -euo pipefail

# Deploys dist/ to nordwand.hemofektik.de via FTP.
#
# Credentials come from the environment (never hardcode them here):
#   HEMOFEKTIK_FTP_USER  required - FTP user
#   HEMOFEKTIK_FTP_PW    required - FTP password
#   HEMOFEKTIK_FTP_HOST  optional - defaults to nordwand.hemofektik.de
#   HEMOFEKTIK_FTP_DIR   optional - remote base directory, defaults to the
#                        per-domain web root /nordwand.hemofektik.de/
#
# The FTP root holds one directory per vhost; the site is served from the
# directory named after the domain, NOT from the FTP root.

: "${HEMOFEKTIK_FTP_USER:?HEMOFEKTIK_FTP_USER is not set}"
: "${HEMOFEKTIK_FTP_PW:?HEMOFEKTIK_FTP_PW is not set}"

HOST="${HEMOFEKTIK_FTP_HOST:-nordwand.hemofektik.de}"
REMOTE_DIR="${HEMOFEKTIK_FTP_DIR:-/nordwand.hemofektik.de/}"
DIST="dist"

if [ ! -d "$DIST" ]; then
    echo "dist/ not found - run 'npm run build' first" >&2
    exit 1
fi

# Keep the password out of the process list: hand curl a config file instead
# of --user on the command line.
CURL_CFG="$(mktemp)"
trap 'rm -f "$CURL_CFG"' EXIT
cat >"$CURL_CFG" <<EOF
user = "${HEMOFEKTIK_FTP_USER}:${HEMOFEKTIK_FTP_PW}"
EOF
chmod 600 "$CURL_CFG"

count=0
while IFS= read -r -d '' file; do
    rel="${file#"$DIST"/}"
    url="ftp://${HOST}${REMOTE_DIR%/}/${rel}"
    curl --fail --silent --show-error \
        --config "$CURL_CFG" \
        --ftp-create-dir \
        --upload-file "$file" \
        "$url"
    count=$((count + 1))
    echo "uploaded $rel"
done < <(find "$DIST" -type f -print0)

echo "deployed $count files to ${HOST}"