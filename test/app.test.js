import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createApp, createScenarioStore } from "../src/app.js";

async function withServer(run, app = createApp()) {
  const server = createServer(app.handleRequest);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.body !== undefined
      ? { "content-type": options.contentType ?? "application/json", ...options.headers }
      : options.headers,
    body: options.body
  });
  return { status: response.status, body: await response.json() };
}

test("GET /health returns service metadata", async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "branchline-core",
      version: "0.1.0"
    });
  });
});

test("unknown routes return a JSON 404", async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "not_found",
      message: "Route not found"
    });
  });
});

test("POST /scenarios creates a scenario with defaults", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Baseline" })
    });
    assert.equal(created.status, 201);
    const scenario = created.body;
    assert.equal(typeof scenario.id, "string");
    assert.ok(scenario.id.length > 0);
    assert.equal(scenario.name, "Baseline");
    assert.equal(scenario.description, "");
    assert.equal(scenario.revision, 0);
    assert.deepEqual(scenario.events, []);
    assert.equal(typeof scenario.createdAt, "string");
    assert.ok(!Number.isNaN(Date.parse(scenario.createdAt)));
  });
});

test("POST /scenarios accepts a description and preserves it", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Alt", description: "a branch" })
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.description, "a branch");
  });
});

test("POST /scenarios accepts application/json with a charset", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ name: "Charset" })
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, "Charset");
  });
});

test("GET /scenarios lists scenarios in creation order", async () => {
  await withServer(async baseUrl => {
    const first = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "First" })
    });
    const second = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Second" })
    });

    const list = await requestJson(baseUrl, "/scenarios");
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 2);
    assert.equal(list.body[0].id, first.body.id);
    assert.equal(list.body[1].id, second.body.id);
  });
});

test("GET /scenarios/:id returns the scenario or 404", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Lookup" })
    });

    const found = await requestJson(baseUrl, `/scenarios/${created.body.id}`);
    assert.equal(found.status, 200);
    assert.deepEqual(found.body, created.body);

    const missing = await requestJson(baseUrl, "/scenarios/does-not-exist");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "not_found");
  });
});

test("events append in sequence order and bump revision", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Timeline" })
    });
    const id = created.body.id;

    const first = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "start", payload: { at: 1 } })
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.sequence, 1);
    assert.equal(first.body.type, "start");
    assert.deepEqual(first.body.payload, { at: 1 });
    assert.equal(typeof first.body.id, "string");
    assert.ok(first.body.id.length > 0);
    assert.ok(!Number.isNaN(Date.parse(first.body.occurredAt)));

    const second = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "continue" })
    });
    assert.equal(second.status, 201);
    assert.equal(second.body.sequence, 2);
    assert.deepEqual(second.body.payload, {});

    assert.notEqual(first.body.id, second.body.id);

    const fetched = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.revision, 2);
    assert.equal(fetched.body.events.length, 2);
    assert.deepEqual(fetched.body.events.map(e => e.sequence), [1, 2]);
    assert.deepEqual(fetched.body.events.map(e => e.type), ["start", "continue"]);
    assert.deepEqual(fetched.body.events[0], first.body);
  });
});

test("POST events on an unknown scenario returns 404", async () => {
  await withServer(async baseUrl => {
    const result = await requestJson(baseUrl, "/scenarios/nope/events", {
      method: "POST",
      body: JSON.stringify({ type: "x" })
    });
    assert.equal(result.status, 404);
    assert.equal(result.body.error, "not_found");
  });
});

