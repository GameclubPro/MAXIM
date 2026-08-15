# MAX API Notes (2026)

- Production mode should use webhook delivery over HTTPS.
- Keep total traffic to `platform-api2.max.ru` within the documented 30 rps ceiling.
- MAX documents a target-scoped limit of 2 operations per second for each [send](https://dev.max.ru/docs-api/methods/POST/messages), [edit](https://dev.max.ru/docs-api/methods/PUT/messages), [delete](https://dev.max.ru/docs-api/methods/DELETE/messages), and [callback answer](https://dev.max.ru/docs-api/methods/POST/answers) operation; queue or delay excess work.
- A [webhook](https://dev.max.ru/docs-api/methods/POST/subscriptions) must return HTTP 200 within 30 seconds; keep the application deadline below that transport ceiling.
- Validate [upload](https://dev.max.ru/docs-api/methods/POST/uploads) payloads before creating a session: image 50 MB, video 250 MB, audio 256 MB and 60 minutes, file 4 GB; images must also remain within 7680 x 7680 px.
- MAX currently documents JPG/JPEG, PNG, GIF, TIFF, BMP, and HEIC images plus MP4, MOV, MKV, and WEBM videos. Detect the actual container from bytes and canonicalize the MIME type and file extension before dispatch.
- Media validation is structural and bounded, not a substitute for full playback decoding: HEIC checks container/item metadata, dimensions, encoded item extents, and HEVC NAL framing; video checks the container, primary track, packet boundaries, and first key-packet framing. BMP accepts bounded uncompressed, paletted, and bitfield layouts; RLE and embedded JPEG/PNG payloads remain fail-closed.
- Since June 2026, [GET /chats](https://dev.max.ru/docs-api/methods/GET/chats) is unsupported. Discover managed chats from subscriptions and keep the catalog locally; Long Polling is not a replacement for this list.
- Use secret path and webhook header secret for endpoint hardening.
- Mini-app auth requires HMAC validation of init data.
