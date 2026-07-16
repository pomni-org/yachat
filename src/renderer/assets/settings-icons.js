(() => {
  "use strict";

  if (typeof ICONS !== "object" || !ICONS) {
    return;
  }

  Object.assign(ICONS, {
    "link-2": '<path d="M9 17H7a5 5 0 0 1 0-10h2" /><path d="M15 7h2a5 5 0 1 1 0 10h-2" /><path d="M8 12h8" />',
    "message-square": '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />',
    bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z" />',
    "battery-charging": '<path d="M15 7h1a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2" /><path d="M22 11v2" /><path d="M6 7H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /><path d="m11 6-3 6h4l-2 6 6-8h-4z" />',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />',
    "wand-sparkles": '<path d="m15 4 5 5L8 21l-5-5z" /><path d="m14 5 5 5" /><path d="M6 4V2" /><path d="M6 10V8" /><path d="M3 6H1" /><path d="M11 6H9" /><path d="M19 19v-2" /><path d="M19 23v-2" /><path d="M17 21h-2" /><path d="M23 21h-2" />',
    "globe-2": ICONS.globe,
    "lock-keyhole": '<circle cx="12" cy="16" r="1" /><rect width="18" height="12" x="3" y="10" rx="2" /><path d="M7 10V7a5 5 0 0 1 10 0v3" />',
    "circle-help": ICONS.help,
    info: '<circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />',
    "bell-ring": '<path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8a6 6 0 0 0-12 0c0 4.499-1.411 5.956-2.738 7.326" /><path d="M2 8c0-2.2.7-4.2 2-5.8" /><path d="M22 8c0-2.2-.7-4.2-2-5.8" />',
    "volume-2": '<path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" />',
    play: '<path d="m6 3 14 9-14 9z" />',
    "align-justify": '<path d="M3 6h18" /><path d="M3 12h18" /><path d="M3 18h18" />',
    captions: '<rect width="18" height="14" x="3" y="5" rx="2" /><path d="M7 15h4" /><path d="M15 15h2" /><path d="M7 11h2" /><path d="M13 11h4" />',
    "refresh-cw": '<path d="M21 12a9 9 0 0 0-15.17-6.55L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 15.17 6.55L21 16" /><path d="M16 16h5v5" />',
    "trash-2": ICONS.trash,
    gauge: '<path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /><path d="M5 19h14" />',
    "panel-top": '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" />',
    sparkles: '<path d="m12 3-1.9 4.6a2 2 0 0 1-1.1 1.1L4.4 10.6 9 12.5a2 2 0 0 1 1.1 1.1L12 18.2l1.9-4.6a2 2 0 0 1 1.1-1.1l4.6-1.9L15 8.7a2 2 0 0 1-1.1-1.1z" /><path d="M5 3v4" /><path d="M3 5h4" /><path d="M19 17v4" /><path d="M17 19h4" />'
  });
})();