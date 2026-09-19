import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";

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

async function createScenarioWithEvents(baseUrl, count) {
  const created = await requestJson(baseUrl, "/scenarios", {
    method: "POST",
    body: JSON.stringify({ name: "Paged" })
  });
  const id = created.body.id;
  const events = [];
  for (let i = 0; i < count; i += 1) {
    const result = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: `event-${i + 1}`, payload: { index: i } })
    });
    assert.equal(result.status, 201);
    events.push(result.body);
  }
  return { id, events };
}

async function collectPages(baseUrl, id, query) {
  const pages = [];
  let cursor = null;
  do {
    const suffix = cursor === null ? query : `${query}&cursor=${encodeURIComponent(cursor)}`;
    const page = await requestJson(baseUrl, `/scenarios/${id}/events?${suffix}`);
    assert.equal(page.status, 200);
    pages.push(page.body);
    cursor = page.body.nextCursor;
  } while (cursor !== null);
  return pages;
}

test("GET /scenarios/:id/events returns 404 for an unknown scenario", async () => {
  await withServer(async baseUrl => {
    const result = await requestJson(baseUrl, "/scenarios/nope/events");
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: "not_found", message: "Scenario not found" });
  });
});

test("events listing paginates without duplicates or gaps", async () => {
  await withServer(async baseUrl => {
    const { id, events } = await createScenarioWithEvents(baseUrl, 7);

    const pages = await collectPages(baseUrl, id, "limit=3");
    assert.equal(pages.length, 3);
    assert.deepEqual(pages.map(p => p.events.length), [3, 3, 1]);
    assert.equal(pages[0].revision, 7);
    assert.equal(pages[2].revision, 7);
    assert.ok(pages[0].nextCursor !== null);
    assert.ok(pages[1].nextCursor !== null);
    assert.equal(pages[2].nextCursor, null);

    const collected = pages.flatMap(p => p.events);
    assert.deepEqual(collected.map(e => e.sequence), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(collected, events);
  });
});

test("events listing defaults to a limit of 50", async () => {
  await withServer(async baseUrl => {
    const { id, events } = await createScenarioWithEvents(baseUrl, 55);

    const first = await requestJson(baseUrl, `/scenarios/${id}/events`);
    assert.equal(first.status, 200);
    assert.equal(first.body.events.length, 50);
    assert.ok(first.body.nextCursor !== null);

    const second = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?cursor=${encodeURIComponent(first.body.nextCursor)}`
    );
    assert.equal(second.status, 200);
    assert.equal(second.body.events.length, 5);
    assert.equal(second.body.nextCursor, null);
    assert.deepEqual(
      [...first.body.events, ...second.body.events].map(e => e.id),
      events.map(e => e.id)
    );
  });
});

test("events listing applies a closed from/to range", async () => {
  await withServer(async baseUrl => {
    const { id, events } = await createScenarioWithEvents(baseUrl, 5);
    const from = events[1].occurredAt;
    const to = events[3].occurredAt;

    const ranged = await requestJson(baseUrl, `/scenarios/${id}/events?from=${from}&to=${to}`);
    assert.equal(ranged.status, 200);
    assert.equal(ranged.body.nextCursor, null);
    const expected = events.filter(e => e.occurredAt >= from && e.occurredAt <= to);
    assert.ok(expected.length >= 1);
    assert.deepEqual(ranged.body.events, expected);
    assert.ok(ranged.body.events.every(e => e.occurredAt >= from && e.occurredAt <= to));

    const fromOnly = await requestJson(baseUrl, `/scenarios/${id}/events?from=${from}`);
    assert.deepEqual(
      fromOnly.body.events,
      events.filter(e => e.occurredAt >= from)
    );

    const toOnly = await requestJson(baseUrl, `/scenarios/${id}/events?to=${to}`);
    assert.deepEqual(
      toOnly.body.events,
      events.filter(e => e.occurredAt <= to)
    );
  });
});

test("events listing returns an empty page when nothing matches", async () => {
  await withServer(async baseUrl => {
    const { id } = await createScenarioWithEvents(baseUrl, 3);

    const future = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?from=2999-01-01T00:00:00.000Z`
    );
    assert.equal(future.status, 200);
    assert.equal(future.body.revision, 3);
    assert.deepEqual(future.body.events, []);
    assert.equal(future.body.nextCursor, null);

    const empty = await createScenarioWithEvents(baseUrl, 0);
    const none = await requestJson(baseUrl, `/scenarios/${empty.id}/events`);
    assert.equal(none.status, 200);
    assert.equal(none.body.revision, 0);
    assert.deepEqual(none.body.events, []);
    assert.equal(none.body.nextCursor, null);
  });
});

