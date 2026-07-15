const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("yachat", {
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
    close: () => ipcRenderer.invoke("window:close")
  },
  links: {
    openExternal: (url) => ipcRenderer.invoke("links:openExternal", url)
  },
  account: {
    get: () => ipcRenderer.invoke("account:get"),
    createChallenge: (payload) => ipcRenderer.invoke("challenge:create", payload),
    verifyChallenge: (payload) => ipcRenderer.invoke("challenge:verify", payload),
    create: (payload) => ipcRenderer.invoke("account:create", payload),
    update: (payload) => ipcRenderer.invoke("account:update", payload),
    deleteProfile: () => ipcRenderer.invoke("account:delete-profile"),
    logout: () => ipcRenderer.invoke("account:logout")
  },
  server: {
    status: () => ipcRenderer.invoke("server:status")
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (payload) => ipcRenderer.invoke("settings:update", payload)
  },
  users: {
    list: () => ipcRenderer.invoke("users:list"),
    search: (query) => ipcRenderer.invoke("users:search", query),
    checkUsername: (username) => ipcRenderer.invoke("users:check-username", username)
  },
  contacts: {
    lookup: (payload) => ipcRenderer.invoke("contacts:lookup", payload)
  },
  messenger: {
    chats: () => ipcRenderer.invoke("chats:list"),
    messages: (chatId) => ipcRenderer.invoke("messages:list", chatId),
    createChat: (payload) => ipcRenderer.invoke("chat:create", payload),
    updateChat: (payload) => ipcRenderer.invoke("chat:update", payload),
    invite: (payload) => ipcRenderer.invoke("chat:invite", payload),
    leave: (payload) => ipcRenderer.invoke("chat:leave", payload),
    deleteChat: (payload) => ipcRenderer.invoke("chat:delete", payload),
    clearHistory: (payload) => ipcRenderer.invoke("chat:clear-history", payload),
    blockUser: (payload) => ipcRenderer.invoke("chat:block-user", payload),
    unblockUser: (payload) => ipcRenderer.invoke("chat:unblock-user", payload),
    send: (payload) => ipcRenderer.invoke("message:send", payload),
    updateMessage: (payload) => ipcRenderer.invoke("message:update", payload),
    deleteMessage: (payload) => ipcRenderer.invoke("message:delete", payload),
    markUnread: (payload) => ipcRenderer.invoke("message:mark-unread", payload),
    markRead: (payload) => ipcRenderer.invoke("chat:mark-read", payload),
    forwardMessage: (payload) => ipcRenderer.invoke("message:forward", payload)
  },
  qr: {
    create: (payload) => ipcRenderer.invoke("qr:create", payload),
    confirm: (payload) => ipcRenderer.invoke("qr:confirm", payload),
    status: (payload) => ipcRenderer.invoke("qr:status", payload)
  }
});
