.PHONY: setup start install

setup:
	bash setup.sh

start:
	bash start.sh

start-port:
	PORT=$(PORT) bash start.sh

install:
	sudo cp kokoro-tts.service /etc/systemd/system/
	sudo systemctl daemon-reload
	sudo systemctl enable --now kokoro-tts
