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
- `POST /scenarios/:id/events` appends an event (`type` required, `payload` optional object), increments the scenario `revision`, and returns `201` with the event. This works identically on branches: `sequence` continues after the copied prefix, and writes affect only that scenario. Later writes to a parent or sibling branch never alter an existing branch's history, `revision`, or metadata. An optional `occurredAt` pins the event time; it must be an exact UTC timestamp in the form `YYYY-MM-DDTHH:mm:ss.SSSZ`, denote a real date, and not be earlier than the scenario's previous event `occurredAt` (equal is allowed). When omitted, the event uses the scenario's virtual clock `currentTime` if one is set, otherwise the server generates the time; if a set clock is earlier than the last event's `occurredAt`, the request returns a JSON `400` without appending an event or changing `revision` (advancing the clock clears the condition). Invalid or regressing values return a JSON `400` without appending an event or changing `revision`.
- `POST /scenarios/:id/clock` sets or advances the scenario's virtual clock. The JSON body requires `currentTime`, an exact UTC timestamp in the form `YYYY-MM-DDTHH:mm:ss.SSSZ` denoting a real date; it must not be earlier than the scenario's last event `occurredAt` or the current clock value (equal is allowed). Returns `200` with `{ scenarioId, currentTime }`. Invalid requests return a JSON `400` without side effects; an unknown scenario returns a JSON `404`.
- `GET /scenarios/:id/clock` returns `200` with `{ scenarioId, currentTime }`; `currentTime` is `null` when the clock was never set. Clock operations never change `revision`, events, event `sequence`, or the validity of existing pagination cursors. Branches start with a `null` clock and their clocks are isolated from the parent and sibling scenarios.
- `POST /scenarios/:id/rules` registers a replayable counterfactual rule. The JSON body requires a non-empty string `name`, a `when` object containing exactly one field, the non-empty string `type`, and a `then` object containing the non-empty string `type` and an optional object `payload`; no other fields are permitted. It returns `201` with the stored rule, which additionally carries a unique `id`. Rules belong to the scenario in creation order; creating one never changes `revision`, events, the clock, or existing cursors. An unknown scenario returns a JSON `404`; a wrong media type, malformed or non-object JSON, missing or mistyped fields, extra fields, or a non-object `payload` return a JSON `400` and write nothing.
- `GET /scenarios/:id/rules` returns `200` with the scenario's rules in creation order (an empty list when none exist), or a JSON `404` for an unknown scenario.
- `GET /scenarios/:id/replay` performs a read-only derivation over the scenario's current events and returns `200` with `{ revision, results }`. Events are walked in ascending `sequence`; for each event, every rule whose `when.type` equals the event's `type` fires in rule creation order, producing `{ ruleId, sourceSequence, type, payload, occurredAt }` where `type` and `payload` come from the rule's `then` (`payload` defaults to `{}`) and `occurredAt` equals the source event's `occurredAt`. Replay never changes `revision`, events, the clock, or cursors; an unknown scenario returns a JSON `404`. Branching copies only the history prefix: a branch never inherits the parent's rules, and rules subsequently added to either scenario stay isolated.
- `GET /scenarios/:id/replay/diff?against=:otherId` compares the current scenario's read-only replay results with another existing scenario's current replay results and returns `200` with `{ scenarioId, revision, againstScenarioId, againstRevision, added, removed }`; the revision fields report each side's current `revision`. Both sides are derived with the same replay rules as `GET /scenarios/:id/replay`. Results are compared by `sourceSequence`, `type`, `payload`, and `occurredAt` (ignoring `ruleId`); `payload` is compared structurally, so differing object field order still compares equal. Results are treated as a multiset: duplicates cancel one occurrence at a time. `added` holds the results remaining only on the current side and `removed` the results remaining only on the `against` side, each in that side's original replay order with the full result fields (including `ruleId`). The query is read-only on both sides: it never changes revisions, events, rules, clocks, or existing pagination cursors. `against` must appear exactly once and be a non-empty string; a missing, empty, or repeated `against`, or any other query parameter, returns a JSON `400`. If either scenario does not exist, the response is the existing JSON `404`.
- `GET /scenarios/:id/replay/explain?ruleId=:ruleId&sourceSequence=:n` re-derives a single replay result and explains its causal origin. Both query parameters must appear exactly once and be non-empty; `sourceSequence` must be a positive decimal integer with no sign, decimal point, exponent, or leading/trailing whitespace. Returns `200` with `{ scenarioId, revision, result, event, rule, ancestry }`: `result` is the full replay result object (`{ ruleId, sourceSequence, type, payload, occurredAt }`) that `GET /scenarios/:id/replay` would produce for this rule and event; `event` and `rule` are the full stored source event and rule objects. `ancestry` lists the branch chain from the current scenario toward the root scenario, one entry per scenario as `{ scenarioId, parentScenarioId, parentRevision }`; the root entry (last) has both parent fields set to `null`. The query is read-only: successful, failing, or repeated requests never change any scenario's `revision`, events, rules, clock, or existing event pagination cursors. An unknown scenario returns the existing JSON `404` (taking precedence over parameter validation). A missing, empty, or repeated `ruleId`/`sourceSequence`, an unknown query parameter, an illegal `sourceSequence`, a rule that does not belong to the scenario, a `sourceSequence` with no event, or a rule whose `when.type` does not match that event all return a JSON `400`.
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
