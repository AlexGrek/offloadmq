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
        
def process_data_download(data_path: str, d: FileReference):
    save_path = Path(data_path) / Path(d.path) # where to save files, FileReference expects relative path
    
    # check if file already exists
    
    if d.git_clone:
        # cd to data_path and run "git clone . d.git_clone"
    if d.s3_file: 
        # cd to downloads and fetch s3 file (path-style, anything with S3 interface should work
    if d.get:
        # send get request to download a file into specific location
    if d.http_login and d.http_password:
        # sent http/https/anything to that address with basic http auth, allow self-signed certs
    if d.http_auth_header:
        # sent http/https/anything to that address with Authentication header
    if d.custom_header:
        # sent http/https/anything to that address with custom header and value
        # report error - invalid request
        
    # log "save_path"
