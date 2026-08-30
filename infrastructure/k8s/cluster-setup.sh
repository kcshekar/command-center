#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-time cluster setup — run this ONCE on a fresh GKE cluster.
# After this, .github/workflows/deploy.yml handles all future deployments.
#
# Prerequisites:
#   - gcloud authenticated and pointing to the correct project
#   - kubectl connected to the target cluster
#   - helm installed (brew install helm)
#   - A global static IP reserved:
#       gcloud compute addresses create command-center-ip --global
#
# Usage:
#   chmod +x infrastructure/k8s/cluster-setup.sh
#   ./infrastructure/k8s/cluster-setup.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

STATIC_IP_NAME="command-center-ip"
NAMESPACE="command-center"

echo "=== 1. Create application namespace ==="
kubectl apply -f ./base/namespace.yaml

echo ""
echo "=== 2. Install cert-manager CRDs ==="
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.0/cert-manager.crds.yaml
helm repo add jetstack https://charts.jetstack.io --force-update
helm repo update

echo ""
echo "=== 3. Install cert-manager ==="
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.14.0 \
  --set installCRDs=true \
  --set global.leaderElection.namespace=cert-manager \
  --set controller.leaderElection.namespace=cert-manager \
  --set cainjector.leaderElection.namespace=cert-manager \
  --set webhook.leaderElection.namespace=cert-manager

echo "cert-manager installed."

echo ""
echo "=== 4. Install Issuer, Secrets and Ingress ==="
kubectl apply -f ./base/ingress/issuer.yaml -n "${NAMESPACE}"
kubectl get issuer letsencrypt-staging -n "${NAMESPACE}"
echo "Issuer created."

kubectl apply -f ./base/ingress/secret.yaml -n "${NAMESPACE}"
kubectl get secret -n "${NAMESPACE}"
echo "Secret placeholder created."

kubectl apply -f ./base/ingress/ingress.yaml -n "${NAMESPACE}"
kubectl get ingress -n "${NAMESPACE}"

echo "Waiting for cert-manager components to settle..."
sleep 60

STATIC_IP="$(gcloud compute addresses describe "${STATIC_IP_NAME}" --global --format='value(address)' 2>/dev/null || echo '<not found — reserve it first, see header comment>')"

echo ""
echo "=== Setup complete! ==="
echo ""
echo "DNS check — point your domain (see base/ingress/ingress.yaml) at:"
echo "  ${STATIC_IP}"
echo ""
echo "Once DNS resolves, trigger a deploy by pushing to main (staging) or"
echo "publishing a GitHub Release (production)."
echo "cert-manager will auto-issue an SSL certificate on the first ingress apply."