test("scenarios are isolated from each other", async () => {
  await withServer(async baseUrl => {
    const a = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "A" })
    });
    const b = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "B" })
    });

    await requestJson(baseUrl, `/scenarios/${a.body.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "a-event" })
    });

    const fetchedA = await requestJson(baseUrl, `/scenarios/${a.body.id}`);
    const fetchedB = await requestJson(baseUrl, `/scenarios/${b.body.id}`);
    assert.equal(fetchedA.body.revision, 1);
    assert.equal(fetchedA.body.events.length, 1);
    assert.equal(fetchedB.body.revision, 0);
    assert.deepEqual(fetchedB.body.events, []);
  });
});

test("invalid scenario requests return 400 and do not persist", async () => {
  await withServer(async baseUrl => {
    const cases = [
      ["", undefined, "empty body"],
      ["{", "application/json", "malformed JSON"],
      ["[]", "application/json", "JSON array body"],
      [JSON.stringify({ description: "no name" }), "application/json", "missing name"],
      [JSON.stringify({ name: "" }), "application/json", "empty name"],
      [JSON.stringify({ name: 5 }), "application/json", "non-string name"],
      [JSON.stringify({ name: "x", description: 1 }), "application/json", "non-string description"]
    ];

    for (const [body, contentType, label] of cases) {
      const result = await requestJson(baseUrl, "/scenarios", {
        method: "POST",
        contentType,
        body
      });
      assert.equal(result.status, 400, label);
      assert.equal(typeof result.body.error, "string", label);
    }

    const list = await requestJson(baseUrl, "/scenarios");
    assert.deepEqual(list.body, []);
  });
});

test("invalid event requests return 400 without changing revision", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Guarded" })
    });
    const id = created.body.id;

    const cases = [
      ["", undefined, "empty body"],
      ["not json", "application/json", "malformed JSON"],
      [JSON.stringify({ payload: {} }), "application/json", "missing type"],
      [JSON.stringify({ type: "" }), "application/json", "empty type"],
      [JSON.stringify({ type: 7 }), "application/json", "non-string type"],
      [JSON.stringify({ type: "x", payload: [] }), "application/json", "array payload"],
      [JSON.stringify({ type: "x", payload: "y" }), "application/json", "string payload"],
      [JSON.stringify({ type: "x", payload: null }), "application/json", "null payload"]
    ];

    for (const [body, contentType, label] of cases) {
      const result = await requestJson(baseUrl, `/scenarios/${id}/events`, {
        method: "POST",
        contentType,
        body
      });
      assert.equal(result.status, 400, label);
      assert.equal(typeof result.body.error, "string", label);
    }

    const fetched = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.equal(fetched.body.revision, 0);
    assert.deepEqual(fetched.body.events, []);
  });
});

async function createScenarioWithEvents(baseUrl, count, name = "Paging") {
  const created = await requestJson(baseUrl, "/scenarios", {
    method: "POST",
    body: JSON.stringify({ name })
  });
  const id = created.body.id;
  const events = [];
  for (let index = 0; index < count; index += 1) {
    const result = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: `event-${index + 1}`, payload: { index } })
    });
    assert.equal(result.status, 201);
    events.push(result.body);
  }
  return { id, events };
}

async function fetchAllEventPages(baseUrl, id, initialQuery = "") {
  const seen = [];
  const separator = initialQuery.includes("?") ? "&" : "?";
  const baseQuery = initialQuery === "" ? "" : initialQuery;
  let cursor = null;
  let pages = 0;
  for (;;) {
    const cursorPart = cursor === null ? "" : `${separator}cursor=${encodeURIComponent(cursor)}`;
    const page = await requestJson(baseUrl, `/scenarios/${id}/events${baseQuery}${cursorPart}`);
    assert.equal(page.status, 200);
    pages += 1;
    seen.push(...page.body.events);
    if (page.body.nextCursor === null) {
      break;
    }
    cursor = page.body.nextCursor;
    if (pages > 1000) {
      throw new Error("pagination did not terminate");
    }
  }
  return { events: seen, pages };
}

function seedScenario(timestamps) {
  const store = createScenarioStore();
  const id = randomUUID();
  const scenario = {
    id,
    name: "Seeded",
    description: "",
    revision: timestamps.length,
    createdAt: "2024-01-01T00:00:00.000Z",
    events: timestamps.map((occurredAt, index) => ({
      id: randomUUID(),
      type: `event-${index + 1}`,
      payload: { index },
      occurredAt,
      sequence: index + 1
    }))
  };
  store.scenarios.set(id, scenario);
  return { store, id, scenario, events: scenario.events };
}

function timestamps(count, startSecond = 0) {
  return Array.from(
    { length: count },
    (_, index) => `2024-01-01T00:00:${String(startSecond + index).padStart(2, "0")}.000Z`
  );
}

test("GET events returns 404 JSON for an unknown scenario", async () => {
  await withServer(async baseUrl => {
    const result = await requestJson(baseUrl, "/scenarios/unknown/events");
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: "not_found", message: "Scenario not found" });

    const withParams = await requestJson(baseUrl, "/scenarios/unknown/events?limit=1");
    assert.equal(withParams.status, 404);
    assert.equal(withParams.body.error, "not_found");
  });
});

test("GET events lists events in ascending sequence with default limit", async () => {
  await withServer(async baseUrl => {
    const { id, events } = await createScenarioWithEvents(baseUrl, 3);

    const result = await requestJson(baseUrl, `/scenarios/${id}/events`);
    assert.equal(result.status, 200);
    assert.equal(result.body.revision, 3);
    assert.deepEqual(result.body.events, events);
    assert.deepEqual(
      result.body.events.map(event => event.sequence),
      [1, 2, 3]
    );
    assert.equal(result.body.nextCursor, null);
  });
});

test("GET events on an empty timeline returns an empty page without a cursor", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Empty" })
    });

    const result = await requestJson(baseUrl, `/scenarios/${created.body.id}/events`);
    assert.equal(result.status, 200);
    assert.equal(result.body.revision, 0);
    assert.deepEqual(result.body.events, []);
    assert.equal(result.body.nextCursor, null);
  });
});

test("default limit is 50 and exact-page results have no next cursor", async () => {
  await withServer(async baseUrl => {
    const { id, events } = await createScenarioWithEvents(baseUrl, 50);

    const result = await requestJson(baseUrl, `/scenarios/${id}/events`);
    assert.equal(result.status, 200);
    assert.equal(result.body.events.length, 50);
    assert.deepEqual(result.body.events, events);
    assert.equal(result.body.nextCursor, null);
  });
});

test("pagination walks every event without duplicates or gaps", async () => {
  await withServer(async baseUrl => {
    const { id, events } = await createScenarioWithEvents(baseUrl, 12);

    for (const limit of [1, 3, 5, 7, 12, 100]) {
      const { events: seen, pages } = await fetchAllEventPages(baseUrl, id, `?limit=${limit}`);
      assert.deepEqual(seen, events, `limit=${limit}`);
      assert.deepEqual(
        seen.map(event => event.sequence),
        events.map(event => event.sequence),
        `limit=${limit} sequences`
      );
      assert.equal(pages, Math.ceil(12 / limit), `limit=${limit} page count`);
    }
  });
});

test("each page is stable: repeating a cursor returns the same events", async () => {
  await withServer(async baseUrl => {
    const { id } = await createScenarioWithEvents(baseUrl, 7);

    const first = await requestJson(baseUrl, `/scenarios/${id}/events?limit=3`);
    assert.equal(first.body.events.length, 3);
    assert.equal(typeof first.body.nextCursor, "string");

    const second = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?limit=3&cursor=${encodeURIComponent(first.body.nextCursor)}`
    );
    const secondAgain = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?limit=3&cursor=${encodeURIComponent(first.body.nextCursor)}`
    );
    assert.deepEqual(second.body.events, secondAgain.body.events);
    assert.deepEqual(second.body.nextCursor, secondAgain.body.nextCursor);

    const sequences = [
      ...first.body.events,
      ...second.body.events,
      ...secondAgain.body.events
    ].map(event => event.sequence);
    assert.deepEqual(sequences, [1, 2, 3, 4, 5, 6, 4, 5, 6]);
  });
});

test("range filters use a closed interval on occurredAt and default to unbounded", async () => {
  const seeded = seedScenario(timestamps(5));
  await withServer(async baseUrl => {
    const { id, events } = seeded;
    const stamps = events.map(event => event.occurredAt);

    const within = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?from=${encodeURIComponent(stamps[1])}&to=${encodeURIComponent(stamps[3])}`
    );
    assert.equal(within.status, 200);
    assert.deepEqual(
      within.body.events.map(event => event.sequence),
      [2, 3, 4]
    );
    assert.equal(within.body.nextCursor, null);

    const fromOnly = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?from=${encodeURIComponent(stamps[3])}`
    );
    assert.deepEqual(
      fromOnly.body.events.map(event => event.sequence),
      [4, 5]
    );

    const toOnly = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?to=${encodeURIComponent(stamps[1])}`
    );
    assert.deepEqual(
      toOnly.body.events.map(event => event.sequence),
      [1, 2]
    );

    const equality = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?from=${encodeURIComponent(stamps[2])}&to=${encodeURIComponent(stamps[2])}`
    );
    assert.deepEqual(
      equality.body.events.map(event => event.sequence),
      [3]
    );

    // Millisecond precision: values a millisecond either side of an event stay excluded.
    const subMs = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?from=2024-01-01T00:00:01.001Z&to=2024-01-01T00:00:02.999Z`
    );
    assert.deepEqual(
      subMs.body.events.map(event => event.sequence),
      [3]
    );
  }, createApp(seeded.store));
});

