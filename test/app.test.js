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

async function branchAt(baseUrl, parentId, body) {
  return requestJson(baseUrl, `/scenarios/${parentId}/branches`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

test("POST /scenarios/:id/branches copies an independent history prefix", async () => {
  await withServer(async baseUrl => {
    const { id: parentId, events } = await createScenarioWithEvents(baseUrl, 4, "Parent");

    const created = await branchAt(baseUrl, parentId, {
      name: "Fork",
      description: "mid-history",
      fromRevision: 2
    });
    assert.equal(created.status, 201);
    const branch = created.body;

    assert.equal(typeof branch.id, "string");
    assert.ok(branch.id.length > 0);
    assert.notEqual(branch.id, parentId);
    assert.equal(branch.name, "Fork");
    assert.equal(branch.description, "mid-history");
    assert.ok(!Number.isNaN(Date.parse(branch.createdAt)));
    assert.equal(branch.revision, 2);
    assert.equal(branch.parentScenarioId, parentId);
    assert.equal(branch.parentRevision, 2);

    assert.deepEqual(branch.events, events.slice(0, 2));
    assert.deepEqual(branch.events.map(event => event.sequence), [1, 2]);
    for (const event of branch.events) {
      assert.deepEqual(Object.keys(event).sort(), ["id", "occurredAt", "payload", "sequence", "type"]);
    }

    // The branch is readable through the existing scenario and event-list endpoints.
    const fetched = await requestJson(baseUrl, `/scenarios/${branch.id}`);
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.body, branch);

    const listed = await requestJson(baseUrl, `/scenarios/${branch.id}/events`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.revision, 2);
    assert.deepEqual(listed.body.events, events.slice(0, 2));
    assert.equal(listed.body.nextCursor, null);
  });
});

test("a branch with fromRevision 0 starts from an empty history", async () => {
  await withServer(async baseUrl => {
    const { id: parentId } = await createScenarioWithEvents(baseUrl, 3, "Parent");

    const created = await branchAt(baseUrl, parentId, { name: "Empty fork", fromRevision: 0 });
    assert.equal(created.status, 201);
    assert.equal(created.body.revision, 0);
    assert.equal(created.body.parentRevision, 0);
    assert.deepEqual(created.body.events, []);

    // Appending to the empty branch starts sequences at 1.
    const appended = await requestJson(baseUrl, `/scenarios/${created.body.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "branch-only" })
    });
    assert.equal(appended.status, 201);
    assert.equal(appended.body.sequence, 1);

    const fetched = await requestJson(baseUrl, `/scenarios/${created.body.id}`);
    assert.equal(fetched.body.revision, 1);
    assert.equal(fetched.body.events.length, 1);

    // The parent is untouched.
    const parent = await requestJson(baseUrl, `/scenarios/${parentId}`);
    assert.equal(parent.body.revision, 3);
    assert.equal(parent.body.events.length, 3);
  });
});

test("a branch at the parent's current revision copies every event", async () => {
  await withServer(async baseUrl => {
    const { id: parentId, events } = await createScenarioWithEvents(baseUrl, 3, "Parent");

    const created = await branchAt(baseUrl, parentId, { name: "Full fork", fromRevision: 3 });
    assert.equal(created.status, 201);
    assert.equal(created.body.revision, 3);
    assert.deepEqual(created.body.events, events);
  });
});

test("appends continue the branch sequence and stay isolated from the parent and other branches", async () => {
  await withServer(async baseUrl => {
    const { id: parentId, events } = await createScenarioWithEvents(baseUrl, 4, "Parent");

    const first = await branchAt(baseUrl, parentId, { name: "One", fromRevision: 2 });
    const second = await branchAt(baseUrl, parentId, { name: "Two", fromRevision: 2 });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);

    const branchEvent = await requestJson(baseUrl, `/scenarios/${first.body.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "branch-event", payload: { where: "one" } })
    });
    assert.equal(branchEvent.status, 201);
    assert.equal(branchEvent.body.sequence, 3);

    let fetchedFirst = await requestJson(baseUrl, `/scenarios/${first.body.id}`);
    assert.equal(fetchedFirst.body.revision, 3);
    assert.equal(fetchedFirst.body.events.length, 3);
    assert.deepEqual(fetchedFirst.body.events.slice(0, 2), events.slice(0, 2));
    assert.deepEqual(fetchedFirst.body.events[2], branchEvent.body);

    // The sibling branch and the parent are unaffected by the first branch's write.
    let fetchedSecond = await requestJson(baseUrl, `/scenarios/${second.body.id}`);
    assert.equal(fetchedSecond.body.revision, 2);
    assert.equal(fetchedSecond.body.events.length, 2);

    let fetchedParent = await requestJson(baseUrl, `/scenarios/${parentId}`);
    assert.equal(fetchedParent.body.revision, 4);
    assert.equal(fetchedParent.body.events.length, 4);

    // A later parent write must not retroactively change either branch.
    const parentEvent = await requestJson(baseUrl, `/scenarios/${parentId}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "parent-event" })
    });
    assert.equal(parentEvent.status, 201);
    assert.equal(parentEvent.body.sequence, 5);

    fetchedFirst = await requestJson(baseUrl, `/scenarios/${first.body.id}`);
    fetchedSecond = await requestJson(baseUrl, `/scenarios/${second.body.id}`);
    fetchedParent = await requestJson(baseUrl, `/scenarios/${parentId}`);
    assert.equal(fetchedFirst.body.revision, 3);
    assert.equal(fetchedFirst.body.events.length, 3);
    assert.equal(fetchedFirst.body.parentRevision, 2);
    assert.equal(fetchedSecond.body.revision, 2);
    assert.deepEqual(fetchedSecond.body.events, events.slice(0, 2));
    assert.equal(fetchedParent.body.revision, 5);
    assert.equal(fetchedParent.body.events.length, 5);
  });
});

test("branch history is a deep copy detached from later in-place parent changes", async () => {
  const store = createScenarioStore();
  await withServer(async baseUrl => {
    const { id: parentId } = await createScenarioWithEvents(baseUrl, 3);
    const created = await branchAt(baseUrl, parentId, { name: "Detached", fromRevision: 2 });
    assert.equal(created.status, 201);

    const parent = store.scenarios.get(parentId);
    parent.events[0].payload.index = 999;
    parent.name = "Mutated parent";

    const fetched = await requestJson(baseUrl, `/scenarios/${created.body.id}`);
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.body.events[0].payload, { index: 0 });
    assert.equal(fetched.body.name, "Detached");
    assert.deepEqual(
      fetched.body.events.map(event => event.sequence),
      [1, 2]
    );
  }, createApp(store));
});

test("branching does not invalidate the parent's pagination cursors", async () => {
  await withServer(async baseUrl => {
    const { id: parentId } = await createScenarioWithEvents(baseUrl, 4);

    const page = await requestJson(baseUrl, `/scenarios/${parentId}/events?limit=2`);
    assert.equal(page.status, 200);
    assert.equal(typeof page.body.nextCursor, "string");

    const branched = await branchAt(baseUrl, parentId, { name: "Fork", fromRevision: 2 });
    assert.equal(branched.status, 201);

    const next = await requestJson(
      baseUrl,
      `/scenarios/${parentId}/events?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`
    );
    assert.equal(next.status, 200);
    assert.deepEqual(next.body.events.map(event => event.sequence), [3, 4]);
    assert.equal(next.body.nextCursor, null);

    // Branch pagination works the same way over the copied prefix.
    const branchPage = await requestJson(
      baseUrl,
      `/scenarios/${branched.body.id}/events?limit=1`
    );
    assert.equal(branchPage.status, 200);
    assert.equal(branchPage.body.revision, 2);
    assert.deepEqual(branchPage.body.events.map(event => event.sequence), [1]);
    const branchNext = await requestJson(
      baseUrl,
      `/scenarios/${branched.body.id}/events?limit=1&cursor=${encodeURIComponent(branchPage.body.nextCursor)}`
    );
    assert.equal(branchNext.status, 200);
    assert.deepEqual(branchNext.body.events.map(event => event.sequence), [2]);
    assert.equal(branchNext.body.nextCursor, null);
  });
});

test("explicit occurredAt on branch appends is validated against the prefix", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Pinned parent" })
    });
    const parentId = created.body.id;
    for (const occurredAt of ["2024-07-01T00:00:00.000Z", "2024-07-02T00:00:00.000Z"]) {
      const result = await requestJson(baseUrl, `/scenarios/${parentId}/events`, {
        method: "POST",
        body: JSON.stringify({ type: "pinned", occurredAt })
      });
      assert.equal(result.status, 201);
    }

    const branch = await branchAt(baseUrl, parentId, { name: "Pinned fork", fromRevision: 2 });
    assert.equal(branch.status, 201);

    const tooEarly = await requestJson(baseUrl, `/scenarios/${branch.body.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "late", occurredAt: "2024-07-01T23:59:59.999Z" })
    });
    assert.equal(tooEarly.status, 400);
    assert.equal(tooEarly.body.error, "bad_request");

    const equal = await requestJson(baseUrl, `/scenarios/${branch.body.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "same", occurredAt: "2024-07-02T00:00:00.000Z" })
    });
    assert.equal(equal.status, 201);
    assert.equal(equal.body.sequence, 3);

    const later = await requestJson(baseUrl, `/scenarios/${branch.body.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "after", occurredAt: "2024-07-03T00:00:00.000Z" })
    });
    assert.equal(later.status, 201);
    assert.equal(later.body.sequence, 4);

    const fetched = await requestJson(baseUrl, `/scenarios/${branch.body.id}`);
    assert.equal(fetched.body.revision, 4);
  });
});

test("a branch can itself be branched", async () => {
  await withServer(async baseUrl => {
    const { id: parentId, events } = await createScenarioWithEvents(baseUrl, 4, "Root");

    const first = await branchAt(baseUrl, parentId, { name: "First fork", fromRevision: 3 });
    assert.equal(first.status, 201);

    const second = await branchAt(baseUrl, first.body.id, { name: "Second fork", fromRevision: 1 });
    assert.equal(second.status, 201);
    assert.equal(second.body.parentScenarioId, first.body.id);
    assert.equal(second.body.parentRevision, 1);
    assert.equal(second.body.revision, 1);
    assert.deepEqual(second.body.events, [events[0]]);
  });
});

