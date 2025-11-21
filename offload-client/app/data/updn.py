from typing import List, Optional
from pathlib import Path
import os
import subprocess
import logging
from urllib.parse import urlparse
import requests


logger = logging.getLogger(__name__)


class FileReference:
    def __init__(
        self,
        path: str,
        git_clone: Optional[str] = None,
        s3_file: Optional[str] = None,
        get: Optional[str] = None,
        http_login: Optional[str] = None,
        http_password: Optional[str] = None,
        http_auth_header: Optional[str] = None,
        custom_header: Optional[dict] = None,
    ):
        self.path = path
        self.git_clone = git_clone
        self.s3_file = s3_file
        self.get = get
        self.http_login = http_login
        self.http_password = http_password
        self.http_auth_header = http_auth_header
        self.custom_header = custom_header


# ----------------------------
# Download helpers (raise on error)
# ----------------------------

def git_clone_repo(repo_url: str, target_path: Path) -> None:
    """Clone a git repo or raise original error."""
    logger.info(f"Cloning git repository {repo_url} to {target_path}")
    target_path.parent.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        ['git', 'clone', repo_url, str(target_path)],
        capture_output=True,
        text=True,
        check=True  # <-- raises CalledProcessError
    )

    logger.info(f"Successfully cloned {repo_url}")


def download_s3_file(s3_url: str, target_path: Path) -> None:
    """Download S3 file or raise original errors."""
    import boto3
    from botocore.client import Config

    logger.info(f"Downloading S3 file {s3_url} to {target_path}")
    target_path.parent.mkdir(parents=True, exist_ok=True)

    # Parse S3 URL
    if s3_url.startswith("s3://"):
        parts = s3_url[5:].split("/", 1)
        bucket = parts[0]
        key = parts[1]
        endpoint = None
    else:
        parsed = urlparse(s3_url)
        parts = parsed.path.lstrip("/").split("/", 1)
        bucket = parts[0]
        key = parts[1]
        endpoint = f"{parsed.scheme}://{parsed.netloc}"

    s3 = boto3.client("s3", endpoint_url=endpoint, config=Config(signature_version="s3v4"))

    # Raises ClientError or others naturally
    s3.download_file(bucket, key, str(target_path))

    logger.info(f"Successfully downloaded {s3_url}")


def download_http_file(
    url: str,
    target_path: Path,
    auth_user: Optional[str] = None,
    auth_password: Optional[str] = None,
    auth_header: Optional[str] = None,
    custom_headers: Optional[dict] = None,
    verify_ssl: bool = False,
) -> None:
    """Download via HTTP GET. Raises original requests exceptions."""
    logger.info(f"Downloading HTTP {url} to {target_path}")
    target_path.parent.mkdir(parents=True, exist_ok=True)

    headers = {}
    if auth_header:
        headers["Authorization"] = auth_header
    if custom_headers:
        logger.warning(f"Custom headers detected: {custom_headers}")
        headers.update(custom_headers)

    auth = (auth_user, auth_password) if auth_user and auth_password else None

    if not verify_ssl:
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    response = requests.get(
        url, auth=auth, headers=headers, verify=verify_ssl, stream=True, timeout=30
    )
    response.raise_for_status()  # <-- raises on HTTP 4xx/5xx

    with open(target_path, "wb") as f:
        for chunk in response.iter_content(chunk_size=8192):
            if chunk:
                f.write(chunk)

    logger.info(f"Successfully downloaded {url}")


# ----------------------------
# Main processing
# ----------------------------

def process_data_download(data_path: Path, d: FileReference) -> None:
    """Perform required download or clone. Raises exceptions."""
    save_path = data_path / d.path
    logger.info(f"Processing download → {save_path}")

    if save_path.exists():
        logger.info(f"File exists, skipping: {save_path}")
        return

    if d.git_clone:
        git_clone_repo(d.git_clone, save_path)
        return

    if d.s3_file:
        download_s3_file(d.s3_file, save_path)
        return

    if d.get:
        if d.http_login and d.http_password:
            download_http_file(
                d.get, save_path,
                auth_user=d.http_login,
                auth_password=d.http_password
            )
        elif d.http_auth_header:
            download_http_file(
                d.get, save_path,
                auth_header=d.http_auth_header
            )
        elif d.custom_header:
            download_http_file(
                d.get, save_path,
                custom_headers=d.custom_header
            )
        else:
            download_http_file(d.get, save_path)
        return

    raise ValueError("Invalid FileReference: no download method specified")


# ----------------------------
# Entry point
# ----------------------------

def download_data(data: List[FileReference]) -> Path:
    """Download all items. Raises immediately on first failure."""
    location = Path(f"/temp/<some rand hash>")
    location.mkdir(parents=True, exist_ok=True)

    for d in data:
        process_data_download(location, d)  # <-- let exceptions bubble up

    return location
