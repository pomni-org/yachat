"""YaChat presence runtime with a short typing expiry.

The main presence implementation remains in api.presence. This entry point only
shortens the server-side fallback window so a missed stop request cannot leave a
stale typing indicator for several seconds.
"""

from api import presence as presence_api

presence_api.TYPING_TTL_SECONDS = 3
app = presence_api.app
