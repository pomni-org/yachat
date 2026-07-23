// The iOS composer no longer uses contenteditable or the legacy caret guard.
// Reuse the full native-textarea regression, which loads the emoji module and
// verifies emoji isolation, caret stability, multiline input, mentions and send.
await import("./composer-ios-native-textarea.mjs");
console.log("native textarea emoji isolation suite passed");
