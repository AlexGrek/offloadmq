venv:
	python3 -m venv venv
	bash -c "source venv/bin/activate && pip3 install -r requirements.txt"

register: venv
	bash -c "source venv/bin/activate && python offload-client.py --server http://localhost --key your-api-key"

sysinfo: venv
	bash -c "source venv/bin/activate && python offload-client.py sysinfo"

ollama: venv
	bash -c "source venv/bin/activate && python offload-client.py ollama"

.PHONY: sysinfo register ollama
