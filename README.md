# T-Rex browser demo → local CLM

A Chrome-dinó játékot a **browserben** futtatom (`resources/dino_game`), és egy **helyi Node backend**
dönti el a modellsel (`examples/t_rex/run.py` headless verziójával ellentétben — itt **látható** a dinó).
A modell a **`gx10`-es CLM "System One" endpoint** (`POST /v1/systemone`), és a böngésző **soha nem látja a
kulcsot** — az HTTP-kaplatot a helyi `server.mjs` csinálja.

```
böngésző (dinó) ──POST /api/decision──▶  server.mjs ──POST /v1/systemone──▶  gx10 CLM (:8700)
```

A backend két kérdésben kéri a modellt akadályonként:
- **maneuver** (`jump` / `duck` / `keep_running`)
- **jump_profile** (`short` / `full`) — amikor a legjobb ugrás

## Indítás

```bash
cd t-rex-clm
npm install

# 1. gx10 felé SSH tunnel (egy másik terminálban maradjon nyitva):
ssh -L 8700:localhost:8700 user@gx10

# 2. .env a CLM szerver felé:
cp .env.example .env
#   -- szükség esetén .env-be írd a CLM_API_KEY-et, ha a szerver kulcsot kér

# 3. indítás:
node --env-file=.env server.mjs
#   -> http://127.0.0.1:3000   (CLM_BASE_URL = http://127.0.0.1:8700)
```

A böngészőben az **"AI mode"** gombbal kapcsolod be a modellt. A dinó **manuálisan** is vezérthető
(`Space` / `↑` = ugrás, `↓` = megenyülés).

## Váltások / tippek

- **Közvetlen elérés** (ha a gx10:8700 nem tunnelen, hanem közvetlenül elérhető):
  `CLM_BASE_URL=http://<gx10-ip>:8700 node server.mjs`.
- **Más modell:** `CLM_MODEL=clm-...` (a CLM `/v1/models`-ről az elérhető módellneveket látod).
- **Port:** `PORT=8080 node --env-file=.env server.mjs`.
- A `server.mjs` a `.env`-ből olvasja a kulcsot; `process.env.CLM_API_KEY` hiányában Authorization fej nélkül küld.

## Mi miért van itt

- `resources/dino_game/*` — a Chrome offline dinó determinisztikus klónja (BSD-3).
- `script.js`, `ai/*.js` — a browserbeli játékloop és a "dino cockpit" vezérlő.
- `server.mjs` — **a mi** backend, ami a `/v1/systemone` CLM kérést fordítja a browser `POST /api/decision` formátumára.
