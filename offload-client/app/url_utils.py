from urllib.parse import quote

def qpart(value: str) -> str:
    """Quote a URL path segment (slashes are unsafe)."""
    return quote(value or "", safe="")


def build_url(base: str, *segments: str) -> str:
    base = base.rstrip("/")
    safe_segments = [qpart(s) for s in segments]
    return base + "/" + "/".join(safe_segments) if safe_segments else base
