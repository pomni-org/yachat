(() => {
  "use strict";

  const dialogPane = document.querySelector(".dialog-pane");
  const dialogHead = document.querySelector(".dialog-head");
  const searchButton = document.querySelector(".dialog-search");
  const messageListElement = document.querySelector("[data-message-list]");
  const TEXT_SELECTOR = ".message-bubble > .message-text, .message-bubble > p";

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

  function language() {
    try {
      return state?.language === "en" ? "en" : "ru";
    } catch {
      return "ru";
    }
  }

  function labels() {
    return language() === "en"
      ? { placeholder: "Search messages", cancel: "Cancel", aria: "Search messages" }
      : { placeholder: "Найти", cancel: "Отменить", aria: "Поиск по сообщениям" };
  }

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

  function refreshLabels() {
    if (!searchBar || !input) return;
    const copy = labels();
    input.placeholder = copy.placeholder;
    input.setAttribute("aria-label", copy.aria);
    searchBar.querySelector("[data-message-search-close]").textContent = copy.cancel;
  }

  function ensureSearchBar() {
    if (searchBar) return searchBar;

    searchBar = document.createElement("form");
    searchBar.className = "dialog-message-search";
    searchBar.hidden = true;
    searchBar.setAttribute("role", "search");
    searchBar.innerHTML = `
      <label class="dialog-message-search-field">
        <span class="dialog-message-search-icon" aria-hidden="true">${svg("search")}</span>
        <input type="search" autocomplete="off" enterkeyhint="search" />
        <output aria-live="polite" hidden></output>
      </label>
      <button class="dialog-message-search-cancel" type="button" data-message-search-close></button>
    `;
    dialogHead.before(searchBar);
    input = searchBar.querySelector("input");
    countLabel = searchBar.querySelector("output");
    refreshLabels();

    searchBar.addEventListener("submit", (event) => {
      event.preventDefault();
      moveMatch(1);
    });
    input.addEventListener("input", scheduleSearch);
    searchBar.querySelector("[data-message-search-close]")?.addEventListener("click", closeSearch);

    if (typeof hydrateIcons === "function") {
      hydrateIcons(searchBar);
    }
    return searchBar;
  }

  function restoreTextElement(element) {
    if (typeof element.__yachatSearchSourceHtml === "string") {
      element.innerHTML = element.__yachatSearchSourceHtml;
      delete element.__yachatSearchSourceHtml;
    }
  }

  function clearHighlights() {
    pauseMessageObserver(() => {
      messageListElement.querySelectorAll(TEXT_SELECTOR).forEach(restoreTextElement);
      messageListElement.querySelectorAll(".is-message-search-active").forEach((bubble) => {
        bubble.classList.remove("is-message-search-active");
      });
      matches = [];
      activeIndex = -1;
      updateCounter();
    });
  }

  function markTextNode(node, query) {
    const source = node.nodeValue || "";
    const lowerSource = source.toLocaleLowerCase();
    const lowerQuery = query.toLocaleLowerCase();
    let cursor = 0;
    let index = lowerSource.indexOf(lowerQuery);

    if (index < 0) return;

    const fragment = document.createDocumentFragment();
    while (index !== -1) {
      if (index > cursor) {
        fragment.append(document.createTextNode(source.slice(cursor, index)));
      }
      const mark = document.createElement("mark");
      mark.className = "message-search-hit";
      mark.textContent = source.slice(index, index + query.length);
      fragment.append(mark);
      matches.push(mark);
      cursor = index + query.length;
      index = lowerSource.indexOf(lowerQuery, cursor);
    }

    if (cursor < source.length) {
      fragment.append(document.createTextNode(source.slice(cursor)));
    }
    node.replaceWith(fragment);
  }

  function highlightElement(element, query) {
    if (typeof element.__yachatSearchSourceHtml !== "string") {
      element.__yachatSearchSourceHtml = element.innerHTML;
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest("mark")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach((node) => markTextNode(node, query));
  }

  function updateCounter() {
    if (!countLabel) return;
    const queryActive = Boolean(input?.value.trim());
    countLabel.hidden = !queryActive || matches.length === 0;
    countLabel.textContent = matches.length && activeIndex >= 0
      ? `${activeIndex + 1}/${matches.length}`
      : matches.length
        ? `0/${matches.length}`
        : "";
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
      messageListElement.querySelectorAll(TEXT_SELECTOR).forEach(restoreTextElement);
      messageListElement.querySelectorAll(".is-message-search-active").forEach((bubble) => {
        bubble.classList.remove("is-message-search-active");
      });
      matches = [];
      activeIndex = -1;

      if (query) {
        const lowerQuery = query.toLocaleLowerCase();
        messageListElement.querySelectorAll(TEXT_SELECTOR).forEach((element) => {
          if ((element.textContent || "").toLocaleLowerCase().includes(lowerQuery)) {
            highlightElement(element, query);
          }
        });
      }
    });

    updateCounter();
    if (matches.length > 0 && !options.backgroundRefresh) {
      focusMatch(0);
    } else if (matches.length === 1) {
      focusMatch(0, { instant: true });
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
    refreshLabels();
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