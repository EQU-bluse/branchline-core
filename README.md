# Branchline Core

Branchline Core is a small API-first backend for deterministic counterfactual simulations. The initial baseline exposes service metadata; scenario, timeline, and branching capabilities are added through the public API over time.

## Requirements

- Node.js 24

## Run

```bash
npm start
```

The server listens on `HOST` (default `127.0.0.1`) and `PORT` (default `3000`).

## Test

```bash
npm test
```

## Public API

- `GET /health` returns JSON service health and version information.
- `POST /scenarios` creates a scenario from a JSON body (`name` required, `description` optional) and returns `201`.
- `GET /scenarios` lists all scenarios in creation order.
- `GET /scenarios/:id` returns one scenario, or a JSON `404` if it does not exist.
- `POST /scenarios/:id/events` appends an event (`type` required, `payload` optional object), increments the scenario `revision`, and returns `201` with the event.
- Malformed or invalid JSON requests return a JSON `400` without writing any data.
- Unknown routes return JSON with status `404`.

All scenario and event data is held in process memory only and is lost on restart.
