# Mendelbrot

Mandelbrot fractal zoom simulation with recursive deep zoom, GPU rendering, and adjustable speed and colors.

Live: [mandelbrot.fahru.me](https://mandelbrot.fahru.me)

this is ai generated

## Run locally

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:8787 in a browser with WebGL 2 enabled.

## Test

```sh
npm test
```

## Build

```sh
npm run build
```

Source lives in `src/`; the build goes to `dist/`.

## Deploy to Cloudflare

```sh
npx wrangler login
npm run deploy
```

Update `wrangler.jsonc` to use your own domain before deploying.

## Controls

- Scroll or pinch to zoom; drag to pan.
- Space to pause or resume, R to restart, F for fullscreen, H to hide controls.
- Use the bottom controls to change speed and colors.
