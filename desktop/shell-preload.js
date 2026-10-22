// Shell preload — minimal, just enables context isolation for the shell page.
// The SE Assist webview uses se-assist-preload.js via the webview preload attribute.
const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("shell", { version: "1.0.0" });
