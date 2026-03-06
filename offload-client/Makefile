SERVER ?= http://localhost:3069
KEY ?= ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e

venv:
	python3 -m venv venv
	bash -c "source venv/bin/activate && pip3 install -r requirements.txt"

register: venv
	bash -c "source venv/bin/activate && python offload-client.py cli register --server $(SERVER) --key $(KEY)"

serve: register
	bash -c "source venv/bin/activate && python offload-client.py cli serve"

sysinfo: venv
	bash -c "source venv/bin/activate && python offload-client.py cli sysinfo"

ollama: venv
	bash -c "source venv/bin/activate && python offload-client.py cli ollama"

# The build target creates the standalone binary using PyInstaller
build: venv
	@echo "Installing PyInstaller..."
	bash -c "source venv/bin/activate && pip install pyinstaller --quiet"
	@echo "Building binary with PyInstaller..."
	bash -c "source venv/bin/activate && python -m PyInstaller --onefile --name offload-client --add-data 'app:app' --add-data 'webui.py:.' offload-client.py"
	@echo ""
	@echo "Build complete. The binary is located in the 'dist' directory."

# rebuild: clean up previous artifacts then build fresh
rebuild: clean build

# The clean target removes all generated build files and the binary
clean:
	@echo "Cleaning up build artifacts..."
	rm -rf build/ dist/ offload-client.spec
	@echo "Cleanup complete."


webui: venv
	bash -c "source venv/bin/activate && python offload-client.py webui"

.PHONY: sysinfo register ollama build rebuild clean webui
