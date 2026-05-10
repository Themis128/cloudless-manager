# deploy.ps1 — sync local changes to Pi and redeploy cloudless-manager
# Usage: .\deploy.ps1
# Optional: .\deploy.ps1 -SkipSync  (just restart, no file transfer)

param([switch]$SkipSync)

$PI       = "tbaltzakis@192.168.1.128"
$REMOTE   = "/home/tbaltzakis/cloudless-manager"
$LOCAL    = $PSScriptRoot
$SSH_OPTS = "-o StrictHostKeyChecking=no"

# Files to sync
$files = @(
    "server.js",
    "package.json",
    "Dockerfile",
    "public/index.html",
    "public/manifest.json",
    "public/sw.js",
    "public/icons/icon.svg",
    "public/icons/icon-maskable.svg",
    "k8s/deployment.yaml"
)

if (-not $SkipSync) {
    Write-Host "==> Ensuring remote directories exist..." -ForegroundColor Cyan
    ssh $SSH_OPTS $PI "mkdir -p $REMOTE/public/icons $REMOTE/k8s"

    Write-Host "==> Syncing files to Pi..." -ForegroundColor Cyan
    foreach ($f in $files) {
        $src = Join-Path $LOCAL $f
        $dst = "$PI`:$REMOTE/$f"
        $result = scp $SSH_OPTS $src $dst 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "    OK  $f" -ForegroundColor Green
        } else {
            Write-Host "    ERR $f`: $result" -ForegroundColor Red
            exit 1
        }
    }
}

Write-Host "==> Running deploy on Pi..." -ForegroundColor Cyan
ssh $SSH_OPTS $PI "bash $REMOTE/deploy.sh"

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "✅ Deployed: https://manage.cloudless.online" -ForegroundColor Green
} else {
    Write-Host "❌ Deploy failed" -ForegroundColor Red
    exit 1
}