test("range filtering combined with pagination stays continuous", async () => {
  const seeded = seedScenario(timestamps(9));
  await withServer(async baseUrl => {
    const { id, events } = seeded;
    const stamps = events.map(event => event.occurredAt);
    const query = `?from=${encodeURIComponent(stamps[2])}&to=${encodeURIComponent(stamps[7])}&limit=2`;

    const { events: seen, pages } = await fetchAllEventPages(baseUrl, id, query);
    assert.deepEqual(
      seen.map(event => event.sequence),
      [3, 4, 5, 6, 7, 8]
    );
    assert.equal(pages, 3);
  }, createApp(seeded.store));
});

test("a range matching no events returns an empty page without a cursor", async () => {
  const seeded = seedScenario(timestamps(3));
  await withServer(async baseUrl => {
    const { id } = seeded;

    const after = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?from=2999-01-01T00:00:00.000Z`
    );
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.events, []);
    assert.equal(after.body.nextCursor, null);

    const before = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?to=2000-01-01T00:00:00.000Z`
    );
    assert.deepEqual(before.body.events, []);
    assert.equal(before.body.nextCursor, null);

    const gap = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?from=2030-01-01T00:00:00.000Z&to=2031-01-01T00:00:00.000Z`
    );
    assert.deepEqual(gap.body.events, []);
    assert.equal(gap.body.nextCursor, null);
  }, createApp(seeded.store));
});

test("limit must be a decimal integer between 1 and 100", async () => {
  await withServer(async baseUrl => {
    const { id } = await createScenarioWithEvents(baseUrl, 1);

    for (const limit of ["0", "-1", "101", "1.5", "abc", "1e2", " 1", "1 ", "+1", "NaN", "Infinity", "0x10"]) {
      const result = await requestJson(baseUrl, `/scenarios/${id}/events?limit=${encodeURIComponent(limit)}`);
      assert.equal(result.status, 400, `limit=${limit}`);
      assert.equal(typeof result.body.error, "string", `limit=${limit}`);
    }

    for (const limit of ["1", "50", "100"]) {
      const result = await requestJson(baseUrl, `/scenarios/${id}/events?limit=${limit}`);
      assert.equal(result.status, 200, `limit=${limit}`);
    }
  });
});

test("invalid timestamp formats return 400", async () => {
  await withServer(async baseUrl => {
    const { id } = await createScenarioWithEvents(baseUrl, 1);

    const invalid = [
      "2024-01-01T00:00:00Z",
      "2024-01-01T00:00:00.00Z",
      "2024-01-01T00:00:00.000+00:00",
      "2024-01-01 00:00:00.000Z",
      "2024-1-1T00:00:00.000Z",
      "2024-01-01t00:00:00.000z",
      "not-a-date",
      "2024-02-30T12:00:00.000Z",
      "2023-02-29T00:00:00.000Z",
      "2024-13-01T00:00:00.000Z",
      "2024-01-01T24:00:00.000Z"
    ];

    for (const value of invalid) {
      const result = await requestJson(
        baseUrl,
        `/scenarios/${id}/events?from=${encodeURIComponent(value)}`
      );
      assert.equal(result.status, 400, `from=${value}`);
      assert.equal(typeof result.body.error, "string", `from=${value}`);
    }

    const valid = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?to=2024-02-29T00:00:00.000Z`
    );
    assert.equal(valid.status, 200);
  });
});

