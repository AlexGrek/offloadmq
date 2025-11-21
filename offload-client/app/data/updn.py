from typing import List
from ..models import FileReference
import os
from pathlib import Path



def download_data(data: List[FileReference]):
    location = f"/temp/<some rand hash>"
    os.makedirs(location)
    for d in data:
        assert process_data_download(location, d)
    return location
        

import os
import subprocess
import logging
from pathlib import Path
from typing import Optional
import requests
from urllib.parse import urlparse

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class FileReference:
    """Data class for file reference configuration"""
    def __init__(self, path: str, git_clone: Optional[str] = None, 
                 s3_file: Optional[str] = None, get: Optional[str] = None,
                 http_login: Optional[str] = None, http_password: Optional[str] = None,
                 http_auth_header: Optional[str] = None, 
                 custom_header: Optional[dict] = None):
        self.path = path
        self.git_clone = git_clone
        self.s3_file = s3_file
        self.get = get
        self.http_login = http_login
        self.http_password = http_password
        self.http_auth_header = http_auth_header
        self.custom_header = custom_header


def git_clone_repo(repo_url: str, target_path: Path) -> bool:
    """
    Clone a git repository to the target path.
    
    Args:
        repo_url: Git repository URL
        target_path: Path where to clone the repository
        
    Returns:
        True if successful, False otherwise
    """
    try:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        
        result = subprocess.run(
            ['git', 'clone', repo_url, str(target_path)],
            capture_output=True,
            text=True,
            check=True
        )
        logger.info(f"Successfully cloned {repo_url} to {target_path}")
        return True
    except subprocess.CalledProcessError as e:
        logger.error(f"Git clone failed: {e.stderr}")
        return False
    except FileNotFoundError:
        logger.error("Git is not installed or not in PATH")
        return False


def download_s3_file(s3_url: str, target_path: Path) -> bool:
    """
    Download a file from S3-compatible storage using boto3.
    
    Args:
        s3_url: S3 URL (s3://bucket/key or https://endpoint/bucket/key)
        target_path: Path where to save the file
        
    Returns:
        True if successful, False otherwise
    """
    try:
        import boto3
        from botocore.client import Config
        from botocore.exceptions import ClientError
        
        target_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Parse S3 URL
        if s3_url.startswith('s3://'):
            # Standard S3 URL: s3://bucket/key
            parts = s3_url[5:].split('/', 1)
            bucket = parts[0]
            key = parts[1] if len(parts) > 1 else ''
            endpoint_url = None
        else:
            # Path-style URL: https://endpoint/bucket/key
            parsed = urlparse(s3_url)
            path_parts = parsed.path.lstrip('/').split('/', 1)
            bucket = path_parts[0]
            key = path_parts[1] if len(path_parts) > 1 else ''
            endpoint_url = f"{parsed.scheme}://{parsed.netloc}"
        
        # Create S3 client
        s3_client = boto3.client(
            's3',
            endpoint_url=endpoint_url,
            config=Config(signature_version='s3v4')
        )
        
        # Download file
        s3_client.download_file(bucket, key, str(target_path))
        logger.info(f"Successfully downloaded {s3_url} to {target_path}")
        return True
        
    except ImportError:
        logger.error("boto3 is not installed. Install it with: pip install boto3")
        return False
    except ClientError as e:
        logger.error(f"S3 download failed: {e}")
        return False
    except Exception as e:
        logger.error(f"Unexpected error during S3 download: {e}")
        return False


def download_http_file(url: str, target_path: Path, 
                       auth_user: Optional[str] = None,
                       auth_password: Optional[str] = None,
                       auth_header: Optional[str] = None,
                       custom_headers: Optional[dict] = None,
                       verify_ssl: bool = False) -> bool:
    """
    Download a file via HTTP/HTTPS with various authentication options.
    
    Args:
        url: URL to download from
        target_path: Path where to save the file
        auth_user: Username for basic auth
        auth_password: Password for basic auth
        auth_header: Authentication header value (e.g., "Bearer token123")
        custom_headers: Dictionary of custom headers
        verify_ssl: Whether to verify SSL certificates (False allows self-signed)
        
    Returns:
        True if successful, False otherwise
    """
    try:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Prepare headers
        headers = {}
        if auth_header:
            headers['Authorization'] = auth_header
        if custom_headers:
            headers.update(custom_headers)
        
        # Prepare authentication
        auth = None
        if auth_user and auth_password:
            auth = (auth_user, auth_password)
        
        # Disable SSL warnings if verify_ssl is False
        if not verify_ssl:
            import urllib3
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        
        # Download file with streaming to handle large files
        response = requests.get(
            url,
            auth=auth,
            headers=headers,
            verify=verify_ssl,
            stream=True,
            timeout=30
        )
        response.raise_for_status()
        
        # Write to file in chunks
        with open(target_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
        
        logger.info(f"Successfully downloaded {url} to {target_path}")
        return True
        
    except requests.exceptions.RequestException as e:
        logger.error(f"HTTP download failed: {e}")
        return False
    except Exception as e:
        logger.error(f"Unexpected error during HTTP download: {e}")
        return False


def process_data_download(data_path: Path, d: FileReference) -> bool:
    """
    Process data download based on FileReference configuration.
    
    Args:
        data_path: Base path where to save files
        d: FileReference object with download configuration
        
    Returns:
        True if successful, False otherwise
    """
    save_path = Path(data_path) / Path(d.path)
    
    logger.info(f"Processing download to: {save_path}")
    
    # Check if file already exists
    if save_path.exists():
        logger.info(f"File already exists at {save_path}, skipping download")
        return True
    
    # Process based on download method (order of precedence)
    
    if d.git_clone:
        logger.info(f"Cloning git repository: {d.git_clone}")
        return git_clone_repo(d.git_clone, save_path)
    
    elif d.s3_file:
        logger.info(f"Downloading from S3: {d.s3_file}")
        return download_s3_file(d.s3_file, save_path)
    
    elif d.get:
        logger.info(f"Downloading via HTTP GET: {d.get}")
        
        # Determine which authentication/header method to use
        if d.http_login and d.http_password:
            logger.info("Using HTTP Basic Authentication")
            return download_http_file(
                d.get, 
                save_path,
                auth_user=d.http_login,
                auth_password=d.http_password,
                verify_ssl=False  # Allow self-signed certs
            )
        
        elif d.http_auth_header:
            logger.info("Using Authentication Header")
            return download_http_file(
                d.get,
                save_path,
                auth_header=d.http_auth_header,
                verify_ssl=False
            )
        
        elif d.custom_header:
            logger.info("Using Custom Headers")
            return download_http_file(
                d.get,
                save_path,
                custom_headers=d.custom_header,
                verify_ssl=False
            )
        
        else:
            # Simple GET request without authentication
            return download_http_file(d.get, save_path, verify_ssl=False)
    
    else:
        logger.error("Invalid request: No valid download method specified")
        return False
