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