test("to earlier than from returns 400; equal bounds are accepted", async () => {
  await withServer(async baseUrl => {
    const { id } = await createScenarioWithEvents(baseUrl, 1);

    const earlier = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?from=2024-01-02T00:00:00.000Z&to=2024-01-01T00:00:00.000Z`
    );
    assert.equal(earlier.status, 400);
    assert.equal(typeof earlier.body.error, "string");

    const equal = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?from=2024-01-01T00:00:00.000Z&to=2024-01-01T00:00:00.000Z`
    );
    assert.equal(equal.status, 200);
  });
});

test("duplicated or empty query parameters return 400", async () => {
  await withServer(async baseUrl => {
    const { id } = await createScenarioWithEvents(baseUrl, 1);

    const cases = [
      "limit=1&limit=2",
      "from=2024-01-01T00:00:00.000Z&from=2024-02-01T00:00:00.000Z",
      "to=2024-01-01T00:00:00.000Z&to=2024-02-01T00:00:00.000Z",
      "cursor=a&cursor=b",
      "limit=",
      "from=",
      "to=",
      "cursor=",
      "bogus=1"
    ];

    for (const query of cases) {
      const result = await requestJson(baseUrl, `/scenarios/${id}/events?${query}`);
      assert.equal(result.status, 400, query);
      assert.equal(typeof result.body.error, "string", query);
    }
  });
});