test("branching from an unknown scenario returns 404", async () => {
  await withServer(async baseUrl => {
    const valid = await requestJson(baseUrl, "/scenarios/missing/branches", {
      method: "POST",
      body: JSON.stringify({ name: "Nope", fromRevision: 0 })
    });
    assert.equal(valid.status, 404);
    assert.equal(valid.body.error, "not_found");

    // The 404 takes precedence over an otherwise invalid body.
    const invalid = await requestJson(baseUrl, "/scenarios/missing/branches", {
      method: "POST",
      body: JSON.stringify({ name: "", fromRevision: -1 })
    });
    assert.equal(invalid.status, 404);
    assert.equal(invalid.body.error, "not_found");
  });
});

test("invalid branch requests return 400 and create nothing", async () => {
  await withServer(async baseUrl => {
    const { id: parentId } = await createScenarioWithEvents(baseUrl, 2, "Parent");

    const cases = [
      ["", undefined, "empty body"],
      [JSON.stringify({ name: "x", fromRevision: 0 }), "text/plain", "wrong media type"],
      ["{", "application/json", "malformed JSON"],
      ["[]", "application/json", "JSON array body"],
      [JSON.stringify({ fromRevision: 1 }), "application/json", "missing name"],
      [JSON.stringify({ name: "", fromRevision: 1 }), "application/json", "empty name"],
      [JSON.stringify({ name: 4, fromRevision: 1 }), "application/json", "non-string name"],
      [JSON.stringify({ name: "x", description: 1, fromRevision: 1 }), "application/json", "non-string description"],
      [JSON.stringify({ name: "x" }), "application/json", "missing fromRevision"],
      [JSON.stringify({ name: "x", fromRevision: null }), "application/json", "null fromRevision"],
      [JSON.stringify({ name: "x", fromRevision: "1" }), "application/json", "string fromRevision"],
      [JSON.stringify({ name: "x", fromRevision: true }), "application/json", "boolean fromRevision"],
      [JSON.stringify({ name: "x", fromRevision: 1.5 }), "application/json", "non-integer fromRevision"],
      [JSON.stringify({ name: "x", fromRevision: -1 }), "application/json", "negative fromRevision"],
      [JSON.stringify({ name: "x", fromRevision: 3 }), "application/json", "fromRevision past current revision"]
    ];

    for (const [body, contentType, label] of cases) {
      const result = await requestJson(baseUrl, `/scenarios/${parentId}/branches`, {
        method: "POST",
        contentType,
        body
      });
      assert.equal(result.status, 400, label);
      assert.equal(result.body.error, "bad_request", label);
      assert.equal(typeof result.body.message, "string", label);

      // Nothing was created and the parent was not modified.
      const list = await requestJson(baseUrl, "/scenarios");
      assert.equal(list.body.length, 1, label);
    }

    const parent = await requestJson(baseUrl, `/scenarios/${parentId}`);
    assert.equal(parent.body.revision, 2);
    assert.equal(parent.body.events.length, 2);
    assert.equal(parent.body.parentScenarioId, undefined);
  });
});

test("a failed branch leaves parent cursors and history usable", async () => {
  await withServer(async baseUrl => {
    const { id: parentId } = await createScenarioWithEvents(baseUrl, 3);

    const page = await requestJson(baseUrl, `/scenarios/${parentId}/events?limit=1`);
    assert.equal(typeof page.body.nextCursor, "string");

    const failed = await branchAt(baseUrl, parentId, { name: "Bad", fromRevision: 99 });
    assert.equal(failed.status, 400);

    const followed = await requestJson(
      baseUrl,
      `/scenarios/${parentId}/events?limit=1&cursor=${encodeURIComponent(page.body.nextCursor)}`
    );
    assert.equal(followed.status, 200);
    assert.deepEqual(followed.body.events.map(event => event.sequence), [2]);
  });
});

async function setClock(baseUrl, id, body, options = {}) {
  return requestJson(baseUrl, `/scenarios/${id}/clock`, {
    method: "POST",
    contentType: options.contentType,
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

test("GET clock returns null currentTime before the clock is ever set", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Clockless" })
    });
    const id = created.body.id;

    const result = await requestJson(baseUrl, `/scenarios/${id}/clock`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { scenarioId: id, currentTime: null });
  });
});

test("clock endpoints return the existing 404 JSON for an unknown scenario", async () => {
  await withServer(async baseUrl => {
    const got = await requestJson(baseUrl, "/scenarios/missing/clock");
    assert.equal(got.status, 404);
    assert.deepEqual(got.body, { error: "not_found", message: "Scenario not found" });

    const posted = await setClock(baseUrl, "missing", { currentTime: "2024-01-01T00:00:00.000Z" });
    assert.equal(posted.status, 404);
    assert.deepEqual(posted.body, { error: "not_found", message: "Scenario not found" });

    // The 404 takes precedence over an otherwise invalid body.
    const invalid = await setClock(baseUrl, "missing", "{");
    assert.equal(invalid.status, 404);
    assert.equal(invalid.body.error, "not_found");
  });
});

test("the clock can be set, read back, and advanced; equal times are allowed", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Clocked" })
    });
    const id = created.body.id;

    const first = await setClock(baseUrl, id, { currentTime: "2024-01-01T00:00:00.000Z" });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { scenarioId: id, currentTime: "2024-01-01T00:00:00.000Z" });

    const read = await requestJson(baseUrl, `/scenarios/${id}/clock`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, { scenarioId: id, currentTime: "2024-01-01T00:00:00.000Z" });

    const equal = await setClock(baseUrl, id, { currentTime: "2024-01-01T00:00:00.000Z" });
    assert.equal(equal.status, 200);
    assert.deepEqual(equal.body, { scenarioId: id, currentTime: "2024-01-01T00:00:00.000Z" });

    const advanced = await setClock(baseUrl, id, { currentTime: "2024-06-15T12:30:00.500Z" });
    assert.equal(advanced.status, 200);
    assert.deepEqual(advanced.body, { scenarioId: id, currentTime: "2024-06-15T12:30:00.500Z" });

    const reread = await requestJson(baseUrl, `/scenarios/${id}/clock`);
    assert.deepEqual(reread.body, { scenarioId: id, currentTime: "2024-06-15T12:30:00.500Z" });
  });
});

test("a clock earlier than the current clock returns 400 without side effects", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Monotonic clock" })
    });
    const id = created.body.id;

    const set = await setClock(baseUrl, id, { currentTime: "2024-06-15T12:00:00.000Z" });
    assert.equal(set.status, 200);

    for (const currentTime of ["2024-06-15T11:59:59.999Z", "2020-01-01T00:00:00.000Z"]) {
      const result = await setClock(baseUrl, id, { currentTime });
      assert.equal(result.status, 400, currentTime);
      assert.equal(result.body.error, "bad_request");
    }

    const read = await requestJson(baseUrl, `/scenarios/${id}/clock`);
    assert.deepEqual(read.body, { scenarioId: id, currentTime: "2024-06-15T12:00:00.000Z" });
  });
});

test("a clock earlier than the last event occurredAt returns 400 without side effects", async () => {
  const store = createScenarioStore();
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Pinned events" })
    });
    const id = created.body.id;

    for (const occurredAt of ["2024-06-01T00:00:00.000Z", "2024-06-03T00:00:00.000Z"]) {
      const result = await requestJson(baseUrl, `/scenarios/${id}/events`, {
        method: "POST",
        body: JSON.stringify({ type: "pinned", occurredAt })
      });
      assert.equal(result.status, 201);
    }

    const tooEarly = await setClock(baseUrl, id, { currentTime: "2024-06-02T23:59:59.999Z" });
    assert.equal(tooEarly.status, 400);
    assert.equal(tooEarly.body.error, "bad_request");

    // Equal to the last event is allowed.
    const equal = await setClock(baseUrl, id, { currentTime: "2024-06-03T00:00:00.000Z" });
    assert.equal(equal.status, 200);

    const scenario = store.scenarios.get(id);
    assert.equal(scenario.revision, 2);
    assert.equal(scenario.events.length, 2);
    assert.equal(store.clocks.get(id), "2024-06-03T00:00:00.000Z");
  }, createApp(store));
});

test("invalid clock requests return 400 and never set the clock", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Guarded clock" })
    });
    const id = created.body.id;

    const cases = [
      ["", undefined, "empty body"],
      [JSON.stringify({ currentTime: "2024-01-01T00:00:00.000Z" }), "text/plain", "wrong media type"],
      ["{", "application/json", "malformed JSON"],
      ["[]", "application/json", "JSON array body"],
      [JSON.stringify({}), "application/json", "missing currentTime"],
      [JSON.stringify({ currentTime: 1717171717 }), "application/json", "numeric currentTime"],
      [JSON.stringify({ currentTime: null }), "application/json", "null currentTime"],
      [JSON.stringify({ currentTime: true }), "application/json", "boolean currentTime"],
      [JSON.stringify({ currentTime: {} }), "application/json", "object currentTime"],
      [JSON.stringify({ currentTime: "" }), "application/json", "empty currentTime"],
      [JSON.stringify({ currentTime: "2024-01-01T00:00:00Z" }), "application/json", "missing milliseconds"],
      [JSON.stringify({ currentTime: "2024-01-01T00:00:00.000+00:00" }), "application/json", "offset instead of Z"],
      [JSON.stringify({ currentTime: "2024-01-01 00:00:00.000Z" }), "application/json", "space separator"],
      [JSON.stringify({ currentTime: "not-a-date" }), "application/json", "not a date"],
      [JSON.stringify({ currentTime: "2024-02-30T00:00:00.000Z" }), "application/json", "nonexistent day"],
      [JSON.stringify({ currentTime: "2023-02-29T00:00:00.000Z" }), "application/json", "non-leap-year Feb 29"],
      [JSON.stringify({ currentTime: "2024-13-01T00:00:00.000Z" }), "application/json", "month 13"],
      [JSON.stringify({ currentTime: "2024-01-01T24:00:00.000Z" }), "application/json", "hour 24"]
    ];

    for (const [body, contentType, label] of cases) {
      const result = await setClock(baseUrl, id, body, { contentType });
      assert.equal(result.status, 400, label);
      assert.equal(result.body.error, "bad_request", label);
      assert.equal(typeof result.body.message, "string", label);
    }

    const read = await requestJson(baseUrl, `/scenarios/${id}/clock`);
    assert.deepEqual(read.body, { scenarioId: id, currentTime: null });
  });
});

