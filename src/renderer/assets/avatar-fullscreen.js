(() => {
  "use strict";

  if (window.__yachatMediaViewerLoaderInstalled) return;
  window.__yachatMediaViewerLoaderInstalled = true;

  const version = "89";
  if (!document.querySelector('[data-yachat-media-viewer-style]')) {
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = `/assets/media-attachments-viewer.css?v=${version}`;
    style.dataset.yachatMediaViewerStyle = "";
    document.head.append(style);
  }

  if (!document.querySelector('[data-yachat-media-viewer-script]')) {
    const script = document.createElement("script");
    script.src = `/assets/media-attachments-viewer.js?v=${version}`;
    script.dataset.yachatMediaViewerScript = "";
    document.head.append(script);
  }
})();
