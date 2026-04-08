#!/usr/bin/env python3
"""End-to-end test: upload a PDF via storage API, submit an LLM task, verify the agent
extracts text and gets a response from Ollama (moondream model)."""

import sys
import os
import time
import threading
import requests

# Add offload-agent to path so we can import agent modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "offload-agent"))

SERVER = "http://localhost:3069"
CLIENT_API_KEY = "client_secret_key_123"
AGENT_API_KEY = "ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e"
PDF_PATH = os.path.expanduser("~/Downloads/Failed HIP Check.pdf")
CAPABILITY = "llm.moondream"


def main():
    print("=== PDF Analyzer E2E Test ===\n")

    # 1. Register agent
    print("[1] Registering agent...")
    from app.httphelpers import register_agent, authenticate_agent
    reg = register_agent(
        SERVER, capabilities=[CAPABILITY], tier=1, capacity=1, api_key=AGENT_API_KEY
    )
    agent_id = reg["agentId"]
    agent_key = reg["key"]
    print(f"    Agent registered: {agent_id[:12]}...")

    # 2. Authenticate agent
    print("[2] Authenticating agent...")
    auth = authenticate_agent(SERVER, agent_id, agent_key)
    jwt_token = auth["token"]
    print(f"    JWT obtained (expires in {auth['expiresIn']}s)")

    # 3. Start agent serving in background
    print("[3] Starting agent in background...")
    from app.core import serve_tasks
    stop_event = threading.Event()
    agent_thread = threading.Thread(
        target=serve_tasks, args=(SERVER, jwt_token, stop_event), daemon=True
    )
    agent_thread.start()
    time.sleep(2)  # let agent start polling

    # 4. Create bucket
    print("[4] Creating file bucket...")
    resp = requests.post(
        f"{SERVER}/api/storage/bucket/create",
        headers={"X-API-Key": CLIENT_API_KEY},
    )
    resp.raise_for_status()
    bucket_uid = resp.json()["bucket_uid"]
    print(f"    Bucket: {bucket_uid[:12]}...")

    # 5. Upload PDF
    print(f"[5] Uploading {os.path.basename(PDF_PATH)}...")
    with open(PDF_PATH, "rb") as f:
        resp = requests.post(
            f"{SERVER}/api/storage/bucket/{bucket_uid}/upload",
            headers={"X-API-Key": CLIENT_API_KEY},
            files={"file": (os.path.basename(PDF_PATH), f, "application/pdf")},
        )
    resp.raise_for_status()
    upload_info = resp.json()
    print(f"    Uploaded: {upload_info['original_name']} ({upload_info['size']} bytes)")
    print(f"    SHA-256: {upload_info['sha256'][:16]}...")

    # 6. Submit blocking task
    print("[6] Submitting blocking LLM task...")
    task_payload = {
        "capability": CAPABILITY,
        "urgent": True,
        "restartable": False,
        "payload": {
            "messages": [{"role": "user", "content": "Summarize this document in 2-3 sentences."}],
            "stream": False,
        },
        "file_bucket": [bucket_uid],
        "fetchFiles": [],
        "artifacts": [],
        "apiKey": CLIENT_API_KEY,
    }
    resp = requests.post(f"{SERVER}/api/task/submit_blocking", json=task_payload, timeout=120)
    resp.raise_for_status()
    result = resp.json()

    # 7. Show result
    print("\n[7] === RESULT ===")
    message = result.get("output", {}).get("message", {})
    if message.get("content"):
        print(f"    Model response:\n    {message['content'][:500]}")
    else:
        print(f"    Raw result: {str(result)[:500]}")

    status = result.get("status")
    if status and "success" in str(status):
        print("\n    STATUS: SUCCESS")
    else:
        print(f"\n    STATUS: {status}")

    # 8. Cleanup
    print("\n[8] Cleaning up...")
    stop_event.set()
    requests.delete(
        f"{SERVER}/api/storage/bucket/{bucket_uid}",
        headers={"X-API-Key": CLIENT_API_KEY},
    )
    print("    Bucket deleted. Done!")


if __name__ == "__main__":
    main()
