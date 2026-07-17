(() => {
  "use strict";

  const dialogPane = document.querySelector(".dialog-pane");
  const dialogHead = document.querySelector(".dialog-head");
  const searchButton = document.querySelector(".dialog-search");
  const messageListElement = document.querySelector("[data-message-list]");

  if (!dialogPane || !dialogHead || !searchButton || !messageListElement) {
    return;
  }

  let searchBar = null;
  let input = null;
  let countLabel = null;
  let matches = [];
  let activeIndex = -1;
  let refreshFrame = 0;
  let messageObserver = null;

  function svg(name) {
    return typeof iconSvg === "function" ? iconSvg(name) : "";
  }

  function observeMessages() {
    if (!messageObserver) {
      messageObserver = new MutationObserver(() => {
        if (!searchBar || searchBar.hidden || !input?.value.trim()) return;
        scheduleSearch({ backgroundRefresh: true });
      });
    }
    messageObserver.observe(messageListElement, { childList: true, subtree: true });
  }

  function pauseMessageObserver(callback) {
    messageObserver?.disconnect();
    try {
      callback();
    } finally {
      observeMessages();
    }
  }

  function ensureSearchBar() {
    if (searchBar) return searchBar;

    searchBar = document.createElement("form");
    searchBar.className = "dialog-message-search";
    searchBar.hidden = true;
    searchBar.setAttribute("role", "search");
    searchBar.innerHTML = `
      <span class="dialog-message-search-icon" aria-hidden="true">${svg("search")}</span>
      <input type="search" autocomplete="off" enterkeyhint="search" placeholder="Найти сообщение" aria-label="Поиск сообщений" />
      <output aria-live="polite">0/0</output>
      <button type="button" data-message-search-prev aria-label="Предыдущее совпадение">${svg("chevron-left")}</button>
      <button type="button" data-message-search-next aria-label="Следующее совпадение">${svg("chevron-right")}</button>
      <button type="button" data-message-search-close aria-label="Закрыть поиск">${svg("x")}</button>
    `;
    dialogHead.insertAdjacentElement("afterend", searchBar);
    input = searchBar.querySelector("input");
    countLabel = searchBar.querySelector("output");

    searchBar.addEventListener("submit", (event) => {
      event.preventDefault();
      moveMatch(1);
    });
    searchBar.addEventListener("input", scheduleSearch);
    searchBar.querySelector("[data-message-search-prev]")?.addEventListener("click", () => moveMatch(-1));
    searchBar.querySelector("[data-message-search-next]")?.addEventListener("click", () => moveMatch(1));
    searchBar.querySelector("[data-message-search-close]")?.addEventListener("click", closeSearch);

    if (typeof hydrateIcons === "function") {
      hydrateIcons(searchBar);
    }
    return searchBar;
  }

  function restoreParagraph(paragraph) {
    if (paragraph.dataset.messageSearchSource !== undefined) {
      paragraph.textContent = paragraph.dataset.messageSearchSource;
      delete paragraph.dataset.messageSearchSource;
    }
  }

  function clearHighlights() {
    pauseMessageObserver(() => {
      messageListElement.querySelectorAll(".message-bubble > p").forEach(restoreParagraph);
      messageListElement.querySelectorAll(".is-message-search-active").forEach((bubble) => {
        bubble.classList.remove("is-message-search-active");
      });
      matches = [];
      activeIndex = -1;
      updateCounter();
    });
  }

  function highlightParagraph(paragraph, query) {
    const source = paragraph.dataset.messageSearchSource ?? paragraph.textContent ?? "";
    paragraph.dataset.messageSearchSource = source;
    paragraph.textContent = "";

    const lowerSource = source.toLocaleLowerCase();
    const lowerQuery = query.toLocaleLowerCase();
    let cursor = 0;
    let index = lowerSource.indexOf(lowerQuery, cursor);

    while (index !== -1) {
      if (index > cursor) {
        paragraph.append(document.createTextNode(source.slice(cursor, index)));
      }
      const mark = document.createElement("mark");
      mark.className = "message-search-hit";
      mark.textContent = source.slice(index, index + query.length);
      paragraph.append(mark);
      matches.push(mark);
      cursor = index + query.length;
      index = lowerSource.indexOf(lowerQuery, cursor);
    }

    if (cursor < source.length) {
      paragraph.append(document.createTextNode(source.slice(cursor)));
    }
  }

  function updateCounter() {
    if (!countLabel) return;
    countLabel.textContent = matches.length && activeIndex >= 0
      ? `${activeIndex + 1}/${matches.length}`
      : `0/${matches.length}`;

    const disabled = matches.length === 0;
    searchBar?.querySelector("[data-message-search-prev]")?.toggleAttribute("disabled", disabled);
    searchBar?.querySelector("[data-message-search-next]")?.toggleAttribute("disabled", disabled);
  }

  function focusMatch(index, options = {}) {
    if (!matches.length) {
      activeIndex = -1;
      updateCounter();
      return;
    }

    activeIndex = ((index % matches.length) + matches.length) % matches.length;
    const activeBubble = matches[activeIndex].closest(".message-bubble");
    matches.forEach((mark, markIndex) => mark.classList.toggle("is-active", markIndex === activeIndex));
    messageListElement.querySelectorAll(".is-message-search-active").forEach((bubble) => {
      bubble.classList.toggle("is-message-search-active", bubble === activeBubble);
    });

    activeBubble?.scrollIntoView({
      block: "center",
      behavior: options.instant ? "auto" : "smooth"
    });
    updateCounter();
  }

  function applySearch(options = {}) {
    if (!input || searchBar?.hidden) return;
    const query = input.value.trim();

    pauseMessageObserver(() => {
      messageListElement.querySelectorAll(".message-bubble > p").forEach(restoreParagraph);
      messageListElement.querySelectorAll(".is-message-search-active").forEach((bubble) => {
        bubble.classList.remove("is-message-search-active");
      });
      matches = [];
      activeIndex = -1;

      if (query) {
        const lowerQuery = query.toLocaleLowerCase();
        messageListElement.querySelectorAll(".message-bubble > p").forEach((paragraph) => {
          const source = paragraph.textContent || "";
          if (source.toLocaleLowerCase().includes(lowerQuery)) {
            highlightParagraph(paragraph, query);
          }
        });
      }
    });

    updateCounter();
    if (matches.length === 1) {
      focusMatch(0, { instant: Boolean(options.backgroundRefresh) });
    } else if (matches.length > 1 && !options.backgroundRefresh) {
      focusMatch(0);
    }
  }

  function scheduleSearch(options = {}) {
    cancelAnimationFrame(refreshFrame);
    refreshFrame = requestAnimationFrame(() => applySearch(options));
  }

  function moveMatch(direction) {
    if (!matches.length) return;
    focusMatch(activeIndex < 0 ? 0 : activeIndex + direction);
  }

  function openSearch() {
    ensureSearchBar();
    searchBar.hidden = false;
    dialogPane.classList.add("message-search-open");
    searchButton.setAttribute("aria-pressed", "true");
    requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      input.select();
      scheduleSearch();
    });
  }

  function closeSearch() {
    if (!searchBar || searchBar.hidden) return;
    clearHighlights();
    input.value = "";
    searchBar.hidden = true;
    dialogPane.classList.remove("message-search-open");
    searchButton.setAttribute("aria-pressed", "false");
  }

  searchButton.setAttribute("aria-pressed", "false");
  searchButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (searchBar && !searchBar.hidden) closeSearch();
    else openSearch();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchBar && !searchBar.hidden) {
      event.preventDefault();
      closeSearch();
      searchButton.focus({ preventScroll: true });
    }
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest(".chat-list [data-chat-id], [data-search-user-id], [data-action='dialog-back']")) {
      closeSearch();
    }
  }, true);

  observeMessages();
})();