"""Sample source content for the Python fixture; scanned, not executed, in E2E."""


def greeting(name: str) -> str:
    """Return a deterministic salutation."""
    return f"hello, {name}"
