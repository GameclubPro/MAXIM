# Bot Avatars

Public profile avatars retrieved from the product's MAX profiles on 2026-09-28,
resized from 500x500 to 192x192 WebP for the mini app header:

- `maximov.webp`: https://max.ru/id613070470872_9_bot
- `maximova.webp`: https://max.ru/id613070470872_5_bot
- `rex.webp`: https://max.ru/id613070470872_6_bot
- `publik.webp`: https://max.ru/se14088825_bot

These are local copies of the real profile images, not generated illustrations.
Refresh them when the corresponding MAX avatar changes. `lib/bot-brand.ts` maps
the authenticated `/me.botDialogUrl` to the current and legacy bot handles from
the server's `max-bot-config.util.ts`. Unknown identities retain a neutral name.
