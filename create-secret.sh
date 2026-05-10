#!/bin/bash
# Usage: fill in real values from 1Password / SSM before running.
# Never commit this file with real credentials.
kubectl -n cloudless create secret generic cloudless-manager-secrets \
  --from-literal=CF_TOKEN="<cloudflare-api-token>" \
  --from-literal=CF_ZONE_ID="<cloudflare-zone-id>" \
  --from-literal=CF_ACCOUNT_ID="<cloudflare-account-id>" \
  --from-literal=CF_TUNNEL_ID="<cloudflare-tunnel-uuid>" \
  --from-literal=AWS_ACCESS_KEY_ID="<aws-access-key-id>" \
  --from-literal=AWS_SECRET_ACCESS_KEY="<aws-secret-access-key>" \
  --from-literal=AWS_REGION="us-east-1" \
  --dry-run=client -o yaml | kubectl apply -f -