test("clock reads and writes do not change revision, events, sequences, or cursors", async () => {
  const store = createScenarioStore();
  await withServer(async baseUrl => {
    const { id, events } = await createScenarioWithEvents(baseUrl, 4);

    const page = await requestJson(baseUrl, `/scenarios/${id}/events?limit=2`);
    assert.equal(page.status, 200);
    assert.equal(typeof page.body.nextCursor, "string");

    const before = await requestJson(baseUrl, `/scenarios/${id}`);

    const unset = await requestJson(baseUrl, `/scenarios/${id}/clock`);
    assert.equal(unset.status, 200);
    const set = await setClock(baseUrl, id, { currentTime: "2030-01-01T00:00:00.000Z" });
    assert.equal(set.status, 200);
    const read = await requestJson(baseUrl, `/scenarios/${id}/clock`);
    assert.equal(read.status, 200);
    const advanced = await setClock(baseUrl, id, { currentTime: "2031-01-01T00:00:00.000Z" });
    assert.equal(advanced.status, 200);

    const after = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.deepEqual(after.body, before.body);
    assert.equal(after.body.revision, 4);
    assert.deepEqual(after.body.events, events);

    const scenario = store.scenarios.get(id);
    assert.equal(scenario.revision, 4);
    assert.equal(scenario.events.length, 4);
    assert.deepEqual(scenario.events.map(event => event.sequence), [1, 2, 3, 4]);

    // The cursor issued before any clock operation is still valid.
    const followed = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`
    );
    assert.equal(followed.status, 200);
    assert.deepEqual(followed.body.events.map(event => event.sequence), [3, 4]);
    assert.equal(followed.body.nextCursor, null);
  }, createApp(store));
});

test("events appended without occurredAt use the scenario clock when set", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Clocked events" })
    });
    const id = created.body.id;

    // Without a clock the server still generates the timestamp.
    const before = Date.now();
    const serverTimed = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "server-time" })
    });
    const after = Date.now();
    assert.equal(serverTimed.status, 201);
    const generated = Date.parse(serverTimed.body.occurredAt);
    assert.ok(generated >= before && generated <= after);

    const set = await setClock(baseUrl, id, { currentTime: "2030-05-01T08:00:00.000Z" });
    assert.equal(set.status, 200);

    const clocked = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "clock-time" })
    });
    assert.equal(clocked.status, 201);
    assert.equal(clocked.body.occurredAt, "2030-05-01T08:00:00.000Z");
    assert.equal(clocked.body.sequence, 2);

    // The clock does not advance by itself.
    const again = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "clock-time-again" })
    });
    assert.equal(again.status, 201);
    assert.equal(again.body.occurredAt, "2030-05-01T08:00:00.000Z");

    // An explicit occurredAt keeps the existing validation and is stored as given.
    const explicit = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "explicit", occurredAt: "2030-05-01T09:00:00.000Z" })
    });
    assert.equal(explicit.status, 201);
    assert.equal(explicit.body.occurredAt, "2030-05-01T09:00:00.000Z");

    const regressing = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "explicit", occurredAt: "2030-05-01T08:59:59.999Z" })
    });
    assert.equal(regressing.status, 400);

    const fetched = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.equal(fetched.body.revision, 4);
    assert.deepEqual(
      fetched.body.events.map(event => event.occurredAt),
      [
        serverTimed.body.occurredAt,
        "2030-05-01T08:00:00.000Z",
        "2030-05-01T08:00:00.000Z",
        "2030-05-01T09:00:00.000Z"
      ]
    );
  });
});

test("branches start with a null clock and stay isolated from parent and siblings", async () => {
  await withServer(async baseUrl => {
    const { id: parentId } = await createScenarioWithEvents(baseUrl, 2, "Parent");

    const parentClock = await setClock(baseUrl, parentId, { currentTime: "2030-01-01T00:00:00.000Z" });
    assert.equal(parentClock.status, 200);

    const first = await branchAt(baseUrl, parentId, { name: "One", fromRevision: 2 });
    const second = await branchAt(baseUrl, parentId, { name: "Two", fromRevision: 2 });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);

    // Branches do not inherit the parent's clock.
    for (const branch of [first.body, second.body]) {
      const read = await requestJson(baseUrl, `/scenarios/${branch.id}/clock`);
      assert.deepEqual(read.body, { scenarioId: branch.id, currentTime: null });
    }

    // A branch without a clock still uses server-generated event times.
    const branchEvent = await requestJson(baseUrl, `/scenarios/${first.body.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "branch-event" })
    });
    assert.equal(branchEvent.status, 201);
    assert.notEqual(branchEvent.body.occurredAt, "2030-01-01T00:00:00.000Z");
    assert.ok(Date.parse(branchEvent.body.occurredAt) >= Date.parse("2025-01-01T00:00:00.000Z"));

    // Setting one branch's clock affects neither the parent nor the sibling.
    const setFirst = await setClock(baseUrl, first.body.id, { currentTime: "2031-06-01T00:00:00.000Z" });
    assert.equal(setFirst.status, 200);

    const parentRead = await requestJson(baseUrl, `/scenarios/${parentId}/clock`);
    assert.deepEqual(parentRead.body, { scenarioId: parentId, currentTime: "2030-01-01T00:00:00.000Z" });
    const secondRead = await requestJson(baseUrl, `/scenarios/${second.body.id}/clock`);
    assert.deepEqual(secondRead.body, { scenarioId: second.body.id, currentTime: null });

    // Advancing the parent's clock does not move the branch's clock.
    const parentAdvanced = await setClock(baseUrl, parentId, { currentTime: "2032-01-01T00:00:00.000Z" });
    assert.equal(parentAdvanced.status, 200);
    const firstRead = await requestJson(baseUrl, `/scenarios/${first.body.id}/clock`);
    assert.deepEqual(firstRead.body, { scenarioId: first.body.id, currentTime: "2031-06-01T00:00:00.000Z" });

    // Each branch's clock bounds only its own timeline.
    const tooEarly = await setClock(baseUrl, second.body.id, { currentTime: "2020-01-01T00:00:00.000Z" });
    assert.equal(tooEarly.status, 400);
    const secondOk = await setClock(baseUrl, second.body.id, { currentTime: "2030-06-01T00:00:00.000Z" });
    assert.equal(secondOk.status, 200);
  });
});

async function postRule(baseUrl, id, body, options = {}) {
  return requestJson(baseUrl, `/scenarios/${id}/rules`, {
    method: "POST",
    contentType: options.contentType,
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

test("POST /scenarios/:id/rules creates a rule with a unique id and persists it", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Rules" })
    });
    const id = created.body.id;

    const first = await postRule(baseUrl, id, {
      name: "First rule",
      when: { type: "start" },
      then: { type: "started", payload: { ok: true } }
    });
    assert.equal(first.status, 201);
    const rule = first.body;
    assert.equal(typeof rule.id, "string");
    assert.ok(rule.id.length > 0);
    assert.equal(rule.name, "First rule");
    assert.deepEqual(rule.when, { type: "start" });
    assert.deepEqual(rule.then, { type: "started", payload: { ok: true } });

    const second = await postRule(baseUrl, id, {
      name: "Rule without payload",
      when: { type: "other" },
      then: { type: "derived" }
    });
    assert.equal(second.status, 201);
    assert.notEqual(second.body.id, rule.id);
    assert.deepEqual(second.body.then, { type: "derived" });

    const listed = await requestJson(baseUrl, `/scenarios/${id}/rules`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, [rule, second.body]);
  });
});

test("GET rules returns an empty list for a scenario without rules and 404 for an unknown scenario", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "No rules" })
    });

    const empty = await requestJson(baseUrl, `/scenarios/${created.body.id}/rules`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, []);

    const missing = await requestJson(baseUrl, "/scenarios/missing/rules");
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: "not_found", message: "Scenario not found" });
  });
});

test("POST rules on an unknown scenario returns 404, taking precedence over body validation", async () => {
  await withServer(async baseUrl => {
    const valid = await postRule(baseUrl, "missing", {
      name: "x",
      when: { type: "a" },
      then: { type: "b" }
    });
    assert.equal(valid.status, 404);
    assert.equal(valid.body.error, "not_found");

    const invalid = await postRule(baseUrl, "missing", { name: "", when: {}, then: {} });
    assert.equal(invalid.status, 404);
    assert.equal(invalid.body.error, "not_found");

    const malformed = await postRule(baseUrl, "missing", "{");
    assert.equal(malformed.status, 404);
  });
});

