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
- `POST /scenarios/:id/branches` creates an independently writable scenario from a parent's history prefix. The JSON body requires a non-empty string `name` and an integer `fromRevision` (`0` through the parent's current `revision`, inclusive); `description` is an optional string. It returns `201` with a new scenario whose `revision` equals `fromRevision`, whose `events` are an independent deep copy of the parent's first `fromRevision` events in ascending `sequence` order (empty when `fromRevision` is `0`), and that additionally carries `parentScenarioId` and `parentRevision` (`= fromRevision`). The parent scenario is not modified and its pagination cursors stay valid. A missing parent returns a JSON `404`; an empty body, wrong media type, malformed JSON, missing or mistyped fields, a non-integer or out-of-range `fromRevision` return a JSON `400` and create nothing.
- `POST /scenarios/:id/events` appends an event (`type` required, `payload` optional object), increments the scenario `revision`, and returns `201` with the event. This works identically on branches: `sequence` continues after the copied prefix, and writes affect only that scenario. Later writes to a parent or sibling branch never alter an existing branch's history, `revision`, or metadata. An optional `occurredAt` pins the event time; it must be an exact UTC timestamp in the form `YYYY-MM-DDTHH:mm:ss.SSSZ`, denote a real date, and not be earlier than the scenario's previous event `occurredAt` (equal is allowed). When omitted, the event uses the scenario's virtual clock `currentTime` if one is set, otherwise the server generates the time. If the set clock is earlier than the last event's `occurredAt`, the append returns a JSON `400` without side effects; advance the clock or pass an explicit `occurredAt`. Invalid or regressing values return a JSON `400` without appending an event or changing `revision`.
- `POST /scenarios/:id/clock` sets or advances the scenario's virtual clock. The JSON body requires `currentTime`, an exact UTC timestamp in the form `YYYY-MM-DDTHH:mm:ss.SSSZ` denoting a real date; it must not be earlier than the scenario's last event `occurredAt` or the current clock value (equal is allowed). Returns `200` with `{ scenarioId, currentTime }`. Invalid requests return a JSON `400` without side effects; an unknown scenario returns a JSON `404`.
- `GET /scenarios/:id/clock` returns `200` with `{ scenarioId, currentTime }`; `currentTime` is `null` when the clock was never set. Clock operations never change `revision`, events, event `sequence`, or the validity of existing pagination cursors. Branches start with a `null` clock and their clocks are isolated from the parent and sibling scenarios.
- `GET /scenarios/:id/events` reads events in ascending `sequence` order with stable, stateless keyset pagination:
  - Optional `from` and `to` (at most one each) form a closed interval on `occurredAt`; a missing bound is unbounded. When present they must be exact UTC timestamps in the form `YYYY-MM-DDTHH:mm:ss.SSSZ` and denote a real date.
  - `to` earlier than `from`, repeated parameters, or unknown parameters return a JSON `400`.
  - Optional `limit` is a decimal integer between `1` and `100` (default `50`).
  - The response is `{ revision, events, nextCursor }`; `nextCursor` is `null` on the last page.
  - Follow-up requests pass the previous `nextCursor` together with the exact same `from`, `to`, and `limit`. A cursor that is malformed, belongs to another scenario, mismatches the filters, or was issued before the scenario's `revision` changed returns a JSON `400`. The first request must not carry a cursor.
  - Reads never modify events or `revision`.
- `POST /scenarios/:id/rules` attaches a replay rule to a scenario. The JSON body requires a non-empty string `name`, a `when` object containing only a non-empty string `type`, and a `then` object with a non-empty string `type` and an optional object `payload` (defaulting to `{}`); any other or extra field is rejected. It returns `201` with the stored rule (`{ id, name, when, then }`, with a unique `id`), and rules belong to the scenario in creation order. An unknown scenario returns the JSON `404`; wrong media type, malformed JSON, missing or mistyped fields, extra fields, or a non-object `payload` return a JSON `400` and store nothing.
- `GET /scenarios/:id/rules` returns `200` with the scenario's rules as a JSON array in creation order, or the JSON `404` for an unknown scenario.
- `GET /scenarios/:id/replay` read-only evaluates the rules against the current timeline: events are walked in ascending `sequence` order and every rule whose `when.type` equals the event `type` fires in creation order, producing `{ ruleId, sourceSequence, type, payload, occurredAt }` where `type` and `payload` come from the rule's `then` and `occurredAt` equals the source event's. The response is `{ revision, results }`. An unknown scenario returns the JSON `404`.
- Creating, listing, and replaying rules never change `revision`, events, the virtual clock, or the validity of existing pagination cursors. Branches copy only the parent's history prefix: they do not inherit the parent's rules, and rules on a parent, branch, or sibling stay isolated from one another.
- Malformed or invalid JSON requests return a JSON `400` without writing any data.
- Unknown routes return JSON with status `404`.

All scenario and event data is held in process memory only and is lost on restart.