test("events listing rejects invalid query parameters without changing data", async () => {
  await withServer(async baseUrl => {
    const { id } = await createScenarioWithEvents(baseUrl, 2);
    const validFrom = "2020-01-01T00:00:00.000Z";
    const validTo = "2020-01-02T00:00:00.000Z";

    const cases = [
      ["from=not-a-date", "malformed from"],
      ["from=2020-01-01", "from without time"],
      ["from=2020-01-01T00:00:00Z", "from without milliseconds"],
      ["from=2020-01-01T00:00:00.000%2B02:00", "from not in UTC"],
      ["from=2021-02-29T00:00:00.000Z", "from with impossible date"],
      ["from=2020-13-01T00:00:00.000Z", "from with impossible month"],
      ["from=", "empty from"],
      ["to=2020-01-01T25:00:00.000Z", "to with impossible hour"],
      [`from=${validTo}&to=${validFrom}`, "to earlier than from"],
      [`from=${validFrom}&from=${validFrom}`, "duplicate from"],
      [`to=${validTo}&to=${validTo}`, "duplicate to"],
      ["limit=1&limit=2", "duplicate limit"],
      ["limit=0", "limit too small"],
      ["limit=101", "limit too large"],
      ["limit=1.5", "non-integer limit"],
      ["limit=abc", "non-numeric limit"],
      ["limit=", "empty limit"],
      ["limit=-3", "negative limit"],
      ["cursor=not-a-cursor", "garbage cursor"],
      ["cursor=", "empty cursor"],
      ["unknown=1", "unknown query parameter"]
    ];

    for (const [query, label] of cases) {
      const result = await requestJson(baseUrl, `/scenarios/${id}/events?${query}`);
      assert.equal(result.status, 400, label);
      assert.equal(result.body.error, "bad_request", label);
    }

    const fetched = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.equal(fetched.body.revision, 2);
    assert.equal(fetched.body.events.length, 2);
  });
});

test("a cursor from another scenario is rejected", async () => {
  await withServer(async baseUrl => {
    const a = await createScenarioWithEvents(baseUrl, 4);
    const b = await createScenarioWithEvents(baseUrl, 4);

    const first = await requestJson(baseUrl, `/scenarios/${a.id}/events?limit=2`);
    assert.equal(first.status, 200);
    assert.ok(first.body.nextCursor !== null);

    const reused = await requestJson(
      baseUrl,
      `/scenarios/${b.id}/events?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`
    );
    assert.equal(reused.status, 400);
    assert.equal(reused.body.error, "bad_request");
  });
});

test("a cursor with mismatched filters is rejected", async () => {
  await withServer(async baseUrl => {
    const { id } = await createScenarioWithEvents(baseUrl, 6);

    const first = await requestJson(baseUrl, `/scenarios/${id}/events?limit=2`);
    assert.equal(first.status, 200);
    const cursor = encodeURIComponent(first.body.nextCursor);

    const changedLimit = await requestJson(baseUrl, `/scenarios/${id}/events?limit=3&cursor=${cursor}`);
    assert.equal(changedLimit.status, 400);

    const addedFrom = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?limit=2&from=2020-01-01T00:00:00.000Z&cursor=${cursor}`
    );
    assert.equal(addedFrom.status, 400);

    const ranged = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?limit=2&from=2020-01-01T00:00:00.000Z`
    );
    assert.equal(ranged.status, 200);
    const droppedFrom = await requestJson(
      baseUrl,
      `/scenarios/${id}/events?limit=2&cursor=${encodeURIComponent(ranged.body.nextCursor)}`
    );
    assert.equal(droppedFrom.status, 400);

    const fetched = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.equal(fetched.body.revision, 6);
  });
});

test("a cursor is invalidated by writes during pagination", async () => {
  await withServer(async baseUrl => {
    const { id } = await createScenarioWithEvents(baseUrl, 4);

    const first = await requestJson(baseUrl, `/scenarios/${id}/events?limit=2`);
    assert.equal(first.status, 200);
    assert.equal(first.body.revision, 4);
    const cursor = encodeURIComponent(first.body.nextCursor);

    const appended = await requestJson(baseUrl, `/scenarios/${id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "late-write" })
    });
    assert.equal(appended.status, 201);

    const stale = await requestJson(baseUrl, `/scenarios/${id}/events?limit=2&cursor=${cursor}`);
    assert.equal(stale.status, 400);
    assert.equal(stale.body.error, "bad_request");

    const fetched = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.equal(fetched.body.revision, 5);
    assert.equal(fetched.body.events.length, 5);

    const restarted = await requestJson(baseUrl, `/scenarios/${id}/events?limit=100`);
    assert.equal(restarted.status, 200);
    assert.equal(restarted.body.revision, 5);
    assert.equal(restarted.body.events.length, 5);
    assert.equal(restarted.body.nextCursor, null);
  });
});

test("events listing matches the scenario event representation", async () => {
  await withServer(async baseUrl => {
    const { id } = await createScenarioWithEvents(baseUrl, 3);

    const listed = await requestJson(baseUrl, `/scenarios/${id}/events`);
    assert.equal(listed.status, 200);

    const fetched = await requestJson(baseUrl, `/scenarios/${id}`);
    assert.deepEqual(listed.body.events, fetched.body.events);
    assert.equal(listed.body.revision, fetched.body.revision);
    for (const event of listed.body.events) {
      assert.deepEqual(Object.keys(event).sort(), ["id", "occurredAt", "payload", "sequence", "type"]);
    }
  });
});