test("invalid rule requests return 400 and write nothing", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Guarded rules" })
    });
    const id = created.body.id;

    const cases = [
      ["", undefined, "empty body"],
      [JSON.stringify({ name: "x", when: { type: "a" }, then: { type: "b" } }), "text/plain", "wrong media type"],
      ["{", "application/json", "malformed JSON"],
      ["[]", "application/json", "JSON array body"],
      [JSON.stringify({ when: { type: "a" }, then: { type: "b" } }), "application/json", "missing name"],
      [JSON.stringify({ name: "", when: { type: "a" }, then: { type: "b" } }), "application/json", "empty name"],
      [JSON.stringify({ name: 4, when: { type: "a" }, then: { type: "b" } }), "application/json", "non-string name"],
      [JSON.stringify({ name: "x", then: { type: "b" } }), "application/json", "missing when"],
      [JSON.stringify({ name: "x", when: null, then: { type: "b" } }), "application/json", "null when"],
      [JSON.stringify({ name: "x", when: [], then: { type: "b" } }), "application/json", "array when"],
      [JSON.stringify({ name: "x", when: "start", then: { type: "b" } }), "application/json", "string when"],
      [JSON.stringify({ name: "x", when: {}, then: { type: "b" } }), "application/json", "when missing type"],
      [JSON.stringify({ name: "x", when: { type: "" }, then: { type: "b" } }), "application/json", "empty when.type"],
      [JSON.stringify({ name: "x", when: { type: 5 }, then: { type: "b" } }), "application/json", "non-string when.type"],
      [JSON.stringify({ name: "x", when: { type: "a", extra: 1 }, then: { type: "b" } }), "application/json", "extra when field"],
      [JSON.stringify({ name: "x", when: { type: "a" } }), "application/json", "missing then"],
      [JSON.stringify({ name: "x", when: { type: "a" }, then: null }), "application/json", "null then"],
      [JSON.stringify({ name: "x", when: { type: "a" }, then: [] }), "application/json", "array then"],
      [JSON.stringify({ name: "x", when: { type: "a" }, then: "out" }), "application/json", "string then"],
      [JSON.stringify({ name: "x", when: { type: "a" }, then: {} }), "application/json", "then missing type"],
      [JSON.stringify({ name: "x", when: { type: "a" }, then: { type: "" } }), "application/json", "empty then.type"],
      [JSON.stringify({ name: "x", when: { type: "a" }, then: { type: 3 } }), "application/json", "non-string then.type"],
      [JSON.stringify({ name: "x", when: { type: "a" }, then: { type: "b", payload: [] } }), "application/json", "array payload"],
      [JSON.stringify({ name: "x", when: { type: "a" }, then: { type: "b", payload: "no" } }), "application/json", "string payload"],
      [JSON.stringify({ name: "x", when: { type: "a" }, then: { type: "b", payload: null } }), "application/json", "null payload"],
      [JSON.stringify({ name: "x", when: { type: "a" }, then: { type: "b", extra: 1 } }), "application/json", "extra then field"],
      [JSON.stringify({ name: "x", when: { type: "a" }, then: { type: "b" }, bogus: 1 }), "application/json", "extra top-level field"]
    ];

    for (const [body, contentType, label] of cases) {
      const result = await postRule(baseUrl, id, body, { contentType });
      assert.equal(result.status, 400, label);
      assert.equal(result.body.error, "bad_request", label);
      assert.equal(typeof result.body.message, "string", label);
    }

    const listed = await requestJson(baseUrl, `/scenarios/${id}/rules`);
    assert.deepEqual(listed.body, []);

    const fetched = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.equal(fetched.body.revision, 0);
  });
});

test("rule creation and listing do not change revision, events, clock, or cursors", async () => {
  const store = createScenarioStore();
  await withServer(async baseUrl => {
    const { id, events } = await createScenarioWithEvents(baseUrl, 3);

    const page = await requestJson(baseUrl, `/scenarios/${id}/events?limit=2`);
    assert.equal(typeof page.body.nextCursor, "string");

    const before = await requestJson(baseUrl, `/scenarios/${id}`);
    const clockBefore = await requestJson(baseUrl, `/scenarios/${id}/clock`);

    const rule = await postRule(baseUrl, id, {
      name: "R",
      when: { type: "event-1" },
      then: { type: "out", payload: { x: 1 } }
    });
    assert.equal(rule.status, 201);

    const listed = await requestJson(baseUrl, `/scenarios/${id}/rules`);
    assert.equal(listed.body.length, 1);

    const after = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.deepEqual(after.body, before.body);
    assert.equal(after.body.revision, 3);
    assert.deepEqual(after.body.events, events);

    const clockAfter = await requestJson(baseUrl, `/scenarios/${id}/clock`);
    assert.deepEqual(clockAfter.body, clockBefore.body);

    const followed = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`
    );
    assert.equal(followed.status, 200);
    assert.deepEqual(followed.body.events.map(event => event.sequence), [3]);

    const scenario = store.scenarios.get(id);
    assert.equal(scenario.revision, 3);
    assert.equal(scenario.events.length, 3);
  }, createApp(store));
});

test("GET replay derives results in sequence and rule creation order from current events", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Replay" })
    });
    const id = created.body.id;

    const stamps = [
      "2024-04-01T00:00:00.000Z",
      "2024-04-02T00:00:00.000Z",
      "2024-04-03T00:00:00.000Z"
    ];
    const appended = [];
    for (const [index, type] of ["alpha", "beta", "alpha"].entries()) {
      const result = await requestJson(baseUrl, `/scenarios/${id}/events`, {
        method: "POST",
        body: JSON.stringify({ type, occurredAt: stamps[index] })
      });
      assert.equal(result.status, 201);
      appended.push(result.body);
    }

    const r1 = await postRule(baseUrl, id, { name: "R1", when: { type: "alpha" }, then: { type: "one", payload: { n: 1 } } });
    const r2 = await postRule(baseUrl, id, { name: "R2", when: { type: "alpha" }, then: { type: "two" } });
    const r3 = await postRule(baseUrl, id, { name: "R3", when: { type: "beta" }, then: { type: "three", payload: { n: 3 } } });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.equal(r3.status, 201);

    const replay = await requestJson(baseUrl, `/scenarios/${id}/replay`);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.revision, 3);
    assert.deepEqual(replay.body.results, [
      {
        ruleId: r1.body.id,
        sourceSequence: 1,
        type: "one",
        payload: { n: 1 },
        occurredAt: appended[0].occurredAt
      },
      {
        ruleId: r2.body.id,
        sourceSequence: 1,
        type: "two",
        payload: {},
        occurredAt: appended[0].occurredAt
      },
      {
        ruleId: r3.body.id,
        sourceSequence: 2,
        type: "three",
        payload: { n: 3 },
        occurredAt: appended[1].occurredAt
      },
      {
        ruleId: r1.body.id,
        sourceSequence: 3,
        type: "one",
        payload: { n: 1 },
        occurredAt: appended[2].occurredAt
      },
      {
        ruleId: r2.body.id,
        sourceSequence: 3,
        type: "two",
        payload: {},
        occurredAt: appended[2].occurredAt
      }
    ]);

    // Repeating the read-only replay yields identical output.
    const again = await requestJson(baseUrl, `/scenarios/${id}/replay`);
    assert.deepEqual(again.body, replay.body);
  });
});

test("replay on a scenario without events or rules returns an empty result set", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Quiet" })
    });

    const replay = await requestJson(baseUrl, `/scenarios/${created.body.id}/replay`);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, { revision: 0, results: [] });
  });
});

test("replay returns 404 for an unknown scenario", async () => {
  await withServer(async baseUrl => {
    const result = await requestJson(baseUrl, "/scenarios/missing/replay");
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: "not_found", message: "Scenario not found" });
  });
});

test("replay is read-only for revision, events, clock, and cursors", async () => {
  const store = createScenarioStore();
  await withServer(async baseUrl => {
    const { id, events } = await createScenarioWithEvents(baseUrl, 3);
    await postRule(baseUrl, id, { name: "R", when: { type: "event-2" }, then: { type: "out" } });

    const page = await requestJson(baseUrl, `/scenarios/${id}/events?limit=1`);
    assert.equal(typeof page.body.nextCursor, "string");
    await setClock(baseUrl, id, { currentTime: "2030-01-01T00:00:00.000Z" });

    const before = await requestJson(baseUrl, `/scenarios/${id}`);
    const replay = await requestJson(baseUrl, `/scenarios/${id}/replay`);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.results.length, 1);
    const replayAgain = await requestJson(baseUrl, `/scenarios/${id}/replay`);
    assert.deepEqual(replayAgain.body, replay.body);

    const after = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.deepEqual(after.body, before.body);
    assert.equal(after.body.revision, 3);
    assert.deepEqual(after.body.events, events);

    const clock = await requestJson(baseUrl, `/scenarios/${id}/clock`);
    assert.deepEqual(clock.body, { scenarioId: id, currentTime: "2030-01-01T00:00:00.000Z" });

    const followed = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?limit=1&cursor=${encodeURIComponent(page.body.nextCursor)}`
    );
    assert.equal(followed.status, 200);
    assert.deepEqual(followed.body.events.map(event => event.sequence), [2]);

    const scenario = store.scenarios.get(id);
    assert.equal(scenario.revision, 3);
    assert.equal(scenario.events.length, 3);
  }, createApp(store));
});

test("branches copy history but never inherit parent rules, and rule sets stay isolated", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Rule parent" })
    });
    const parentId = created.body.id;

    for (const type of ["alpha", "beta"]) {
      const result = await requestJson(baseUrl, `/scenarios/${parentId}/events`, {
        method: "POST",
        body: JSON.stringify({ type, occurredAt: "2024-08-01T00:00:00.000Z" })
      });
      assert.equal(result.status, 201);
    }

    const parentRule = await postRule(baseUrl, parentId, {
      name: "Parent rule",
      when: { type: "alpha" },
      then: { type: "parent-out" }
    });
    assert.equal(parentRule.status, 201);

    const branch = await branchAt(baseUrl, parentId, { name: "Fork", fromRevision: 2 });
    assert.equal(branch.status, 201);
    const branchId = branch.body.id;

    // The branch copies events but starts with no rules.
    const branchRules = await requestJson(baseUrl, `/scenarios/${branchId}/rules`);
    assert.equal(branchRules.status, 200);
    assert.deepEqual(branchRules.body, []);

    const branchReplay = await requestJson(baseUrl, `/scenarios/${branchId}/replay`);
    assert.equal(branchReplay.status, 200);
    assert.equal(branchReplay.body.revision, 2);
    assert.deepEqual(branchReplay.body.results, []);

    // Adding a rule to the branch only affects the branch's replay.
    const branchRule = await postRule(baseUrl, branchId, {
      name: "Branch rule",
      when: { type: "alpha" },
      then: { type: "branch-out", payload: { where: "branch" } }
    });
    assert.equal(branchRule.status, 201);

    const branchReplay2 = await requestJson(baseUrl, `/scenarios/${branchId}/replay`);
    assert.deepEqual(branchReplay2.body.results, [
      {
        ruleId: branchRule.body.id,
        sourceSequence: 1,
        type: "branch-out",
        payload: { where: "branch" },
        occurredAt: "2024-08-01T00:00:00.000Z"
      }
    ]);

    const parentReplay = await requestJson(baseUrl, `/scenarios/${parentId}/replay`);
    assert.deepEqual(parentReplay.body.results, [
      {
        ruleId: parentRule.body.id,
        sourceSequence: 1,
        type: "parent-out",
        payload: {},
        occurredAt: "2024-08-01T00:00:00.000Z"
      }
    ]);

    // A rule added to the parent after the fork is not visible on the branch.
    const laterParentRule = await postRule(baseUrl, parentId, {
      name: "Later parent rule",
      when: { type: "beta" },
      then: { type: "later-out" }
    });
    assert.equal(laterParentRule.status, 201);

    const branchRulesAfter = await requestJson(baseUrl, `/scenarios/${branchId}/rules`);
    assert.deepEqual(branchRulesAfter.body.map(rule => rule.id), [branchRule.body.id]);

    const parentRules = await requestJson(baseUrl, `/scenarios/${parentId}/rules`);
    assert.deepEqual(parentRules.body.map(rule => rule.id), [parentRule.body.id, laterParentRule.body.id]);

    // Appending to the branch and replaying there does not touch the parent's results.
    const branchEvent = await requestJson(baseUrl, `/scenarios/${branchId}/events`, {
      method: "POST",
      body: JSON.stringify({
        type: "alpha",
        occurredAt: "2024-08-02T00:00:00.000Z"
      })
    });
    assert.equal(branchEvent.status, 201);
    assert.equal(branchEvent.body.sequence, 3);

    const branchReplay3 = await requestJson(baseUrl, `/scenarios/${branchId}/replay`);
    assert.equal(branchReplay3.body.revision, 3);
    assert.deepEqual(
      branchReplay3.body.results.map(result => [result.sourceSequence, result.type]),
      [[1, "branch-out"], [3, "branch-out"]]
    );

    const parentReplay2 = await requestJson(baseUrl, `/scenarios/${parentId}/replay`);
    assert.equal(parentReplay2.body.revision, 2);
    assert.deepEqual(
      parentReplay2.body.results.map(result => [result.sourceSequence, result.type]),
      [[1, "parent-out"], [2, "later-out"]]
    );
  });
});

