from typing import List, Optional, Dict, Union
from pathlib import Path
import os
import subprocess
import logging
from urllib.parse import urlparse
import requests

# Configure logger
logging.basicConfig(level=logging.INFO)
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
# Download helpers
# ----------------------------


def git_clone_repo(repo_url: str, target_path: Path) -> None:
    """Clone a git repo. Relies on system git auth (SSH keys or credential helper)."""
    logger.info(f"Cloning git repository {repo_url} to {target_path}")
    target_path.parent.mkdir(parents=True, exist_ok=True)

    # Note: To support username/pass injection into HTTPS git urls,
    # string manipulation on repo_url would be needed here.

    subprocess.run(
        ["git", "clone", repo_url, str(target_path)],
        capture_output=True,
        text=True,
        check=True,
    )
    logger.info(f"Successfully cloned {repo_url}")


def download_s3_file(
    s3_url: str,
    target_path: Path,
    access_key: Optional[str] = None,
    secret_key: Optional[str] = None,
    session_token: Optional[str] = None,
) -> None:
    """
    Download S3 file. Uses provided credentials if available,
    otherwise falls back to environment variables/IAM roles.
    """
    import boto3
    from botocore.client import Config

    logger.info(f"Downloading S3 file {s3_url} to {target_path}")
    target_path.parent.mkdir(parents=True, exist_ok=True)

    # Parse S3 URL to determine bucket, key, and potential custom endpoint
    endpoint = None
    if s3_url.startswith("s3://"):
        parts = s3_url[5:].split("/", 1)
        bucket = parts[0]
        key = parts[1]
    else:
        # Handle custom endpoints like MinIO or R2 if passed as http(s) URL
        parsed = urlparse(s3_url)
        parts = parsed.path.lstrip("/").split("/", 1)
        bucket = parts[0]
        key = parts[1]
        endpoint = f"{parsed.scheme}://{parsed.netloc}"

    # Prepare Client Config
    s3_kwargs = {"endpoint_url": endpoint, "config": Config(signature_version="s3v4")}

    # Inject credentials if provided
    if access_key and secret_key:
        logger.info("Using provided explicit S3 credentials.")
        s3_kwargs["aws_access_key_id"] = access_key
        s3_kwargs["aws_secret_access_key"] = secret_key
        if session_token:
            s3_kwargs["aws_session_token"] = session_token

    s3 = boto3.client("s3", **s3_kwargs)

    s3.download_file(bucket, key, str(target_path))
    logger.info(f"Successfully downloaded {s3_url}")


def download_http_file(
    url: str,
    target_path: Path,
    auth_user: Optional[str] = None,
    auth_password: Optional[str] = None,
    auth_header: Optional[str] = None,
    custom_headers: Optional[dict] = None,
    verify_ssl: bool = True,
) -> None:
    """Download via HTTP GET."""
    logger.info(f"Downloading HTTP {url} to {target_path}")
    target_path.parent.mkdir(parents=True, exist_ok=True)

    headers = {}
    if auth_header:
        headers["Authorization"] = auth_header
    if custom_headers:
        headers.update(custom_headers)

    # Determine Basic Auth tuple
    auth = None
    if auth_user and auth_password:
        auth = (auth_user, auth_password)

    if not verify_ssl:
        import urllib3

        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    response = requests.get(
        url, auth=auth, headers=headers, verify=verify_ssl, stream=True, timeout=60
    )
    response.raise_for_status()

    with open(target_path, "wb") as f:
        for chunk in response.iter_content(chunk_size=8192):
            if chunk:
                f.write(chunk)

    logger.info(f"Successfully downloaded {url}")


# ----------------------------
# Main processing
# ----------------------------


def process_data_download(base_path: Path, d: FileReference) -> None:
    """Dispatch download to correct handler based on populated fields."""
    save_path = base_path / d.path

    # Security check to prevent directory traversal
    if not os.path.abspath(save_path).startswith(os.path.abspath(base_path)):
        raise ValueError(f"Invalid path: {d.path} traverses outside target directory")

    logger.info(f"Processing: {d.path}")

    if save_path.exists():
        logger.info(f"File exists, skipping: {save_path}")
        return

    try:
        if d.git_clone:
            # Git usually relies on SSH keys or git-credential-manager
            # If username/pass needs to be injected into URL, do it here.
            git_clone_repo(d.git_clone, save_path)

        elif d.s3_file:
            # Reuse http_login/http_password for S3 Access/Secret keys
            download_s3_file(
                s3_url=d.s3_file,
                target_path=save_path,
                access_key=d.http_login,
                secret_key=d.http_password,
            )

        elif d.get:
            download_http_file(
                url=d.get,
                target_path=save_path,
                auth_user=d.http_login,
                auth_password=d.http_password,
                auth_header=d.http_auth_header,
                custom_headers=d.custom_header,
            )

        else:
            raise ValueError(
                f"No download source (git, s3, get) specified for {d.path}"
            )

    except Exception as e:
        logger.error(f"Failed to download {d.path}: {str(e)}")
        raise e  # Re-raise to stop execution if strict


# ----------------------------
# Entry point
# ----------------------------


def download_data(data: List[FileReference], temp_dir: str = "/tmp/downloads") -> Path:
    """
    Download all items.
    """
    location = Path(temp_dir)
    location.mkdir(parents=True, exist_ok=True)

    for d in data:
        process_data_download(location, d)

    return location