test("pagination handles more events than the maximum limit", async () => {
  await withServer(async baseUrl => {
    const { id, events } = await createScenarioWithEvents(baseUrl, 150);

    const { events: seen, pages } = await fetchAllEventPages(baseUrl, id, "?limit=100");
    assert.equal(pages, 2);
    assert.deepEqual(seen, events);
    assert.deepEqual(
      seen.map(event => event.sequence),
      Array.from({ length: 150 }, (_, index) => index + 1)
    );
  });
});

test("a cursor requires the same limit on the follow-up request", async () => {
  await withServer(async baseUrl => {
    const { id } = await createScenarioWithEvents(baseUrl, 4);
    const page = await requestJson(baseUrl, `/scenarios/${id}/events?limit=2`);

    // Omitting limit falls back to the default of 50, which no longer matches the cursor.
    const withoutLimit = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?cursor=${encodeURIComponent(page.body.nextCursor)}`
    );
    assert.equal(withoutLimit.status, 400);
    assert.equal(typeof withoutLimit.body.error, "string");

    const withLimit = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`
    );
    assert.equal(withLimit.status, 200);
    assert.deepEqual(
      withLimit.body.events.map(event => event.sequence),
      [3, 4]
    );
    assert.equal(withLimit.body.nextCursor, null);
  });
});

test("invalid and tampered cursors return 400", async () => {
  await withServer(async baseUrl => {
    const { id } = await createScenarioWithEvents(baseUrl, 4);
    const page = await requestJson(baseUrl, `/scenarios/${id}/events?limit=2`);
    const cursor = page.body.nextCursor;
    assert.equal(typeof cursor, "string");

    const invalid = [
      "",
      "not-base64!",
      "abc.def",
      "###",
      cursor.replace(/.$/, cursor.endsWith("A") ? "B" : "A"),
      `${cursor}x`
    ];

    for (const value of invalid) {
      const result = await requestJson(
        baseUrl,
        `/scenarios/${id}/events?limit=2&cursor=${encodeURIComponent(value)}`
      );
      assert.equal(result.status, 400, `cursor=${value.slice(0, 12)}`);
      assert.equal(typeof result.body.error, "string");
    }
  });
});

test("a cursor cannot be replayed without its exact filter parameters", async () => {
  await withServer(async baseUrl => {
    const { id, events } = await createScenarioWithEvents(baseUrl, 6);
    const stamp = events[0].occurredAt;
    const page = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?from=${encodeURIComponent(stamp)}&limit=2`
    );
    const cursor = page.body.nextCursor;

    const mismatches = [
      `/events?limit=2&cursor=${encodeURIComponent(cursor)}`,
      `/events?from=${encodeURIComponent(stamp)}&limit=3&cursor=${encodeURIComponent(cursor)}`,
      `/events?from=2000-01-01T00:00:00.000Z&limit=2&cursor=${encodeURIComponent(cursor)}`,
      `/events?from=${encodeURIComponent(stamp)}&to=2999-01-01T00:00:00.000Z&limit=2&cursor=${encodeURIComponent(cursor)}`
    ];

    for (const suffix of mismatches) {
      const result = await requestJson(baseUrl, `/scenarios/${id}${suffix}`);
      assert.equal(result.status, 400, suffix);
      assert.equal(typeof result.body.error, "string");
    }

    const matched = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?from=${encodeURIComponent(stamp)}&limit=2&cursor=${encodeURIComponent(cursor)}`
    );
    assert.equal(matched.status, 200);
    assert.deepEqual(
      matched.body.events.map(event => event.sequence),
      [3, 4]
    );
  });
});

