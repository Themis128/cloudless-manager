#!/bin/bash
# deploy.sh — rebuild and redeploy cloudless-manager in k3s
# Usage: bash deploy.sh
# Requires: docker already logged in to ghcr.io
#   gh auth token | docker login ghcr.io -u Themis128 --password-stdin
set -e

APP_DIR="/home/tbaltzakis/cloudless-manager"
REGISTRY="ghcr.io/themis128"
IMAGE_NAME="cloudless-manager"
IMAGE="$REGISTRY/$IMAGE_NAME:latest"
NAMESPACE="cloudless"
DEPLOYMENT="cloudless-manager"

echo "==> Building Docker image ($IMAGE)..."
docker build -t "$IMAGE" "$APP_DIR"

echo "==> Pushing image to GHCR..."
docker push "$IMAGE"

echo "==> Restarting deployment..."
kubectl -n "$NAMESPACE" rollout restart deployment/"$DEPLOYMENT"

echo "==> Waiting for rollout..."
kubectl -n "$NAMESPACE" rollout status deployment/"$DEPLOYMENT" --timeout=120s

echo ""
kubectl -n "$NAMESPACE" get pods -l app="$DEPLOYMENT" -o wide
echo ""
echo "✅ Done — https://manage.cloudless.online"