test("a default event time from a clock earlier than the last event returns 400 without side effects", async () => {
  const store = createScenarioStore();
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Stale clock" })
    });
    const id = created.body.id;

    const clockSet = await setClock(baseUrl, id, { currentTime: "2024-09-01T00:00:00.000Z" });
    assert.equal(clockSet.status, 200);

    // A clock-timed event lands at the clock time; then an explicit event advances past it.
    const clocked = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "clock-timed" })
    });
    assert.equal(clocked.status, 201);
    assert.equal(clocked.body.occurredAt, "2024-09-01T00:00:00.000Z");

    const explicit = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "later", occurredAt: "2024-09-05T00:00:00.000Z" })
    });
    assert.equal(explicit.status, 201);
    assert.equal(explicit.body.sequence, 2);

    // A cursor issued before the rejected append must survive it.
    const page = await requestJson(baseUrl, `/scenarios/${id}/events?limit=1`);
    assert.equal(page.status, 200);
    assert.equal(typeof page.body.nextCursor, "string");

    const stale = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "would-regress" })
    });
    assert.equal(stale.status, 400);
    assert.equal(stale.body.error, "bad_request");

    const scenario = store.scenarios.get(id);
    assert.equal(scenario.revision, 2);
    assert.equal(scenario.events.length, 2);
    assert.equal(store.clocks.get(id), "2024-09-01T00:00:00.000Z");

    const fetched = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.equal(fetched.body.revision, 2);
    assert.deepEqual(fetched.body.events.map(event => event.sequence), [1, 2]);

    const followed = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?limit=1&cursor=${encodeURIComponent(page.body.nextCursor)}`
    );
    assert.equal(followed.status, 200);
    assert.deepEqual(followed.body.events.map(event => event.sequence), [2]);

    // Advancing the clock to the last event time makes default times valid again (equal allowed).
    const advanced = await setClock(baseUrl, id, { currentTime: "2024-09-05T00:00:00.000Z" });
    assert.equal(advanced.status, 200);

    const equal = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "equal-time" })
    });
    assert.equal(equal.status, 201);
    assert.equal(equal.body.occurredAt, "2024-09-05T00:00:00.000Z");
    assert.equal(equal.body.sequence, 3);
  }, createApp(store));
});

test("the stale-clock boundary is enforced per scenario including branches", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Parent" })
    });
    const parentId = created.body.id;

    for (const occurredAt of ["2024-10-01T00:00:00.000Z", "2024-10-05T00:00:00.000Z"]) {
      const result = await requestJson(baseUrl, `/scenarios/${parentId}/events`, {
        method: "POST",
        body: JSON.stringify({ type: "pinned", occurredAt })
      });
      assert.equal(result.status, 201);
    }

    const branch = await branchAt(baseUrl, parentId, { name: "Fork", fromRevision: 2 });
    assert.equal(branch.status, 201);
    const branchId = branch.body.id;

    // The branch clock cannot be set before the copied prefix's last event...
    const tooEarly = await setClock(baseUrl, branchId, { currentTime: "2024-10-01T00:00:00.000Z" });
    assert.equal(tooEarly.status, 400);

    // ...but once set to an allowed time, an explicit later event followed by a default
    // append hits the same regression boundary independently of the parent.
    const allowed = await setClock(baseUrl, branchId, { currentTime: "2024-10-05T00:00:00.000Z" });
    assert.equal(allowed.status, 200);

    const explicit = await requestJson(baseUrl, `/scenarios/${branchId}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "later", occurredAt: "2024-10-10T00:00:00.000Z" })
    });
    assert.equal(explicit.status, 201);

    const stale = await requestJson(baseUrl, `/scenarios/${branchId}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "would-regress" })
    });
    assert.equal(stale.status, 400);
    assert.equal(stale.body.error, "bad_request");

    const fetched = await requestJson(baseUrl, `/scenarios/${branchId}`);
    assert.equal(fetched.body.revision, 3);
    assert.equal(fetched.body.events.length, 3);

    // The parent has no clock set and is unaffected.
    const parentAppended = await requestJson(baseUrl, `/scenarios/${parentId}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "server-time" })
    });
    assert.equal(parentAppended.status, 201);
    assert.equal(parentAppended.body.sequence, 3);
  });
});

async function createReplayScenario(baseUrl, name, events, rules) {
  const created = await requestJson(baseUrl, "/scenarios", {
    method: "POST",
    body: JSON.stringify({ name })
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  for (const event of events) {
    const result = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify(event)
    });
    assert.equal(result.status, 201);
  }

  const storedRules = [];
  for (const rule of rules) {
    const result = await postRule(baseUrl, id, rule);
    assert.equal(result.status, 201);
    storedRules.push(result.body);
  }

  return { id, rules: storedRules };
}

function replayDiffPath(currentId, againstId) {
  return `/scenarios/${currentId}/replay/diff?against=${encodeURIComponent(againstId)}`;
}

test("replay diff of identical results reports no added or removed results", async () => {
  await withServer(async baseUrl => {
    const events = [
      { type: "alpha", occurredAt: "2024-04-01T00:00:00.000Z" },
      { type: "beta", occurredAt: "2024-04-02T00:00:00.000Z" }
    ];
    const rules = [
      { name: "R", when: { type: "alpha" }, then: { type: "one", payload: { n: 1 } } },
      { name: "S", when: { type: "beta" }, then: { type: "two" } }
    ];
    const current = await createReplayScenario(baseUrl, "Current", events, rules);
    const against = await createReplayScenario(baseUrl, "Against", events, rules);

    const diff = await requestJson(baseUrl, replayDiffPath(current.id, against.id));
    assert.equal(diff.status, 200);
    // Different rule ids on each side still cancel: ruleId is not part of the key.
    assert.notEqual(current.rules[0].id, against.rules[0].id);
    assert.deepEqual(diff.body, {
      scenarioId: current.id,
      revision: 2,
      againstScenarioId: against.id,
      againstRevision: 2,
      added: [],
      removed: []
    });

    // Comparing a scenario with itself also yields an empty diff.
    const selfDiff = await requestJson(baseUrl, replayDiffPath(current.id, current.id));
    assert.equal(selfDiff.status, 200);
    assert.deepEqual(selfDiff.body, {
      scenarioId: current.id,
      revision: 2,
      againstScenarioId: current.id,
      againstRevision: 2,
      added: [],
      removed: []
    });
  });
});

test("replay diff cancels duplicate results one occurrence at a time", async () => {
  await withServer(async baseUrl => {
    const events = [{ type: "alpha", occurredAt: "2024-04-01T00:00:00.000Z" }];
    const current = await createReplayScenario(baseUrl, "Current", events, [
      { name: "dup-1", when: { type: "alpha" }, then: { type: "dup", payload: { n: 1 } } },
      { name: "dup-2", when: { type: "alpha" }, then: { type: "dup", payload: { n: 1 } } },
      { name: "only-current", when: { type: "alpha" }, then: { type: "only-a" } }
    ]);
    const against = await createReplayScenario(baseUrl, "Against", events, [
      { name: "dup-1", when: { type: "alpha" }, then: { type: "dup", payload: { n: 1 } } },
      { name: "only-against", when: { type: "alpha" }, then: { type: "only-b" } }
    ]);

    const diff = await requestJson(baseUrl, replayDiffPath(current.id, against.id));
    assert.equal(diff.status, 200);
    assert.equal(diff.body.revision, 1);
    assert.equal(diff.body.againstRevision, 1);
    assert.equal(diff.body.added.length, 2);
    assert.equal(diff.body.removed.length, 1);

    // One of the two duplicate occurrences survives, followed by the current-only result,
    // each keeping its original replay position and full fields.
    assert.deepEqual(diff.body.added[0], {
      ruleId: current.rules[1].id,
      sourceSequence: 1,
      type: "dup",
      payload: { n: 1 },
      occurredAt: "2024-04-01T00:00:00.000Z"
    });
    assert.deepEqual(diff.body.added[1], {
      ruleId: current.rules[2].id,
      sourceSequence: 1,
      type: "only-a",
      payload: {},
      occurredAt: "2024-04-01T00:00:00.000Z"
    });
    assert.deepEqual(diff.body.removed[0], {
      ruleId: against.rules[1].id,
      sourceSequence: 1,
      type: "only-b",
      payload: {},
      occurredAt: "2024-04-01T00:00:00.000Z"
    });

    // The reverse direction keeps the extra duplicate on the removed side, in order.
    const reverse = await requestJson(baseUrl, replayDiffPath(against.id, current.id));
    assert.equal(reverse.status, 200);
    assert.deepEqual(reverse.body.added, [
      {
        ruleId: against.rules[1].id,
        sourceSequence: 1,
        type: "only-b",
        payload: {},
        occurredAt: "2024-04-01T00:00:00.000Z"
      }
    ]);
    assert.deepEqual(reverse.body.removed.map(result => result.type), ["dup", "only-a"]);
    assert.equal(reverse.body.removed[0].ruleId, current.rules[1].id);
    assert.equal(reverse.body.removed[1].ruleId, current.rules[2].id);
  });
});

