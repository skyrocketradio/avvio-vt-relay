# Avvio VT Relay

A small, **standalone** service that couriers remote voice tracks between an Avvio
One studio (the master Mac) and remote trackers (web app / iOS app). It is
deliberately dumb and isolated: it holds only expiring transition snippets, returned
takes, and pushed password verifiers — **never the station's library, logs, or
config**. See `REMOTE_VT_PHASE2.md` in the desktop repo for the full design.

- **Stack:** server-side Swift (Vapor 4). Shares the exchange contract with the
  desktop (`Contract.swift` mirrors `AvvioOne/Models/RemoteVT/RemoteVTContract.swift`).
- **Storage:** local disk under `AVVIO_VT_DATA` (JSON metadata + audio blobs), with
  an expiry reaper. Just mount a volume.
- **Auth:** station endpoints use a bearer **station key**; trackers log in with
  their **Avvio username/password**, validated against the PBKDF2 verifier the
  desktop pushes (works with the studio offline).
- **Web app:** static files in `Public/` are served at `/`, same-origin with the API.

## Run locally

```bash
AVVIO_VT_STATION_KEY=dev-key AVVIO_VT_DATA=./data swift run AvvioVTRelay serve --port 8899
curl localhost:8899/v1/health   # -> ok
```

## Deploy (Docker)

```bash
export AVVIO_VT_STATION_KEY="$(openssl rand -hex 32)"   # keep this — the desktop needs it
docker compose up -d --build
```

Put it behind a TLS reverse proxy (Caddy/Traefik/nginx) on a public hostname; point
the desktop's **Settings ▸ Remote Voice Tracks** at `https://your-host` with the same
station key. The `/data` volume persists slots/results.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `AVVIO_VT_STATION_KEY` | *(empty = open, dev only)* | Bearer secret for station endpoints. **Set in production.** |
| `AVVIO_VT_DATA` | `./data` | Data directory (metadata + audio blobs). |
| `AVVIO_VT_EXPIRY_DAYS` | `14` | How long slots/results live before the reaper prunes them. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Bind address. |

## API (v1)

Station (bearer = station key): `POST /station/provision`, `PUT /station/slots/:id`,
`DELETE /station/slots/:id`, `GET /station/results?since=`, `GET
/station/results/:id/audio`, `POST /station/results/:id/ack`, `GET /station/status`.

Tracker (bearer = session token): `POST /auth/login`, `POST /auth/refresh`, `GET
/me/slots`, `GET /me/slots/:id`, `GET /me/slots/:id/audio/:role`, `POST
/me/slots/:id/claim`, `POST /me/slots/:id/result`.
