import pytest
from pathlib import Path
import tempfile
import shutil
import requests
import json
import time


API_URL = "http://localhost:3069/api/task/submit_blocking"
API_KEY = "client_secret_key_123"


class FileReference:
    def __init__(self, path: str, git_clone=None, get=None, post=None, 
                 request=None, http_login=None, http_password=None, 
                 http_auth_header=None, custom_header=None, s3_file=None,
                 custom_auth=None):
        self.path = path
        self.git_clone = git_clone
        self.get = get
        self.post = post
        self.request = request
        self.http_login = http_login
        self.http_password = http_password
        self.http_auth_header = http_auth_header
        self.custom_header = custom_header
        self.s3_file = s3_file
        self.custom_auth = custom_auth
    
    def to_dict(self):
        return {k: v for k, v in {
            'path': self.path,
            'gitClone': self.git_clone,
            'get': self.get,
            'post': self.post,
            'request': self.request,
            'httpLogin': self.http_login,
            'httpPassword': self.http_password,
            'httpAuthHeader': self.http_auth_header,
            'customHeader': self.custom_header,
            's3File': self.s3_file,
            'customAuth': self.custom_auth,
        }.items() if v is not None}


def submit_task(capability, payload, fetch_files=None, artifacts=None, 
                urgent=True, restartable=False):
    request_body = {
        "capability": capability,
        "urgent": urgent,
        "restartable": restartable,
        "payload": payload,
        "apiKey": API_KEY,
    }
    
    if fetch_files:
        request_body["fetchFiles"] = [f.to_dict() for f in fetch_files]
    if artifacts:
        request_body["artifacts"] = [a.to_dict() for a in artifacts]
    
    print("\n" + "="*80)
    print("REQUEST:")
    print("="*80)
    print(f"POST {API_URL}")
    print(f"\nHeaders:")
    print(f"  Content-Type: application/json")
    print(f"\nBody:")
    print(json.dumps(request_body, indent=2))
    print("="*80)
    
    response = requests.post(API_URL, json=request_body, timeout=30)
    
    print("\nRESPONSE:")
    print("="*80)
    print(f"Status Code: {response.status_code}")
    print(f"\nBody:")
    try:
        response_json = response.json()
        print(json.dumps(response_json, indent=2))
    except:
        print(response.text)
    print("="*80 + "\n")
    
    response.raise_for_status()
    return response.json()


@pytest.fixture
def temp_dir():
    temp_path = Path(tempfile.mkdtemp())
    yield temp_path
    shutil.rmtree(temp_path)


def test_simple_bash_command():
    result = submit_task(
        capability="shell::bash",
        payload={"command": "echo 'Hello World'"}
    )
    
    assert result["data"]["capability"] == "shell::bash"
    assert result["status"] in ["completed", "success"]
    assert "result" in result or "output" in result


def test_bash_list_directory():
    result = submit_task(
        capability="shell::bash",
        payload={"command": "ls -la"}
    )
    
    assert result["data"]["capability"] == "shell::bash"
    assert result["status"] in ["completed", "success"]


def test_bash_with_multiline():
    result = submit_task(
        capability="shell::bash",
        payload={
            "command": "echo 'Line 1'\necho 'Line 2'\necho 'Line 3'"
        }
    )
    
    assert result["data"]["capability"] == "shell::bash"
    assert result["status"] in ["completed", "success"]


def test_git_clone_fetch():
    fetch_files = [
        FileReference(
            path="repos/test-repo",
            git_clone="https://github.com/octocat/Hello-World.git"
        )
    ]
    
    result = submit_task(
        capability="shell::bash",
        payload={"command": "ls -la repos/test-repo"},
        fetch_files=fetch_files
    )
    
    assert result["data"]["capability"] == "shell::bash"
    assert result["status"] in ["completed", "success"]


def test_http_get_fetch():
    fetch_files = [
        FileReference(
            path="downloads/test.json",
            get="https://api.github.com/users/octocat"
        )
    ]
    
    result = submit_task(
        capability="shell::bash",
        payload={"command": "cat downloads/test.json"},
        fetch_files=fetch_files
    )
    
    assert result["data"]["capability"] == "shell::bash"
    assert result["status"] in ["completed", "success"]


def test_http_with_custom_header():
    fetch_files = [
        FileReference(
            path="downloads/api-response.json",
            get="https://api.github.com/zen",
            custom_header={"Accept": "application/json"}
        )
    ]
    
    result = submit_task(
        capability="shell::bash",
        payload={"command": "cat downloads/api-response.json"},
        fetch_files=fetch_files
    )
    
    assert result["data"]["capability"] == "shell::bash"
    assert result["status"] in ["completed", "success"]


def test_multiple_fetch_files():
    fetch_files = [
        FileReference(
            path="file1.txt",
            get="https://raw.githubusercontent.com/octocat/Hello-World/master/README"
        ),
        FileReference(
            path="repos/sample",
            git_clone="https://github.com/octocat/Hello-World.git"
        )
    ]
    
    result = submit_task(
        capability="shell::bash",
        payload={"command": "ls -la && cat file1.txt"},
        fetch_files=fetch_files
    )
    
    assert result["data"]["capability"] == "shell::bash"
    assert result["status"] in ["completed", "success"]


def test_urgent_task():
    result = submit_task(
        capability="shell::bash",
        payload={"command": "echo 'Urgent task'"},
        urgent=True
    )
    
    assert result["data"]["capability"] == "shell::bash"
    assert result["data"]["urgent"] == True
    assert result["status"] in ["completed", "success"]


def test_restartable_task():
    result = submit_task(
        capability="shell::bash",
        payload={"command": "echo 'Restartable task'"},
        restartable=True
    )
    
    assert result["data"]["capability"] == "shell::bash"
    assert result["data"]["restartable"] == True
    assert result["status"] in ["completed", "success"]


def test_artifact_creation():
    artifacts = [
        FileReference(
            path="output/result.txt"
        )
    ]
    
    result = submit_task(
        capability="shell::bash",
        payload={"command": "mkdir -p output && echo 'Result data' > output/result.txt"},
        artifacts=artifacts
    )
    
    assert result["data"]["capability"] == "shell::bash"
    assert result["status"] in ["completed", "success"]