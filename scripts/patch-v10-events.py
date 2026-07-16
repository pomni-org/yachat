from pathlib import Path

p=Path("src/renderer/app.js")
s=p.read_text(encoding="utf-8")
old='''attachmentInput?.addEventListener("change", () => {
  addAttachments(attachmentInput.files);
});'''
new='''documentButton?.addEventListener("click", () => {
  if (!canSendToChat(getActiveChat())) return;
  documentInput?.click();
});

attachmentInput?.addEventListener("change", () => {
  addAttachments(attachmentInput.files, "media");
});

documentInput?.addEventListener("change", () => {
  addAttachments(documentInput.files, "document");
});'''
if old not in s:
    raise SystemExit("attachment event anchor missing")
p.write_text(s.replace(old,new,1),encoding="utf-8")
