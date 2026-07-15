(() => {
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "./chat-presence.css";
  document.head.append(style);

  const core = document.createElement("script");
  core.src = "./app-core.js";
  core.onload = () => {
    const presence = document.createElement("script");
    presence.src = "./chat-presence.js";
    document.body.append(presence);
  };
  core.onerror = () => {
    document.body.classList.remove("app-booting");
    console.error("Не удалось загрузить основной модуль ЯЧата.");
  };
  document.body.append(core);
})();
