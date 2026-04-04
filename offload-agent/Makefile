SERVER ?= http://localhost:3069
KEY ?= ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e

# Version injected at build time (override: make build VERSION=v0.3.260).
# Same rules as scripts/release-agent.sh (see scripts/compute-agent-version.sh).
# Avoids a bare "dev" string so PyInstaller binaries always report a concrete version.
_COMPUTE_VER := $(abspath $(CURDIR)/../scripts/compute-agent-version.sh)
VERSION ?= $(shell bash "$(_COMPUTE_VER)" 2>/dev/null || echo "v0.0.0")

venv:
	python3 -m venv venv
	bash -c "source venv/bin/activate && pip3 install -r requirements.txt"

# Production web UI bundle (required for packaged agent and make webui)
frontend-build:
	cd frontend && npm ci && npm run build

register: venv
	bash -c "source venv/bin/activate && python offload-agent.py cli register --server $(SERVER) --key $(KEY)"

serve: register
	bash -c "source venv/bin/activate && python offload-agent.py cli serve"

sysinfo: venv
	bash -c "source venv/bin/activate && python offload-agent.py cli sysinfo"

ollama: venv
	bash -c "source venv/bin/activate && python offload-agent.py cli ollama"

# Standalone binary: rebuilds frontend then PyInstaller
build: venv frontend-build
	@echo "Installing PyInstaller..."
	bash -c "source venv/bin/activate && pip install pyinstaller --quiet"
	@echo "APP_VERSION = '$(VERSION)'" > app/_version.py
	@echo "Building binary with PyInstaller (version: $(VERSION))..."
	bash -c "source venv/bin/activate && python -m PyInstaller --onefile --name offload-agent \
		--add-data 'app:app' \
		--add-data 'webui.py:.' \
		--add-data 'webui_comfy.py:.' \
		--add-data 'frontend/dist:frontend/dist' \
		offload-agent.py"
	@echo ""
	@echo "Build complete. The binary is located in the 'dist' directory."

typecheck: venv
	bash -c "source venv/bin/activate && python -m mypy"

# Install binary + register + set up headless systemd service (no webui)
# Usage: make install-systemd SERVER=https://offloadmq.alexgr.space KEY=<agent_key>
install-systemd: build
	sudo ./dist/offload-agent install bin
	cd ~ && offload-agent cli register --server $(SERVER) --key $(KEY)
	$(MAKE) _write-systemd-service

# Register only (binary already installed), then set up headless systemd service
# Usage: make register-systemd SERVER=https://offloadmq.alexgr.space KEY=<agent_key>
register-systemd:
	cd ~ && offload-agent cli register --server $(SERVER) --key $(KEY)
	$(MAKE) _write-systemd-service

_write-systemd-service:
	@printf '[Unit]\nDescription=Offload Agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=%s\nWorkingDirectory=%s\nExecStart=/usr/local/bin/offload-agent cli serve\nRestart=on-failure\nRestartSec=10\n\n[Install]\nWantedBy=multi-user.target\n' \
		"$(shell whoami)" "$(HOME)" \
		| sudo tee /etc/systemd/system/offload-agent.service > /dev/null
	sudo systemctl daemon-reload
	sudo systemctl enable offload-agent
	sudo systemctl restart offload-agent
	@echo "Done. Check: systemctl status offload-agent"

# Build and upload for the current platform to dl.alexgr.space
# Version is auto-detected; override with: make release VERSION=v0.3.260
# Requires: DL_API_KEY env var
release:
	../scripts/release-agent.sh $(if $(VERSION),$(VERSION),)

rebuild: clean build

clean:
	@echo "Cleaning up build artifacts..."
	rm -rf build/ dist/ offload-agent.spec
	@echo "Cleanup complete."

webui: venv frontend-build
	bash -c "source venv/bin/activate && python offload-agent.py webui"

.PHONY: sysinfo register ollama build rebuild clean webui frontend-build typecheck install-systemd register-systemd _write-systemd-service release
