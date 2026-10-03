# T-Rex browser demo → local CLM

The Chrome offline dinosaur game runs in the **browser** (`resources/dino_game`), and a
**local Node backend** drives its decisions with a local CLM — unlike the headless
`examples/t_rex/run.py` variant, here the dinosaur is actually visible on screen.
The model answers the **`gx10` CLM "System One" endpoint** (`POST /v1/systemone`), and the
browser never sees the API key — the local `server.mjs` handles the HTTP hop for it.

```
browser (dino) ──POST /api/decision──▶  server.mjs ──POST /v1/systemone──▶  gx10 CLM (:8700)
```

The backend asks the model two questions per obstacle:
- **maneuver** (`jump` / `duck` / `keep_running`)
- **jump_profile** (`short` / `full`) — when jumping is the best maneuver

## Starting up

```bash
cd t-rex-clm
npm install

# 1. Open an SSH tunnel to gx10 (keep it open in another terminal):
ssh -L 8700:localhost:8700 user@gx10

# 2. Copy the CLM server config into .env:
cp .env.example .env
#   -- write CLM_API_KEY into .env only if the server asks for a key

# 3. Start:
node --env-file=.env server.mjs
#   -> http://127.0.0.1:3000   (CLM_BASE_URL = http://127.0.0.1:8700)
```

In the browser, click **"AI mode"** to enable the model. The dinosaur can also be driven
**manually** (`Space` / `↑` = jump, `↓` = duck).

## Notes / tips

- **Direct access** (if `gx10:8700` is reachable directly, not via tunnel):
  `CLM_BASE_URL=http://<gx10-ip>:8700 node server.mjs`.
- **Different model:** `CLM_MODEL=clm-...` (list the available names from the CLM's `/v1/models`).
- **Port:** `PORT=8080 node --env-file=.env server.mjs`.
- `server.mjs` reads the key from `.env`; without `process.env.CLM_API_KEY` it sends the
  request without an `Authorization` header.

## What lives here

- `resources/dino_game/*` — the deterministic offline clone of the Chrome dino (BSD-3).
- `script.js`, `ai/*.js` — the browser game loop and the "dino cockpit" controller.
- `server.mjs` — **our** backend, which maps the `/v1/systemone` CLM request onto the
  browser's `POST /api/decision` format.

## Related & credits

- This demo's game assets come from the offline clone in `resources/dino_game` (BSD-3).
- The driving model is [**CLM (Contrastive Language Model)**](https://github.com/Contrastive-LM/CLM)
  (CLM-8B). The `gx10` CLM "System One" endpoint answers the two per-obstacle
  questions (maneuver + jump profile) returned by `Engine.answer`.
