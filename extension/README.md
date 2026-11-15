# extension — Chrome / Edge MV3 browser extension

This folder **is** the unpacked extension. There is no build step.

## Install

- Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → this folder
- Edge: `edge://extensions` → Developer mode → **Load unpacked** → this folder

The same folder works in both. After an update, press the reload arrow on the
extension card and refresh any open AI tab.

## Layout

```
manifest.json         MV3 manifest (8 providers, localhost permissions)
background.js         service worker: controller URL, browser id, all HTTP
popup.html/js         status + controller address
core/config.js        system prompt, feedback text, tool catalogue formatting
core/parser.js        command parser (JSON envelope + ###GDSCRIPT### blocks)
core/net.js           content-script -> background transport
core/main.js          provider-agnostic agent loop + in-page bar
providers/*.js        one adapter per AI website (DOM only)
overlay.css           in-page bar / toast / chip styling
```

## Provider contract

`core/main.js` only talks to `ZSProvider` exported by one `providers/*.js` file.
An adapter may implement:

```js
{
  id, displayName, timings, supportsVision,
  init({diag}), conversationKey(),
  // turns
  allItems(), isUserItem(n), isAssistantItem(n), itemText(n), classifyText(n, sel),
  assistantCount(), userCount(), lastAssistant(), lastAssistantId?(), readAssistant(),
  snapshot(), streamLen?(n),
  // composer
  getEditor(), editorText(), chatIsEmpty(), composerFrame?(),
  barMount?(), barAnchor?(), setInputLock(on), typeAndSend(text, images),
  stopGeneration(), isGenerating(), isHardGenerating?(),
  ensureComposerReady?(reason), enforceComposer?(), modeWarning?(),
  captchaPresent?(), overlayBlocking?(),
  turnHalted?(), findContinueBtn?(), clickContinueBtn?(),
  scanError?(), isTooLongMsg?(), isBusyMsg?(),
  attachImages?(images), clearAttachments?(),
  installSendHooks?(handlers), findToolBlockSpot(item, chip)
}
```

`barMount()` (in-flow), `barAnchor()` (element to sit above) and
`composerFrame()` are optional; the core falls back to a fixed corner bar.
`findToolBlockSpot(item, chip)` hides the raw command block and returns
`{parent, ref}` where the status chip should be inserted.

The core only uses text: `readAssistant().reply`, `isGenerating()`,
`assistantCount()/lastAssistantId()` and `typeAndSend(text)`. Screenshots are
not sent to the AI in v0.1.0 even on vision-capable pages.

When a site redesign breaks the bar or a reply is not detected, only the
provider file should need changing. Use the browser console (`[nonzeroscript]`
and `[nzs-bg]` prefixes) and the console's live log to debug.

## Permissions

- `storage` — browser id + controller address
- host permissions for the eight AI sites and `http://127.0.0.1/*` / `localhost`

All controller requests go through `background.js`, so an https page never
needs to mix content with the local relay itself, and a dead controller always
resolves to `{ok:false}` instead of a hung promise.

## Default controller

`http://127.0.0.1:8790`. Change it in the popup; the content script picks the
new value up from `chrome.storage`.
