"""YAML frontmatter parser for knowledge entries."""

from typing import Any

import yaml


class FrontmatterError(ValueError):
    """Raised when frontmatter parsing or validation fails.

    A ValueError, not a bare Exception, and that base class is load-bearing.

    Malformed frontmatter is bad INPUT, so every writing route already handles it
    correctly — `except ValueError as e: raise HTTPException(400, detail=str(e))`.
    While this subclassed `Exception` those handlers could not see it: it escaped the
    route and Starlette's ServerErrorMiddleware answered with its default body, the
    plain text `Internal Server Error` under a 500. A client calling
    `response.json()` got a JSONDecodeError instead of being told what was wrong with
    its own submission, and the fault was misattributed to the server.

    Saying "this is a value error" once fixes every call site at the same time —
    entries create and update, journal, and both internal_admin paths — instead of
    adding `except FrontmatterError` in five places and forgetting the sixth.
    """


VALID_TYPES = frozenset({"plan", "decision", "journal", "research", "context", "note", "notebook"})
REQUIRED_FIELDS = ("title", "type")


def parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    """Parse YAML frontmatter from markdown content.

    Returns (metadata_dict, body_text).
    Raises FrontmatterError if frontmatter is missing, malformed, or invalid.
    """
    content = content.strip()
    if not content.startswith("---"):
        raise FrontmatterError("content must begin with frontmatter (---)")

    # Find closing ---
    end_idx = content.find("---", 3)
    if end_idx == -1:
        raise FrontmatterError("frontmatter closing delimiter (---) not found")

    frontmatter_text = content[3:end_idx].strip()
    body = content[end_idx + 3:].strip()

    try:
        meta = yaml.safe_load(frontmatter_text)
    except yaml.YAMLError as e:
        raise FrontmatterError(f"invalid YAML in frontmatter: {e}") from e

    if not isinstance(meta, dict):
        raise FrontmatterError("frontmatter must be a YAML mapping")

    # Validate required fields
    for field in REQUIRED_FIELDS:
        if field not in meta or not meta[field]:
            raise FrontmatterError(f"required frontmatter field missing: {field}")

    # Validate type
    if meta["type"] not in VALID_TYPES:
        raise FrontmatterError(
            f"invalid type '{meta['type']}'; must be one of: {', '.join(sorted(VALID_TYPES))}"
        )

    return meta, body
