#!/bin/bash
# Deploy cloudless-edge CF Worker via API (no wrangler needed)
# Requires CF token with: Workers Scripts:Edit + Zone:Workers Routes:Edit
#
# Usage:
#   CF_TOKEN=<token> CF_ACCOUNT_ID=<acct> CF_ZONE_ID=<zone> bash deploy.sh
#
# Or source the k8s secret:
#   eval "$(kubectl get secret cloudless-manager-secrets -n cloudless \
#     -o go-template='{{range $k,$v := .data}}export {{$k}}="{{$v | base64decode}}"{{"\n"}}{{end}}')"
#   bash deploy.sh

set -euo pipefail

SCRIPT_NAME="cloudless-edge"
WORKER_FILE="$(dirname "$0")/cloudless-edge.js"

: "${CF_TOKEN:?CF_TOKEN is required}"
: "${CF_ACCOUNT_ID:?CF_ACCOUNT_ID is required}"
: "${CF_ZONE_ID:?CF_ZONE_ID is required}"

echo "==> Uploading Worker script '$SCRIPT_NAME'..."
curl -sf -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}" \
  -H "Authorization: Bearer ${CF_TOKEN}" \
  -F "index.js=@${WORKER_FILE};type=application/javascript+module" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('upload:',d['success'],d.get('errors','')[:1])"

echo "==> Setting Worker route: cloudless.online/*"
curl -sf -X POST \
  "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/workers/routes" \
  -H "Authorization: Bearer ${CF_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"pattern\":\"cloudless.online/*\",\"script\":\"${SCRIPT_NAME}\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('route cloudless.online:',d['success'],d.get('errors','')[:1])"

echo "==> Setting Worker route: manage.cloudless.online/*"
curl -sf -X POST \
  "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/workers/routes" \
  -H "Authorization: Bearer ${CF_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"pattern\":\"manage.cloudless.online/*\",\"script\":\"${SCRIPT_NAME}\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('route manage:',d['success'],d.get('errors','')[:1])"

echo ""
echo "✅ Worker deployed. Test:"
echo "   curl -sI https://cloudless.online/_next/static/chunks/<hash>.js | grep X-Cache"