test("replay diff compares payloads structurally regardless of object field order", async () => {
  await withServer(async baseUrl => {
    const events = [{ type: "alpha", occurredAt: "2024-04-01T00:00:00.000Z" }];
    const current = await createReplayScenario(baseUrl, "Current", events, [
      {
        name: "reordered",
        when: { type: "alpha" },
        then: { type: "same", payload: { a: 1, nested: { x: 1, y: 2 } } }
      },
      { name: "different-value", when: { type: "alpha" }, then: { type: "other", payload: { n: 1 } } }
    ]);
    const against = await createReplayScenario(baseUrl, "Against", events, [
      {
        name: "reordered",
        when: { type: "alpha" },
        then: { type: "same", payload: { nested: { y: 2, x: 1 }, a: 1 } }
      },
      { name: "different-value", when: { type: "alpha" }, then: { type: "other", payload: { n: "1" } } }
    ]);

    const diff = await requestJson(baseUrl, replayDiffPath(current.id, against.id));
    assert.equal(diff.status, 200);
    // The reordered payload cancels; only the structurally different payload remains.
    assert.deepEqual(diff.body.added, [
      {
        ruleId: current.rules[1].id,
        sourceSequence: 1,
        type: "other",
        payload: { n: 1 },
        occurredAt: "2024-04-01T00:00:00.000Z"
      }
    ]);
    assert.deepEqual(diff.body.removed, [
      {
        ruleId: against.rules[1].id,
        sourceSequence: 1,
        type: "other",
        payload: { n: "1" },
        occurredAt: "2024-04-01T00:00:00.000Z"
      }
    ]);
  });
});

test("replay diff reports a symmetric bidirectional difference", async () => {
  await withServer(async baseUrl => {
    const current = await createReplayScenario(
      baseUrl,
      "Current",
      [
        { type: "alpha", occurredAt: "2024-04-01T00:00:00.000Z" },
        { type: "beta", occurredAt: "2024-04-02T00:00:00.000Z" }
      ],
      [
        { name: "alpha-rule", when: { type: "alpha" }, then: { type: "one", payload: { n: 1 } } },
        { name: "beta-rule", when: { type: "beta" }, then: { type: "two" } }
      ]
    );
    const against = await createReplayScenario(
      baseUrl,
      "Against",
      [
        { type: "alpha", occurredAt: "2024-04-01T00:00:00.000Z" },
        { type: "gamma", occurredAt: "2024-04-03T00:00:00.000Z" }
      ],
      [
        { name: "alpha-rule", when: { type: "alpha" }, then: { type: "one", payload: { n: 1 } } },
        { name: "gamma-rule", when: { type: "gamma" }, then: { type: "three", payload: { n: 3 } } }
      ]
    );

    const diff = await requestJson(baseUrl, replayDiffPath(current.id, against.id));
    assert.equal(diff.status, 200);
    assert.equal(diff.body.scenarioId, current.id);
    assert.equal(diff.body.revision, 2);
    assert.equal(diff.body.againstScenarioId, against.id);
    assert.equal(diff.body.againstRevision, 2);
    assert.deepEqual(diff.body.added, [
      {
        ruleId: current.rules[1].id,
        sourceSequence: 2,
        type: "two",
        payload: {},
        occurredAt: "2024-04-02T00:00:00.000Z"
      }
    ]);
    assert.deepEqual(diff.body.removed, [
      {
        ruleId: against.rules[1].id,
        sourceSequence: 2,
        type: "three",
        payload: { n: 3 },
        occurredAt: "2024-04-03T00:00:00.000Z"
      }
    ]);
    for (const result of [...diff.body.added, ...diff.body.removed]) {
      assert.deepEqual(Object.keys(result).sort(), [
        "occurredAt",
        "payload",
        "ruleId",
        "sourceSequence",
        "type"
      ]);
    }

    const reverse = await requestJson(baseUrl, replayDiffPath(against.id, current.id));
    assert.equal(reverse.status, 200);
    assert.equal(reverse.body.scenarioId, against.id);
    assert.equal(reverse.body.againstScenarioId, current.id);
    assert.deepEqual(reverse.body.added, diff.body.removed);
    assert.deepEqual(reverse.body.removed, diff.body.added);
  });
});

test("replay diff rejects malformed against parameters with a JSON 400", async () => {
  await withServer(async baseUrl => {
    const current = await createReplayScenario(
      baseUrl,
      "Current",
      [{ type: "alpha", occurredAt: "2024-04-01T00:00:00.000Z" }],
      [{ name: "R", when: { type: "alpha" }, then: { type: "one" } }]
    );
    const other = await createReplayScenario(
      baseUrl,
      "Other",
      [{ type: "alpha", occurredAt: "2024-04-01T00:00:00.000Z" }],
      [{ name: "R", when: { type: "alpha" }, then: { type: "one" } }]
    );

    const otherEncoded = encodeURIComponent(other.id);
    const badQueries = [
      "",
      "?against=",
      `?against=${otherEncoded}&against=${otherEncoded}`,
      `?against=${otherEncoded}&bogus=1`,
      "?bogus=1"
    ];

    for (const query of badQueries) {
      const result = await requestJson(baseUrl, `/scenarios/${current.id}/replay/diff${query}`);
      assert.equal(result.status, 400, query);
      assert.equal(result.body.error, "bad_request", query);
      assert.equal(typeof result.body.message, "string", query);
    }
  });
});

test("replay diff returns 404 when either scenario is unknown", async () => {
  await withServer(async baseUrl => {
    const current = await createReplayScenario(
      baseUrl,
      "Current",
      [{ type: "alpha", occurredAt: "2024-04-01T00:00:00.000Z" }],
      [{ name: "R", when: { type: "alpha" }, then: { type: "one" } }]
    );

    const missingAgainst = await requestJson(
      baseUrl,
      replayDiffPath(current.id, randomUUID())
    );
    assert.equal(missingAgainst.status, 404);
    assert.deepEqual(missingAgainst.body, { error: "not_found", message: "Scenario not found" });

    const missingCurrent = await requestJson(
      baseUrl,
      `/scenarios/${randomUUID()}/replay/diff?against=${encodeURIComponent(current.id)}`
    );
    assert.equal(missingCurrent.status, 404);
    assert.deepEqual(missingCurrent.body, { error: "not_found", message: "Scenario not found" });

    const bothMissing = await requestJson(
      baseUrl,
      `/scenarios/${randomUUID()}/replay/diff?against=${encodeURIComponent(randomUUID())}`
    );
    assert.equal(bothMissing.status, 404);
    assert.equal(bothMissing.body.error, "not_found");

    // Scenario lookup takes precedence over query validation, matching other endpoints.
    const precedence = await requestJson(
      baseUrl,
      `/scenarios/${randomUUID()}/replay/diff?bogus=1`
    );
    assert.equal(precedence.status, 404);
    assert.equal(precedence.body.error, "not_found");
  });
});

