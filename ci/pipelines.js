// OffloadMQ CI: build server + management-frontend images on the Linux build agent and deploy to offloadmq.
//
//   cr1t pipelines -p offloadmq run deploy SHIP --follow     build + pre-pull + deploy
//   cr1t pipelines -p offloadmq run deploy VERIFY --follow   check the rollout afterwards
//
// Project secrets used (every project secret reaches every shell call, masked):
//   DOCKERHUB_PASSWORD      value           -> Docker Hub access token for DOCKERHUB_LOGIN (push to grekodocker/*)
//   KUBE_TOKEN              value           -> token of SA offloadmq/critical-deployer (namespace-scoped)
//   KUBE_CA                 value, as file  -> path to the cluster CA certificate
//   OFFLOADMQ_SECRETS_YAML  value, as file  -> .secrets.yaml values file for helm upgrade
//
// Because OffloadMQ itself brokers Critical's pipeline shell tasks, `deploy` pre-pulls the new
// images on cluster nodes while the broker is up, then hands `helm upgrade` to the cluster (no
// --wait) and exits before offloadmq-0 restarts. Run VERIFY afterwards to confirm the rollout.
//
// Shell text below uses $VAR, never ${VAR}: `${` inside a JS template literal is interpolation.

const BUILDER = "01M8FA5JP53HTEEPP49ZK827G8" // Linux build box (amd64, docker buildx, helm, kubectl)

env({
  KUBE_SERVER: "https://188.245.76.190:6443",
  NS: "offloadmq",
  DOCKERHUB_LOGIN: "grekodocker", // not secret; masking it would hide every image name in logs
  RELEASE: "offloadmq",
  IMAGE: "grekodocker/offloadmq",
  FRONTEND_IMAGE: "grekodocker/offloadmq-management-frontend",
  PUBLIC_URL: "https://offloadmq.alexgr.space",
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
git fetch -q --unshallow origin 2>/dev/null || true
TAG=$(git rev-list --count HEAD)
SHA=$(git rev-parse --short=7 HEAD)
echo "== tag $TAG ($SHA): $GIT_COMMIT_MESSAGE"
export DOCKER_CONFIG="$PWD/.docker"
mkdir -p "$DOCKER_CONFIG"
trap 'docker logout >/dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT
printf '%s' "$DOCKERHUB_PASSWORD" | docker login -u "$DOCKERHUB_LOGIN" --password-stdin >/dev/null

push() {  # image dockerfile context; full build log only on failure
  echo "== build + push $1:$TAG"
  docker buildx build --progress=plain --platform linux/amd64 -t "$1:$TAG" -f "$2" --push "$3" > build.log 2>&1 \\
    || { tail -60 build.log; exit 1; }
  grep -E "Finished|built in|naming to" build.log | tail -3
}
push "$IMAGE" Dockerfile .
push "$FRONTEND_IMAGE" management-frontend/Dockerfile management-frontend
`, { runner: BUILDER, timeout: 3600 })
}

function deploy() {
  require_cred("KUBE_TOKEN")
  require_cred("KUBE_CA")
  require_cred("OFFLOADMQ_SECRETS_YAML")
  checkout()
  bash(KUBECONFIG + `
git fetch -q --unshallow origin 2>/dev/null || true
TAG=$(git rev-list --count HEAD)
for img in "$IMAGE" "$FRONTEND_IMAGE"; do
  docker buildx imagetools inspect "$img:$TAG" >/dev/null || { echo "missing image $img:$TAG (run SHIP, not deploy alone)"; exit 1; }
done

set -- \\
  -n "$NS" \\
  --set image.repository="$IMAGE" \\
  --set image.tag="$TAG" \\
  --set frontend.image.repository="$FRONTEND_IMAGE" \\
  --set frontend.image.tag="$TAG" \\
  --set appVersion="$TAG" \\
  -f "$OFFLOADMQ_SECRETS_YAML"

helm lint offloadmq-chart -f "$OFFLOADMQ_SECRETS_YAML" --quiet

if helm status "$RELEASE" -n "$NS" >/dev/null 2>&1; then
  echo "== pre-pulling images on cluster nodes ($TAG)"
  helm template "$RELEASE" offloadmq-chart "$@" --set imagePullPolicy.preLoadImages=true \\
    | kubectl apply -n "$NS" -f - >/dev/null
  job="offloadmq-image-pull-$TAG"
  elapsed=0
  while [ "$elapsed" -lt 120 ]; do
    sleep 5; elapsed=$((elapsed + 5))
    if kubectl wait --for=condition=Complete "job/$job" -n "$NS" --timeout=5s >/dev/null 2>&1; then
      echo "pre-pull complete"
      kubectl delete "job/$job" -n "$NS" --ignore-not-found=true >/dev/null 2>&1 || true
      break
    fi
    if ! kubectl get "job/$job" -n "$NS" >/dev/null 2>&1; then
      break
    fi
  done
fi

echo "== helm upgrade $RELEASE -> $NS @ $TAG"
helm upgrade --install "$RELEASE" offloadmq-chart "$@"
echo "Rollout started. OffloadMQ restarts now; check it with: cr1t pipelines -p offloadmq run deploy VERIFY --follow"
`, { runner: BUILDER, timeout: 600 })
}

function verify() {
  require_cred("KUBE_TOKEN")
  require_cred("KUBE_CA")
  bash(KUBECONFIG + `
kubectl rollout status statefulset/$RELEASE --timeout=5m
kubectl rollout status deployment/$RELEASE-frontend --timeout=5m
helm status "$RELEASE" | sed -n '1,6p'
kubectl get pods -o wide | awk '{print $1, $2, $3, $7}'
kubectl get statefulset "$RELEASE" -o jsonpath='server image: {.spec.template.spec.containers[0].image}{"\\n"}'
kubectl get deploy "$RELEASE-frontend" -o jsonpath='frontend image: {.spec.template.spec.containers[0].image}{"\\n"}'
echo "api /health: $(curl -sf -m 10 "$PUBLIC_URL/health")"
echo "ui: HTTP $(curl -s -o /dev/null -w '%{http_code}' -m 10 "$PUBLIC_URL/ui/")"
curl -sf -m 10 "$PUBLIC_URL/health" >/dev/null
`, { runner: BUILDER, timeout: 600 })
}

SHIP = [build, deploy]
BUILD = [build]
VERIFY = [verify]
