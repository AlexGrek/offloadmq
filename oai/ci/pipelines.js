// OAI CI: build the frontend + Rust backend image on the Linux build agent and deploy to oai.
//
//   cr1t pipelines -p oai run deploy SHIP --follow     build + deploy + verify
//   cr1t pipelines -p oai run deploy VERIFY --follow   check the rollout on its own
//
// Project secrets used (every project secret reaches every shell call, masked):
//   DOCKERHUB_PASSWORD  value           -> Docker Hub access token for DOCKERHUB_LOGIN (push to grekodocker/*)
//   KUBE_TOKEN          value           -> token of SA oai/critical-deployer (namespace-scoped)
//   KUBE_CA             value, as file  -> path to the cluster CA certificate
//
// Shell text below uses $VAR, never ${VAR}: `${` inside a JS template literal is interpolation.

const BUILDER = "01M8FA5JP53HTEEPP49ZK827G8" // Linux build box (amd64, docker buildx, helm, kubectl)

env({
  KUBE_SERVER: "https://188.245.76.190:6443",
  NS: "oai",
  DOCKERHUB_LOGIN: "grekodocker", // not secret; masking it would hide every image name in logs
  RELEASE: "oai",
  IMAGE: "grekodocker/oai",
  PUBLIC_URL: "https://oai.alexgr.space",
})

const KUBECONFIG = `
export KUBECONFIG="$PWD/.kubeconfig"
kubectl config set-cluster k3s --server="$KUBE_SERVER" --certificate-authority="$KUBE_CA" --embed-certs >/dev/null
kubectl config set-credentials deployer --token="$KUBE_TOKEN" >/dev/null
kubectl config set-context k3s --cluster=k3s --user=deployer --namespace="$NS" >/dev/null
kubectl config use-context k3s >/dev/null
echo "kube identity: $(kubectl auth whoami -o jsonpath='{.status.userInfo.username}')"
`

function build() {
  require_cred("DOCKERHUB_PASSWORD")
  checkout()
  bash(`
TAG=$(git rev-parse --short=7 HEAD)
echo "== $TAG: $GIT_COMMIT_MESSAGE"

echo "== building oai frontend (VITE_APP_VERSION=$TAG)"
if command -v npm >/dev/null 2>&1 && node -v 2>/dev/null | grep -qE '^v2[0-9]'; then
  (cd oai/frontend && VITE_APP_VERSION="$TAG" npm ci --no-audit --no-fund && VITE_APP_VERSION="$TAG" npm run build)
else
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e VITE_APP_VERSION="$TAG" \\
    -v "$PWD:/w" -w /w/oai/frontend node:22-alpine sh -c "npm ci --no-audit --no-fund && npm run build"
fi

export DOCKER_CONFIG="$PWD/.docker"
mkdir -p "$DOCKER_CONFIG"
trap 'docker logout >/dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT
printf '%s' "$DOCKERHUB_PASSWORD" | docker login -u "$DOCKERHUB_LOGIN" --password-stdin >/dev/null

echo "== build + push $IMAGE:$TAG"
docker buildx build --progress=plain --platform linux/amd64 \\
  --build-arg OAI_BUILD_VERSION="$TAG" \\
  -t "$IMAGE:$TAG" -t "$IMAGE:latest" \\
  -f oai/Dockerfile --push oai > build.log 2>&1 \\
  || { tail -60 build.log; exit 1; }
grep -E "Finished|built in|naming to" build.log | tail -3
`, { runner: BUILDER, timeout: 3600 })
}

function deploy() {
  require_cred("KUBE_TOKEN")
  require_cred("KUBE_CA")
  checkout()
  bash(KUBECONFIG + `
TAG=$(git rev-parse --short=7 HEAD)
docker buildx imagetools inspect "$IMAGE:$TAG" >/dev/null || { echo "missing image $IMAGE:$TAG (run SHIP, not deploy alone)"; exit 1; }
helm lint oai/helm-chart --quiet
echo "== helm upgrade $RELEASE -> $NS @ $TAG"
helm upgrade --install "$RELEASE" oai/helm-chart -n "$NS" --set image.tag="$TAG"
`, { runner: BUILDER, timeout: 600 })
}

function verify() {
  require_cred("KUBE_TOKEN")
  require_cred("KUBE_CA")
  bash(KUBECONFIG + `
kubectl rollout status deployment/$RELEASE --timeout=5m
helm status "$RELEASE" | sed -n '1,6p'
kubectl get pods -o wide | awk '{print $1, $2, $3, $7}'
kubectl get deploy "$RELEASE" -o jsonpath='image: {.spec.template.spec.containers[0].image}{"\\n"}'
echo "api /api/health: $(curl -sf -m 10 "$PUBLIC_URL/api/health")"
echo "api /api/version: $(curl -sf -m 10 "$PUBLIC_URL/api/version")"
curl -sf -m 10 "$PUBLIC_URL/api/health" >/dev/null
`, { runner: BUILDER, timeout: 600 })
}

SHIP = [build, deploy, verify]
BUILD = [build]
VERIFY = [verify]
