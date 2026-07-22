(() => {
  "use strict";

  if (window.__yachatComposerReliabilityInstalled) return;
  window.__yachatComposerReliabilityInstalled = true;

  const IOS_USER_AGENT = /iPad|iPhone|iPod/i;
  const isIos = IOS_USER_AGENT.test(navigator.userAgent || "")
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    || (/Macintosh/i.test(navigator.userAgent || "") && navigator.maxTouchPoints > 1);

  const allowedTags = new Set(["STRONG", "EM", "U", "S", "CODE", "A", "BR"]);
  const aliases = new Map([
    ["B", "STRONG"],
    ["I", "EM"],
    ["DEL", "S"]
  ]);

  function safeUrl(value) {
    const source = String(value || "").trim();
    if (!source) return "";
    const prepared = /^[a-z][a-z0-9+.-]*:/i.test(source) ? source : `https://${source}`;
    try {
      const url = new URL(prepared, window.location.origin);
      return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function sanitizeRichHtml(value) {
    const template = document.createElement("template");
    template.innerHTML = String(value || "").slice(0, 24000);
    const output = document.createElement("div");

    function appendNode(node, parent) {
      if (node.nodeType === Node.TEXT_NODE) {
        parent.append(document.createTextNode(node.nodeValue || ""));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const originalTag = node.tagName.toUpperCase();
      const tag = aliases.get(originalTag) || originalTag;

      if (tag === "BR") {
        parent.append(document.createElement("br"));
        return;
      }

      if (originalTag === "DIV" || originalTag === "P") {
        if (parent.childNodes.length && parent.lastChild?.nodeName !== "BR") {
          parent.append(document.createElement("br"));
        }
        [...node.childNodes].forEach((child) => appendNode(child, parent));
        if (parent.lastChild?.nodeName !== "BR") parent.append(document.createElement("br"));
        return;
      }

      if (!allowedTags.has(tag)) {
        [...node.childNodes].forEach((child) => appendNode(child, parent));
        return;
      }

      const element = document.createElement(tag.toLowerCase());
      if (tag === "A") {
        const href = safeUrl(node.getAttribute("href"));
        if (!href) {
          [...node.childNodes].forEach((child) => appendNode(child, parent));
          return;
        }
        element.href = href;
        element.target = "_blank";
        element.rel = "noopener noreferrer";
      }
      [...node.childNodes].forEach((child) => appendNode(child, element));
      parent.append(element);
    }

    [...template.content.childNodes].forEach((node) => appendNode(node, output));
    while (output.lastChild?.nodeName === "BR") output.lastChild.remove();
    return output.innerHTML;
  }

  function installLayoutRepair() {
    if (!isIos || document.querySelector("style[data-yachat-composer-reliability]")) return;

    const style = document.createElement("style");
    style.dataset.yachatComposerReliability = "";
    style.textContent = `
      .composer.is-native-ios-composer {
        justify-self: center !important;
        margin-inline: auto !important;
      }

      .composer.is-native-ios-composer .ios-rich-message-field {
        grid-column: 3 !important;
        justify-self: stretch !important;
        align-self: end !important;
        width: 100% !important;
        min-width: 0 !important;
      }

      .composer.is-native-ios-composer .ios-rich-message-field > .ios-rich-message-preview,
      .composer.is-native-ios-composer .ios-rich-message-field > .ios-native-message-input {
        grid-column: 1 / -1 !important;
        grid-row: 1 !important;
        width: 100% !important;
        min-width: 0 !important;
      }

      .composer.is-native-ios-composer .ios-rich-message-preview.message-editor {
        align-self: stretch !important;
        padding-inline: 4px !important;
      }

      .composer.is-native-ios-composer .ios-native-message-input {
        padding-inline: 4px !important;
      }

      @media (max-width: 640px) {
        .composer.is-native-ios-composer {
          width: calc(100% - 16px) !important;
          max-width: calc(100% - 16px) !important;
          margin-left: 8px !important;
          margin-right: 8px !important;
        }
      }
    `;
    document.head.append(style);
  }

  function transientMessage(clientMessageId) {
    if (!clientMessageId || typeof getMessageById !== "function") return null;
    try {
      return getMessageById(clientMessageId);
    } catch {
      return null;
    }
  }

  function installFormattedPayloadRepair() {
    if (typeof yachatApi === "undefined" || !yachatApi?.messenger?.send) return false;
    if (yachatApi.messenger.send.__yachatKeepsFormattedHtml) return true;

    const currentSend = yachatApi.messenger.send.bind(yachatApi.messenger);
    const sendWithFormattedHtml = function sendWithFormattedHtml(payload = {}) {
      const transient = transientMessage(payload.clientMessageId);
      const formattedHtml = sanitizeRichHtml(payload.formattedHtml || transient?.formattedHtml || "");
      return currentSend(formattedHtml ? { ...payload, formattedHtml } : { ...payload });
    };

    Object.defineProperty(sendWithFormattedHtml, "__yachatKeepsFormattedHtml", {
      configurable: false,
      enumerable: false,
      value: true
    });
    yachatApi.messenger.send = sendWithFormattedHtml;
    return true;
  }

  function dispatchTransportInput(transport) {
    const event = typeof InputEvent === "function"
      ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: null })
      : new Event("input", { bubbles: true });
    transport.dispatchEvent(event);
  }

  function installDomRepair() {
    const form = document.querySelector('[data-form="message"]');
    const send = form?.querySelector(".send-button");
    const transport = form?.querySelector("[data-message-input]");
    const textarea = form?.querySelector("[data-ios-message-input]");
    if (!form || !send || !transport) return false;

    form.classList.add("is-composer-reliable");

    if (textarea && !textarea.dataset.yachatTransportSync) {
      textarea.dataset.yachatTransportSync = "true";
      const syncTransport = () => {
        if (transport.value === textarea.value) return;
        transport.value = textarea.value;
        dispatchTransportInput(transport);
      };
      textarea.addEventListener("input", () => requestAnimationFrame(syncTransport));
      textarea.addEventListener("change", syncTransport);
      textarea.addEventListener("keydown", (event) => {
        if (event.key === "Enter") event.stopPropagation();
      }, true);
    }

    if (!send.dataset.yachatReliableSubmit) {
      send.dataset.yachatReliableSubmit = "true";
      send.addEventListener("click", (event) => {
        if (send.disabled || form.classList.contains("is-readonly")) return;

        event.preventDefault();
        event.stopImmediatePropagation();

        if (textarea && transport.value !== textarea.value) {
          transport.value = textarea.value;
          dispatchTransportInput(transport);
        }

        if (typeof form.requestSubmit === "function") {
          form.requestSubmit(send);
          return;
        }

        const submitEvent = typeof SubmitEvent === "function"
          ? new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: send })
          : new Event("submit", { bubbles: true, cancelable: true });
        form.dispatchEvent(submitEvent);
      }, true);
    }

    return true;
  }

  function installAll() {
    installLayoutRepair();
    installFormattedPayloadRepair();
    installDomRepair();
  }

  installAll();

  const observer = new MutationObserver(() => installAll());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