test("replay diff is read-only for both scenarios including cursors and clocks", async () => {
  const store = createScenarioStore();
  await withServer(async baseUrl => {
    const current = await createReplayScenario(
      baseUrl,
      "Current",
      [
        { type: "alpha", occurredAt: "2024-04-01T00:00:00.000Z" },
        { type: "beta", occurredAt: "2024-04-02T00:00:00.000Z" }
      ],
      [
        { name: "R", when: { type: "alpha" }, then: { type: "one", payload: { n: 1 } } },
        { name: "S", when: { type: "beta" }, then: { type: "two" } }
      ]
    );
    const against = await createReplayScenario(
      baseUrl,
      "Against",
      [
        { type: "alpha", occurredAt: "2024-04-01T00:00:00.000Z" },
        { type: "unmatched", occurredAt: "2024-04-03T00:00:00.000Z" }
      ],
      [{ name: "R", when: { type: "alpha" }, then: { type: "one", payload: { n: 1 } } }]
    );

    // Cursors and clocks exist on both sides before the diff.
    const currentPage = await requestJson(baseUrl, `/scenarios/${current.id}/events?limit=1`);
    assert.equal(typeof currentPage.body.nextCursor, "string");
    const againstPage = await requestJson(baseUrl, `/scenarios/${against.id}/events?limit=1`);
    assert.equal(typeof againstPage.body.nextCursor, "string");
    await setClock(baseUrl, current.id, { currentTime: "2030-01-01T00:00:00.000Z" });
    await setClock(baseUrl, against.id, { currentTime: "2031-01-01T00:00:00.000Z" });

    const currentBefore = await requestJson(baseUrl, `/scenarios/${current.id}`);
    const againstBefore = await requestJson(baseUrl, `/scenarios/${against.id}`);
    const currentRulesBefore = await requestJson(baseUrl, `/scenarios/${current.id}/rules`);
    const againstRulesBefore = await requestJson(baseUrl, `/scenarios/${against.id}/rules`);

    const diff = await requestJson(baseUrl, replayDiffPath(current.id, against.id));
    assert.equal(diff.status, 200);
    assert.equal(diff.body.added.length, 1);
    assert.equal(diff.body.removed.length, 0);

    // Repeating the exact same read-only query yields identical output.
    const diffAgain = await requestJson(baseUrl, replayDiffPath(current.id, against.id));
    assert.deepEqual(diffAgain.body, diff.body);

    // Failing requests must be side-effect free as well.
    for (const badPath of [
      `/scenarios/${current.id}/replay/diff`,
      `/scenarios/${current.id}/replay/diff?against=`,
      `/scenarios/${current.id}/replay/diff?against=x&against=y`,
      `/scenarios/${current.id}/replay/diff?against=${encodeURIComponent(randomUUID())}`
    ]) {
      const result = await requestJson(baseUrl, badPath);
      assert.ok(result.status === 400 || result.status === 404, badPath);
    }

    const currentAfter = await requestJson(baseUrl, `/scenarios/${current.id}`);
    const againstAfter = await requestJson(baseUrl, `/scenarios/${against.id}`);
    assert.deepEqual(currentAfter.body, currentBefore.body);
    assert.deepEqual(againstAfter.body, againstBefore.body);

    const currentRulesAfter = await requestJson(baseUrl, `/scenarios/${current.id}/rules`);
    const againstRulesAfter = await requestJson(baseUrl, `/scenarios/${against.id}/rules`);
    assert.deepEqual(currentRulesAfter.body, currentRulesBefore.body);
    assert.deepEqual(againstRulesAfter.body, againstRulesBefore.body);

    const currentClock = await requestJson(baseUrl, `/scenarios/${current.id}/clock`);
    const againstClock = await requestJson(baseUrl, `/scenarios/${against.id}/clock`);
    assert.deepEqual(currentClock.body, {
      scenarioId: current.id,
      currentTime: "2030-01-01T00:00:00.000Z"
    });
    assert.deepEqual(againstClock.body, {
      scenarioId: against.id,
      currentTime: "2031-01-01T00:00:00.000Z"
    });

    // Cursors issued before the diff remain valid on both scenarios.
    const currentFollowUp = await requestJson(
      baseUrl,
      `/scenarios/${current.id}/events?limit=1&cursor=${encodeURIComponent(currentPage.body.nextCursor)}`
    );
    assert.equal(currentFollowUp.status, 200);
    assert.deepEqual(
      currentFollowUp.body.events.map(event => event.sequence),
      [2]
    );
    const againstFollowUp = await requestJson(
      baseUrl,
      `/scenarios/${against.id}/events?limit=1&cursor=${encodeURIComponent(againstPage.body.nextCursor)}`
    );
    assert.equal(againstFollowUp.status, 200);
    assert.equal(againstFollowUp.body.nextCursor, null);

    // The plain replay endpoint still agrees with the diff's underlying derivation.
    const currentReplay = await requestJson(baseUrl, `/scenarios/${current.id}/replay`);
    assert.equal(currentReplay.status, 200);
    assert.equal(currentReplay.body.results.length, 2);

    assert.equal(store.scenarios.get(current.id).revision, 2);
    assert.equal(store.scenarios.get(current.id).events.length, 2);
    assert.equal(store.scenarios.get(against.id).revision, 2);
    assert.equal(store.scenarios.get(against.id).events.length, 2);
    assert.equal(store.rules.get(current.id).length, 2);
    assert.equal(store.rules.get(against.id).length, 1);
    assert.equal(store.clocks.get(current.id), "2030-01-01T00:00:00.000Z");
    assert.equal(store.clocks.get(against.id), "2031-01-01T00:00:00.000Z");
  }, createApp(store));
});

function replayExplainPath(scenarioId, ruleId, sourceSequence) {
  return `/scenarios/${scenarioId}/replay/explain?ruleId=${encodeURIComponent(ruleId)}&sourceSequence=${sourceSequence}`;
}

test("GET replay/explain returns the result, source event, rule, and root ancestry", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Explain" })
    });
    const id = created.body.id;

    const events = [];
    for (const [index, type] of ["alpha", "beta", "alpha"].entries()) {
      const result = await requestJson(baseUrl, `/scenarios/${id}/events`, {
        method: "POST",
        body: JSON.stringify({
          type,
          occurredAt: `2024-04-0${index + 1}T00:00:00.000Z`
        })
      });
      assert.equal(result.status, 201);
      events.push(result.body);
    }

    const r1 = await postRule(baseUrl, id, {
      name: "R1",
      when: { type: "alpha" },
      then: { type: "one", payload: { n: 1 } }
    });
    const r2 = await postRule(baseUrl, id, { name: "R2", when: { type: "alpha" }, then: { type: "two" } });
    const r3 = await postRule(baseUrl, id, {
      name: "R3",
      when: { type: "beta" },
      then: { type: "three", payload: { n: 3 } }
    });
    assert.equal(r1.status, 201);

    const replay = await requestJson(baseUrl, `/scenarios/${id}/replay`);
    assert.equal(replay.status, 200);

    const explained = await requestJson(baseUrl, replayExplainPath(id, r3.body.id, 2));
    assert.equal(explained.status, 200);
    const body = explained.body;
    assert.deepEqual(Object.keys(body).sort(), [
      "ancestry",
      "event",
      "result",
      "revision",
      "rule",
      "scenarioId"
    ]);
    assert.equal(body.scenarioId, id);
    assert.equal(body.revision, 3);

    const expectedResult = replay.body.results.find(
      result => result.ruleId === r3.body.id && result.sourceSequence === 2
    );
    assert.deepEqual(body.result, expectedResult);
    assert.deepEqual(body.result, {
      ruleId: r3.body.id,
      sourceSequence: 2,
      type: "three",
      payload: { n: 3 },
      occurredAt: events[1].occurredAt
    });
    assert.deepEqual(
      Object.keys(body.result).sort(),
      ["occurredAt", "payload", "ruleId", "sourceSequence", "type"]
    );

    assert.deepEqual(body.event, events[1]);
    assert.deepEqual(Object.keys(body.event).sort(), [
      "id",
      "occurredAt",
      "payload",
      "sequence",
      "type"
    ]);
    assert.deepEqual(body.rule, r3.body);
    assert.deepEqual(Object.keys(body.rule).sort(), ["id", "name", "then", "when"]);

    assert.deepEqual(body.ancestry, [
      { scenarioId: id, parentScenarioId: null, parentRevision: null }
    ]);

    // A rule without an explicit payload still derives {} and repeats are identical.
    const noPayload = await requestJson(baseUrl, replayExplainPath(id, r2.body.id, 3));
    assert.equal(noPayload.status, 200);
    assert.deepEqual(noPayload.body.result.payload, {});
    assert.deepEqual(noPayload.body.event, events[2]);
    assert.deepEqual(noPayload.body.rule, r2.body);

    const again = await requestJson(baseUrl, replayExplainPath(id, r2.body.id, 3));
    assert.deepEqual(again.body, noPayload.body);

    // Each matching rule explains independently, including several rules on one event.
    const firstRuleOnFirstEvent = await requestJson(baseUrl, replayExplainPath(id, r1.body.id, 1));
    assert.equal(firstRuleOnFirstEvent.status, 200);
    assert.deepEqual(firstRuleOnFirstEvent.body.result.type, "one");
    assert.deepEqual(firstRuleOnFirstEvent.body.event, events[0]);
    const secondRuleOnFirstEvent = await requestJson(baseUrl, replayExplainPath(id, r2.body.id, 1));
    assert.equal(secondRuleOnFirstEvent.status, 200);
    assert.deepEqual(secondRuleOnFirstEvent.body.result.type, "two");
    assert.deepEqual(secondRuleOnFirstEvent.body.event, events[0]);
  });
});

test("GET replay/explain ancestry follows a chain of branches back to the root", async () => {
  await withServer(async baseUrl => {
    const { id: rootId, events } = await createScenarioWithEvents(baseUrl, 4, "Root");

    const child = await branchAt(baseUrl, rootId, { name: "Child", fromRevision: 3 });
    assert.equal(child.status, 201);
    const childId = child.body.id;

    const grandchild = await branchAt(baseUrl, childId, { name: "Grandchild", fromRevision: 1 });
    assert.equal(grandchild.status, 201);
    const grandchildId = grandchild.body.id;

    // The grandchild owns no rules initially; register one matching the copied first event.
    const rule = await postRule(baseUrl, grandchildId, {
      name: "Grandchild rule",
      when: { type: "event-1" },
      then: { type: "derived" }
    });
    assert.equal(rule.status, 201);

    const explained = await requestJson(baseUrl, replayExplainPath(grandchildId, rule.body.id, 1));
    assert.equal(explained.status, 200);
    assert.equal(explained.body.scenarioId, grandchildId);
    assert.equal(explained.body.revision, 1);
    assert.deepEqual(explained.body.event, events[0]);
    assert.deepEqual(explained.body.rule, rule.body);
    assert.deepEqual(explained.body.result, {
      ruleId: rule.body.id,
      sourceSequence: 1,
      type: "derived",
      payload: {},
      occurredAt: events[0].occurredAt
    });
    assert.deepEqual(explained.body.ancestry, [
      { scenarioId: grandchildId, parentScenarioId: childId, parentRevision: 1 },
      { scenarioId: childId, parentScenarioId: rootId, parentRevision: 3 },
      { scenarioId: rootId, parentScenarioId: null, parentRevision: null }
    ]);

    // A direct child branch lists itself then the root.
    const childRule = await postRule(baseUrl, childId, {
      name: "Child rule",
      when: { type: "event-2" },
      then: { type: "child-derived" }
    });
    const childExplained = await requestJson(baseUrl, replayExplainPath(childId, childRule.body.id, 2));
    assert.equal(childExplained.status, 200);
    assert.deepEqual(childExplained.body.ancestry, [
      { scenarioId: childId, parentScenarioId: rootId, parentRevision: 3 },
      { scenarioId: rootId, parentScenarioId: null, parentRevision: null }
    ]);
  });
});