test("a cursor from another scenario returns 400", async () => {
  await withServer(async baseUrl => {
    const first = await createScenarioWithEvents(baseUrl, 3, "First");
    const second = await createScenarioWithEvents(baseUrl, 3, "Second");

    const page = await requestJson(baseUrl, `/scenarios/${first.id}/events?limit=1`);
    const cursor = page.body.nextCursor;

    const reused = await requestJson(
      baseUrl,
      `/scenarios/${second.id}/events?limit=1&cursor=${encodeURIComponent(cursor)}`
    );
    assert.equal(reused.status, 400);
    assert.equal(typeof reused.body.error, "string");

    const randomSid = encodeURIComponent(randomUUID());
    const unknown = await requestJson(baseUrl, `/scenarios/${randomSid}/events`);
    assert.equal(unknown.status, 404);
  });
});

test("cursors are invalidated after a write changes the revision", async () => {
  await withServer(async baseUrl => {
    const { id } = await createScenarioWithEvents(baseUrl, 4);

    const page = await requestJson(baseUrl, `/scenarios/${id}/events?limit=2`);
    assert.equal(typeof page.body.nextCursor, "string");

    const appended = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "late" })
    });
    assert.equal(appended.status, 201);

    const stale = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`
    );
    assert.equal(stale.status, 400);
    assert.equal(typeof stale.body.error, "string");

    // The revision reflects the write, and paging restarts from the beginning.
    const restarted = await requestJson(baseUrl, `/scenarios/${id}/events?limit=2`);
    assert.equal(restarted.body.revision, 5);
    assert.deepEqual(
      restarted.body.events.map(event => event.sequence),
      [1, 2]
    );
  });
});

test("failed event-list requests do not mutate revision or events", async () => {
  const store = createScenarioStore();
  await withServer(async baseUrl => {
    const { id } = await createScenarioWithEvents(baseUrl, 2);

    const badRequests = [
      "/events?limit=0",
      "/events?limit=101",
      "/events?from=nonsense",
      "/events?to=2024-02-30T00:00:00.000Z",
      "/events?from=2024-02-01T00:00:00.000Z&to=2024-01-01T00:00:00.000Z",
      "/events?limit=1&limit=2",
      "/events?cursor=tampered"
    ];
    for (const suffix of badRequests) {
      const result = await requestJson(baseUrl, `/scenarios/${id}${suffix}`);
      assert.equal(result.status, 400, suffix);
    }

    const scenario = store.scenarios.get(id);
    assert.equal(scenario.revision, 2);
    assert.equal(scenario.events.length, 2);

    const fetched = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.equal(fetched.body.revision, 2);
    assert.equal(fetched.body.events.length, 2);
  }, createApp(store));
});

test("successful event-list requests do not mutate revision or events", async () => {
  const store = createScenarioStore();
  await withServer(async baseUrl => {
    const { id, events } = await createScenarioWithEvents(baseUrl, 5);

    await fetchAllEventPages(baseUrl, id, "?limit=2");

    const scenario = store.scenarios.get(id);
    assert.equal(scenario.revision, 5);
    assert.equal(scenario.events.length, 5);
    assert.deepEqual(scenario.events, events);
  }, createApp(store));
});

test("paged event objects match the create-event response shape", async () => {
  await withServer(async baseUrl => {
    const { id } = await createScenarioWithEvents(baseUrl, 3, "Shape");
    const created = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "shape", payload: { a: 1, nested: { b: true } } })
    });

    const { events: seen } = await fetchAllEventPages(baseUrl, id, "?limit=2");
    assert.equal(seen.length, 4);
    const lastEvent = seen.find(event => event.sequence === 4);
    assert.deepEqual(lastEvent, created.body);
    for (const event of seen) {
      assert.deepEqual(Object.keys(event).sort(), ["id", "occurredAt", "payload", "sequence", "type"]);
    }
  });
});

test("an explicit occurredAt is preserved in the response, scenario, and event list", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Deterministic" })
    });
    const id = created.body.id;

    const first = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "start", occurredAt: "2024-03-01T10:00:00.000Z" })
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.occurredAt, "2024-03-01T10:00:00.000Z");
    assert.equal(first.body.sequence, 1);

    const second = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "next", occurredAt: "2024-03-01T11:30:00.000Z" })
    });
    assert.equal(second.status, 201);
    assert.equal(second.body.occurredAt, "2024-03-01T11:30:00.000Z");
    assert.equal(second.body.sequence, 2);

    const scenario = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.equal(scenario.status, 200);
    assert.deepEqual(
      scenario.body.events.map(event => event.occurredAt),
      ["2024-03-01T10:00:00.000Z", "2024-03-01T11:30:00.000Z"]
    );

    const listed = await requestJson(baseUrl, `/scenarios/${id}/events`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.events, [first.body, second.body]);

    // Explicit timestamps are range-queryable through the existing filters.
    const ranged = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?from=2024-03-01T10:30:00.000Z&to=2024-03-01T12:00:00.000Z`
    );
    assert.equal(ranged.status, 200);
    assert.deepEqual(
      ranged.body.events.map(event => event.sequence),
      [2]
    );
  });
});

