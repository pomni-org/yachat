"""Unicode Digital ID bridge for the developer verification API.

The legacy monolithic API still exposes a Latin-only normalizer for old routes.
The dedicated Digital ID boundary already implements the current contract:
Cyrillic IDs for new Russian profiles and compatibility with existing Latin IDs.
Patch only the symbols consumed by digital_id_secure before importing its app.
"""

from api import index as index_api
from api.digital_id_blocked import format_digital_id, normalize_digital_id

index_api.normalize_digital_id = normalize_digital_id
index_api.format_digital_id = format_digital_id

from api.digital_id_secure import app  # noqa: E402,F401
