// Tolerant JSON parse shared across the IPC layer: returns `fallback` on empty
// input or malformed JSON instead of throwing. Extracted from app-ipc.js.

function safeParseJson(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

module.exports = { safeParseJson };