test("equal and increasing explicit occurredAt values are accepted", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Monotonic" })
    });
    const id = created.body.id;

    const stamps = [
      "2024-05-01T00:00:00.000Z",
      "2024-05-01T00:00:00.000Z",
      "2024-05-01T00:00:00.001Z",
      "2024-05-01T00:00:00.001Z",
      "2024-05-02T00:00:00.000Z"
    ];
    for (const [index, occurredAt] of stamps.entries()) {
      const result = await requestJson(baseUrl, `/scenarios/${id}/events`, {
        method: "POST",
        body: JSON.stringify({ type: `event-${index + 1}`, occurredAt })
      });
      assert.equal(result.status, 201, occurredAt);
      assert.equal(result.body.occurredAt, occurredAt);
      assert.equal(result.body.sequence, index + 1);
    }

    const fetched = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.equal(fetched.body.revision, stamps.length);
    assert.deepEqual(
      fetched.body.events.map(event => event.occurredAt),
      stamps
    );
  });
});

test("a regressing occurredAt returns 400 without side effects", async () => {
  const store = createScenarioStore();
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Guarded timeline" })
    });
    const id = created.body.id;

    for (const occurredAt of ["2024-06-01T00:00:00.000Z", "2024-06-03T00:00:00.000Z"]) {
      const result = await requestJson(baseUrl, `/scenarios/${id}/events`, {
        method: "POST",
        body: JSON.stringify({ type: "pinned", occurredAt })
      });
      assert.equal(result.status, 201);
    }

    // A cursor issued now must survive the rejected write.
    const page = await requestJson(baseUrl, `/scenarios/${id}/events?limit=1`);
    assert.equal(page.status, 200);
    assert.equal(typeof page.body.nextCursor, "string");

    for (const occurredAt of ["2024-06-02T23:59:59.999Z", "2020-01-01T00:00:00.000Z"]) {
      const result = await requestJson(baseUrl, `/scenarios/${id}/events`, {
        method: "POST",
        body: JSON.stringify({ type: "late", occurredAt })
      });
      assert.equal(result.status, 400, occurredAt);
      assert.equal(result.body.error, "bad_request");
    }

    const scenario = store.scenarios.get(id);
    assert.equal(scenario.revision, 2);
    assert.equal(scenario.events.length, 2);

    const fetched = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.equal(fetched.body.revision, 2);
    assert.equal(fetched.body.events.length, 2);

    const followUp = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?limit=1&cursor=${encodeURIComponent(page.body.nextCursor)}`
    );
    assert.equal(followUp.status, 200);
    assert.deepEqual(
      followUp.body.events.map(event => event.sequence),
      [2]
    );
  }, createApp(store));
});

test("invalid explicit occurredAt values return 400 without side effects", async () => {
  const store = createScenarioStore();
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Validated" })
    });
    const id = created.body.id;

    const cases = [
      [JSON.stringify({ type: "x", occurredAt: 1717171717 }), "numeric occurredAt"],
      [JSON.stringify({ type: "x", occurredAt: null }), "null occurredAt"],
      [JSON.stringify({ type: "x", occurredAt: true }), "boolean occurredAt"],
      [JSON.stringify({ type: "x", occurredAt: {} }), "object occurredAt"],
      [JSON.stringify({ type: "x", occurredAt: [] }), "array occurredAt"],
      [JSON.stringify({ type: "x", occurredAt: "2024-01-01T00:00:00Z" }), "missing milliseconds"],
      [JSON.stringify({ type: "x", occurredAt: "2024-01-01T00:00:00.000+00:00" }), "offset instead of Z"],
      [JSON.stringify({ type: "x", occurredAt: "2024-01-01 00:00:00.000Z" }), "space separator"],
      [JSON.stringify({ type: "x", occurredAt: "not-a-date" }), "not a date"],
      [JSON.stringify({ type: "x", occurredAt: "2024-02-30T00:00:00.000Z" }), "nonexistent day"],
      [JSON.stringify({ type: "x", occurredAt: "2023-02-29T00:00:00.000Z" }), "non-leap-year Feb 29"],
      [JSON.stringify({ type: "x", occurredAt: "2024-13-01T00:00:00.000Z" }), "month 13"],
      [JSON.stringify({ type: "x", occurredAt: "2024-01-01T24:00:00.000Z" }), "hour 24"]
    ];

    for (const [body, label] of cases) {
      const result = await requestJson(baseUrl, `/scenarios/${id}/events`, {
        method: "POST",
        body
      });
      assert.equal(result.status, 400, label);
      assert.equal(result.body.error, "bad_request", label);
    }

    const scenario = store.scenarios.get(id);
    assert.equal(scenario.revision, 0);
    assert.deepEqual(scenario.events, []);

    const fetched = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.equal(fetched.body.revision, 0);
    assert.deepEqual(fetched.body.events, []);
  }, createApp(store));
});

test("omitting occurredAt keeps the server-generated timestamp behavior", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Server time" })
    });
    const id = created.body.id;

    const before = Date.now();
    const result = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "now" })
    });
    const after = Date.now();

    assert.equal(result.status, 201);
    assert.equal(result.body.sequence, 1);
    const occurredAt = Date.parse(result.body.occurredAt);
    assert.ok(!Number.isNaN(occurredAt));
    assert.ok(occurredAt >= before && occurredAt <= after);
  });
});

test("explicit occurredAt monotonicity is enforced per scenario", async () => {
  await withServer(async baseUrl => {
    const a = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "A" })
    });
    const b = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "B" })
    });

    const pinned = await requestJson(baseUrl, `/scenarios/${a.body.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "late", occurredAt: "2025-01-01T00:00:00.000Z" })
    });
    assert.equal(pinned.status, 201);

    // Scenario B is unaffected by A's timeline position.
    const earlier = await requestJson(baseUrl, `/scenarios/${b.body.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "early", occurredAt: "2020-01-01T00:00:00.000Z" })
    });
    assert.equal(earlier.status, 201);
    assert.equal(earlier.body.occurredAt, "2020-01-01T00:00:00.000Z");

    // A still rejects a regression against its own last event.
    const regressing = await requestJson(baseUrl, `/scenarios/${a.body.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "backwards", occurredAt: "2024-12-31T23:59:59.999Z" })
    });
    assert.equal(regressing.status, 400);

    const fetchedA = await requestJson(baseUrl, `/scenarios/${a.body.id}`);
    const fetchedB = await requestJson(baseUrl, `/scenarios/${b.body.id}`);
    assert.equal(fetchedA.body.revision, 1);
    assert.equal(fetchedA.body.events.length, 1);
    assert.equal(fetchedB.body.revision, 1);
    assert.equal(fetchedB.body.events.length, 1);
  });
});
