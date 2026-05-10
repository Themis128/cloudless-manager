#!/bin/bash
# deploy.sh — rebuild and redeploy cloudless-manager in k3s
# Usage: bash deploy.sh
set -e

APP_DIR="/home/tbaltzakis/cloudless-manager"
IMAGE="cloudless-manager:latest"
NAMESPACE="cloudless"
DEPLOYMENT="cloudless-manager"

echo "==> Building Docker image..."
docker build -t "$IMAGE" "$APP_DIR"

echo "==> Importing image into k3s containerd..."
docker save "$IMAGE" | sudo k3s ctr images import -

echo "==> Restarting deployment..."
kubectl -n "$NAMESPACE" rollout restart deployment/"$DEPLOYMENT"

echo "==> Waiting for rollout..."
kubectl -n "$NAMESPACE" rollout status deployment/"$DEPLOYMENT" --timeout=60s

echo ""
kubectl -n "$NAMESPACE" get pods -l app="$DEPLOYMENT"
echo ""
echo "✅ Done — https://manage.cloudless.online"
