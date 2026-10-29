# Flow card art

`src/components/HowItWorksFlow.tsx` looks for two images here, plus the artwork
for the fee-source card, which is chain-dependent and declared in
`src/lib/chain/network.ts` as `FEE_SOURCE_LOGO`:

| file          | card                                            | declared in                 |
| ------------- | ----------------------------------------------- | --------------------------- |
| `pay.png`     | engine card — title is the admin brand name     | `HowItWorksFlow.tsx` (`ART`) |
| `drand.png`   | drand beacon                                    | `HowItWorksFlow.tsx` (`ART`) |
| `pumpfun.png` | fee source on **Solana** (`Pump.fun trading`)   | `network.ts` `FEE_SOURCE_LOGO` |
| `pons.png`    | fee source on **Robinhood Chain** (`Pons trading`) | `network.ts` `FEE_SOURCE_LOGO` |

The fee-source card follows `NEXT_PUBLIC_CHAIN`: the same component renders
`pumpfun.png` on Solana and `pons.png` on Robinhood Chain, together with the card
title, so the chart never shows a launchpad the draw no longer reads fees from.

Files are served from `/flow/<name>.png`.

- Square art, **64px or larger** (it renders at 24px), PNG/WebP/SVG, transparent
  background preferred because it sits inside the cards' tinted badge.
- `pumpfun.png` (389×389) and `pons.png` (256×256, from `ponsfamily.com`) both
  ship with the app.
- Anything else (JPG, different name) works too: either rename the file or change
  the constant that points at it.
- Until a file exists the badge keeps its lucide icon (the `<img>` 404 is caught
  by `onError`), so nothing breaks while an asset is missing.
