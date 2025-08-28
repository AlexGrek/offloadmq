venv:
	python3 -m venv venv
	bash -c "source venv/bin/activate && pip3 install -r requirements.txt"

register: venv
	bash -c "source venv/bin/activate && python offload-client.py register --server http://localhost:3069 --key ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e"

serve: register
	bash -c "source venv/bin/activate && python offload-client.py serve"

sysinfo: venv
	bash -c "source venv/bin/activate && python offload-client.py sysinfo"

ollama: venv
	bash -c "source venv/bin/activate && python offload-client.py ollama"

# The build target creates the standalone binary using PyInstaller
build: venv
	@echo "Installing PyInstaller..."
	bash -c "source venv/bin/activate && pip install pyinstaller --quiet"
	@echo "Building binary with PyInstaller..."
	bash -c "source venv/bin/activate && pyinstaller --onefile --name offload-client offload-client.py"
	@echo ""
	@echo "Build complete. The binary is located in the 'dist' directory."

# The clean target removes all generated build files and the binary
clean:
	@echo "Cleaning up build artifacts..."
	rm -rf build/ dist/ offload-client.spec
	@echo "Cleanup complete."


.PHONY: sysinfo register ollama build clean