test("GET replay/explain returns 400 when the rule or event is missing or the rule does not match", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "No match" })
    });
    const id = created.body.id;

    for (const type of ["alpha", "beta"]) {
      const result = await requestJson(baseUrl, `/scenarios/${id}/events`, {
        method: "POST",
        body: JSON.stringify({ type, occurredAt: "2024-04-01T00:00:00.000Z" })
      });
      assert.equal(result.status, 201);
    }

    const matching = await postRule(baseUrl, id, {
      name: "matching",
      when: { type: "alpha" },
      then: { type: "out" }
    });
    const otherType = await postRule(baseUrl, id, {
      name: "other-type",
      when: { type: "gamma" },
      then: { type: "never" }
    });
    assert.equal(matching.status, 201);
    assert.equal(otherType.status, 201);

    // A rule belonging to a different scenario is not the target scenario's rule.
    const otherScenario = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Other" })
    });
    const foreignRule = await postRule(baseUrl, otherScenario.body.id, {
      name: "foreign",
      when: { type: "alpha" },
      then: { type: "foreign-out" }
    });
    assert.equal(foreignRule.status, 201);

    const cases = [
      [replayExplainPath(id, randomUUID(), 1), "unknown ruleId"],
      [replayExplainPath(id, foreignRule.body.id, 1), "ruleId from another scenario"],
      [replayExplainPath(id, matching.body.id, 3), "sourceSequence past the last event"],
      [replayExplainPath(id, matching.body.id, 999), "sourceSequence far beyond events"],
      [replayExplainPath(id, otherType.body.id, 1), "rule exists but its when.type does not match"]
    ];

    for (const [path, label] of cases) {
      const result = await requestJson(baseUrl, path);
      assert.equal(result.status, 400, label);
      assert.equal(result.body.error, "bad_request", label);
      assert.equal(typeof result.body.message, "string", label);
    }

    // The gamma rule matches neither event 1 (alpha) nor event 2 (beta).
    const ok = await requestJson(baseUrl, replayExplainPath(id, otherType.body.id, 2));
    assert.equal(ok.status, 400);
    const matched = await requestJson(baseUrl, replayExplainPath(id, matching.body.id, 1));
    assert.equal(matched.status, 200);
  });
});

test("GET replay/explain validates ruleId and sourceSequence parameters", async () => {
  await withServer(async baseUrl => {
    const created = await requestJson(baseUrl, "/scenarios", {
      method: "POST",
      body: JSON.stringify({ name: "Validated explain" })
    });
    const id = created.body.id;
    const event = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "alpha", occurredAt: "2024-04-01T00:00:00.000Z" })
    });
    assert.equal(event.status, 201);
    const rule = await postRule(baseUrl, id, {
      name: "R",
      when: { type: "alpha" },
      then: { type: "out" }
    });
    const ruleId = encodeURIComponent(rule.body.id);

    const invalidSequences = [
      "0",
      "-1",
      "+1",
      "1.5",
      "1.0",
      " 1",
      "1 ",
      "1e2",
      "0x1",
      "abc",
      "NaN",
      "Infinity",
      "9999999999"
    ];

    const badQueries = [
      "",
      "?",
      `?ruleId=${ruleId}`,
      "?sourceSequence=1",
      `?ruleId=&sourceSequence=1`,
      `?ruleId=${ruleId}&sourceSequence=`,
      `?ruleId=${ruleId}&ruleId=${ruleId}&sourceSequence=1`,
      `?ruleId=${ruleId}&sourceSequence=1&sourceSequence=2`,
      `?ruleId=${ruleId}&sourceSequence=1&bogus=1`,
      "?ruleId=&sourceSequence=",
      ...invalidSequences.map(value => `?ruleId=${ruleId}&sourceSequence=${encodeURIComponent(value)}`)
    ];

    for (const query of badQueries) {
      const result = await requestJson(baseUrl, `/scenarios/${id}/replay/explain${query}`);
      assert.equal(result.status, 400, query);
      assert.equal(result.body.error, "bad_request", query);
      assert.equal(typeof result.body.message, "string", query);
    }

    // The well-formed request still succeeds after all the rejected ones.
    const ok = await requestJson(baseUrl, replayExplainPath(id, rule.body.id, 1));
    assert.equal(ok.status, 200);
  });
});

test("GET replay/explain returns 404 for an unknown scenario, taking precedence over parameter validation", async () => {
  await withServer(async baseUrl => {
    const missing = await requestJson(
      baseUrl,
      `/scenarios/${randomUUID()}/replay/explain?ruleId=${encodeURIComponent(randomUUID())}&sourceSequence=1`
    );
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: "not_found", message: "Scenario not found" });

    for (const query of ["", "?bogus=1", "?ruleId=x", "?sourceSequence=0", "?ruleId=&sourceSequence="]) {
      const result = await requestJson(baseUrl, `/scenarios/${randomUUID()}/replay/explain${query}`);
      assert.equal(result.status, 404, query);
      assert.equal(result.body.error, "not_found", query);
    }
  });
});

test("GET replay/explain is read-only for revision, events, rules, clock, and cursors", async () => {
  const store = createScenarioStore();
  await withServer(async baseUrl => {
    const { id, events } = await createScenarioWithEvents(baseUrl, 3);
    const matching = await postRule(baseUrl, id, {
      name: "matching",
      when: { type: "event-2" },
      then: { type: "out", payload: { n: 2 } }
    });
    const other = await postRule(baseUrl, id, {
      name: "other",
      when: { type: "event-9" },
      then: { type: "never" }
    });
    assert.equal(matching.status, 201);

    const page = await requestJson(baseUrl, `/scenarios/${id}/events?limit=2`);
    assert.equal(page.status, 200);
    assert.equal(typeof page.body.nextCursor, "string");
    await setClock(baseUrl, id, { currentTime: "2030-01-01T00:00:00.000Z" });

    const before = await requestJson(baseUrl, `/scenarios/${id}`);
    const rulesBefore = await requestJson(baseUrl, `/scenarios/${id}/rules`);
    const replayBefore = await requestJson(baseUrl, `/scenarios/${id}/replay`);

    const explained = await requestJson(baseUrl, replayExplainPath(id, matching.body.id, 2));
    assert.equal(explained.status, 200);
    const explainedAgain = await requestJson(baseUrl, replayExplainPath(id, matching.body.id, 2));
    assert.deepEqual(explainedAgain.body, explained.body);

    // Failing explanations must be side-effect free as well.
    for (const path of [
      `/scenarios/${id}/replay/explain`,
      `/scenarios/${id}/replay/explain?ruleId=x&sourceSequence=0`,
      replayExplainPath(id, randomUUID(), 1),
      replayExplainPath(id, matching.body.id, 99),
      replayExplainPath(id, other.body.id, 1)
    ]) {
      const result = await requestJson(baseUrl, path);
      assert.equal(result.status, 400, path);
    }

    const after = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.deepEqual(after.body, before.body);
    assert.equal(after.body.revision, 3);
    assert.deepEqual(after.body.events, events);

    const rulesAfter = await requestJson(baseUrl, `/scenarios/${id}/rules`);
    assert.deepEqual(rulesAfter.body, rulesBefore.body);

    const replayAfter = await requestJson(baseUrl, `/scenarios/${id}/replay`);
    assert.deepEqual(replayAfter.body, replayBefore.body);

    const clock = await requestJson(baseUrl, `/scenarios/${id}/clock`);
    assert.deepEqual(clock.body, { scenarioId: id, currentTime: "2030-01-01T00:00:00.000Z" });

    const followed = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`
    );
    assert.equal(followed.status, 200);
    assert.deepEqual(followed.body.events.map(event => event.sequence), [3]);
    assert.equal(followed.body.nextCursor, null);

    const scenario = store.scenarios.get(id);
    assert.equal(scenario.revision, 3);
    assert.equal(scenario.events.length, 3);
    assert.equal(store.rules.get(id).length, 2);
    assert.equal(store.clocks.get(id), "2030-01-01T00:00:00.000Z");
  }, createApp(store));
});

test("GET replay/explain respects branch rule isolation and copied prefixes", async () => {
  await withServer(async baseUrl => {
    const { id: parentId, events } = await createScenarioWithEvents(baseUrl, 3, "Parent");

    const parentRule = await postRule(baseUrl, parentId, {
      name: "Parent rule",
      when: { type: "event-1" },
      then: { type: "parent-out" }
    });
    assert.equal(parentRule.status, 201);

    const branch = await branchAt(baseUrl, parentId, { name: "Fork", fromRevision: 2 });
    assert.equal(branch.status, 201);
    const branchId = branch.body.id;

    // The parent's rule id is not a rule of the branch, even though the matching event
    // was copied into the branch prefix.
    const parentRuleOnBranch = await requestJson(
      baseUrl,
      replayExplainPath(branchId, parentRule.body.id, 1)
    );
    assert.equal(parentRuleOnBranch.status, 400);
    assert.equal(parentRuleOnBranch.body.error, "bad_request");

    // Event 3 exists on the parent but was not copied into the branch prefix.
    const branchRule = await postRule(baseUrl, branchId, {
      name: "Branch rule",
      when: { type: "event-2" },
      then: { type: "branch-out" }
    });
    assert.equal(branchRule.status, 201);
    const beyondPrefix = await requestJson(
      baseUrl,
      replayExplainPath(branchId, branchRule.body.id, 3)
    );
    assert.equal(beyondPrefix.status, 400);

    // The branch rule explains the copied event and reports the branching ancestry.
    const explained = await requestJson(baseUrl, replayExplainPath(branchId, branchRule.body.id, 2));
    assert.equal(explained.status, 200);
    assert.equal(explained.body.scenarioId, branchId);
    assert.equal(explained.body.revision, 2);
    assert.deepEqual(explained.body.event, events[1]);
    assert.deepEqual(explained.body.rule, branchRule.body);
    assert.deepEqual(explained.body.result, {
      ruleId: branchRule.body.id,
      sourceSequence: 2,
      type: "branch-out",
      payload: {},
      occurredAt: events[1].occurredAt
    });
    assert.deepEqual(explained.body.ancestry, [
      { scenarioId: branchId, parentScenarioId: parentId, parentRevision: 2 },
      { scenarioId: parentId, parentScenarioId: null, parentRevision: null }
    ]);

    // The parent is unaffected and still explains with its own rule.
    const parentExplained = await requestJson(
      baseUrl,
      replayExplainPath(parentId, parentRule.body.id, 1)
    );
    assert.equal(parentExplained.status, 200);
    assert.deepEqual(parentExplained.body.result.type, "parent-out");

    // A branch rule id is meaningless back on the parent.
    const branchRuleOnParent = await requestJson(
      baseUrl,
      replayExplainPath(parentId, branchRule.body.id, 2)
    );
    assert.equal(branchRuleOnParent.status, 400);
  });
});
