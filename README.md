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
- `POST /scenarios/:id/events` appends an event (`type` required, `payload` optional object), increments the scenario `revision`, and returns `201` with the event. An optional `occurredAt` pins the event time; it must be an exact UTC timestamp in the form `YYYY-MM-DDTHH:mm:ss.SSSZ`, denote a real date, and not be earlier than the scenario's previous event `occurredAt` (equal is allowed). When omitted, the server generates the time. Invalid or regressing values return a JSON `400` without appending an event or changing `revision`.
- `GET /scenarios/:id/events` reads events in ascending `sequence` order with stable, stateless keyset pagination:
  - Optional `from` and `to` (at most one each) form a closed interval on `occurredAt`; a missing bound is unbounded. When present they must be exact UTC timestamps in the form `YYYY-MM-DDTHH:mm:ss.SSSZ` and denote a real date.
  - `to` earlier than `from`, repeated parameters, or unknown parameters return a JSON `400`.
  - Optional `limit` is a decimal integer between `1` and `100` (default `50`).
  - The response is `{ revision, events, nextCursor }`; `nextCursor` is `null` on the last page.
  - Follow-up requests pass the previous `nextCursor` together with the exact same `from`, `to`, and `limit`. A cursor that is malformed, belongs to another scenario, mismatches the filters, or was issued before the scenario's `revision` changed returns a JSON `400`. The first request must not carry a cursor.
  - Reads never modify events or `revision`.
- Malformed or invalid JSON requests return a JSON `400` without writing any data.
- Unknown routes return JSON with status `404`.

All scenario and event data is held in process memory only and is lost on restart.
