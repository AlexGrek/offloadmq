APP_NAME := offloadmq
CHART_DIR := offloadmq-chart
NAMESPACE := offloadmq
RELEASE := offloadmq

# Detect Git version if TAG is not provided
TAG ?= $(shell git describe --tags --always --dirty)
IMAGE ?= localhost:5000/offloadmq
SECRETS_FILE ?= .secrets.yaml

.PHONY: build push install upgrade uninstall status template deploy

# Build Docker image
build:
	docker build -t $(IMAGE):$(TAG) .

# Push Docker image
push:
	docker push $(IMAGE):$(TAG)

# Install Helm chart
install:
	helm install $(RELEASE) $(CHART_DIR) \
		--namespace $(NAMESPACE) --create-namespace \
		--set image.repository=$(IMAGE) \
		--set image.tag=$(TAG) \
		-f $(SECRETS_FILE)

# Upgrade Helm release
upgrade:
	helm upgrade $(RELEASE) $(CHART_DIR) \
		--namespace $(NAMESPACE) \
		--set image.repository=$(IMAGE) \
		--set image.tag=$(TAG) \
		-f $(SECRETS_FILE)

# Uninstall release
uninstall:
	helm uninstall $(RELEASE) --namespace $(NAMESPACE)

# Show release status
status:
	helm status $(RELEASE) --namespace $(NAMESPACE)

# Render manifests without installing
template:
	helm template $(RELEASE) $(CHART_DIR) \
		--namespace $(NAMESPACE) \
		--set image.repository=$(IMAGE) \
		--set image.tag=$(TAG) \
		-f $(SECRETS_FILE)

# Build, push, and install/upgrade in one go
deploy: build push
	@if [ ! -f $(SECRETS_FILE) ]; then \
		echo "ERROR: Secrets file '$(SECRETS_FILE)' not found!"; \
		exit 1; \
	fi
	@if helm status $(RELEASE) -n $(NAMESPACE) >/dev/null 2>&1; then \
		echo "Upgrading $(RELEASE) to $(IMAGE):$(TAG) ..."; \
		$(MAKE) upgrade; \
	else \
		echo "Installing $(RELEASE) as $(IMAGE):$(TAG) ..."; \
		$(MAKE) install; \
	fi


dev-mq:
	cargo run

dev-agent:
	cd offload-client && make serve

dev-frontend:
	cd management-frontend && npm run dev
