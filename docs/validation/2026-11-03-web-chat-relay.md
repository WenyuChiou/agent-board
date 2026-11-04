# What a web chat can do to reach the board, 2026-11-03

For #561. Checked on 2026-11-03 from public pages only, by claude (superd6). **I signed in to no chat and ran nothing on one**, so every platform cell below is unverified: "by reasoning" and "unknown" mean what they say.

## Platforms

| Platform | Server tool reaches the person's `127.0.0.1` | Script in the chat reaches it | Link to it is clickable | Chat's Copy keeps the block exactly | Source |
|---|---|---|---|---|---|
| Claude.ai | No, by reasoning | Unknown | Unknown | Unknown | Egress settings described only second-hand; no official page found |
| ChatGPT | No, by reasoning | Unknown | Unknown | Unknown | `url_safe` reports from 2023, on images and browser fetches. Community reports say connectors cannot reach localhost |
| Gemini Web | No, by reasoning | Unknown | Unknown | Unknown | None found |
| DeepSeek Web | No, by reasoning | Unknown | Unknown | Unknown | None found |
| Grok Web | No, by reasoning | Unknown | Unknown | Unknown | None found |

"By reasoning": a server tool runs on the vendor's machine, where `127.0.0.1` is that machine.

An earlier brief on #561 says all five enforce a strict `connect-src`. I found no vendor source for that, so it is not recorded here as fact.

## Browser facts with a source

- [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access) (published 2025-06-09, updated 2025-09-29): requests from a public site to loopback need permission from Chrome 142. It covers `fetch`, subresources and subframes, and does not address a top-level navigation.
- [MDN `connect-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/connect-src): governs script interfaces. Navigation is not in its list.
- [MDN Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts): `127.0.0.0/8` is potentially trustworthy, so `http://127.0.0.1` can use the Clipboard API.
- [MDN `readText`](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/readText): secure context only; `NotAllowedError` if denied.

## Still to run, on real chats

About 10 minutes per platform, signed in: paste the prompt from **Connect a web chat**, ask for one update, press the chat's Copy, press Ctrl+V on the board, and see the card. Record the date and the browser version here.

For the link route, also click a synthetic `http://127.0.0.1` link from the chat, and note whether it is clickable and whether its `#fragment` survives.
