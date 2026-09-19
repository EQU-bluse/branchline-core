import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createHandler } from "../src/app.js";

async function withServer(run) {
  const server = createServer(createHandler());
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

function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

async function createScenario(baseUrl, body = { name: "scenario" }) {
  const response = await postJson(`${baseUrl}/scenarios`, body);
  assert.equal(response.status, 201);
  return response.json();
}

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test("POST /scenarios creates a scenario with defaults", async () => {
  await withServer(async baseUrl => {
    const response = await postJson(`${baseUrl}/scenarios`, { name: "launch" });
    assert.equal(response.status, 201);
    const scenario = await response.json();
    assert.equal(typeof scenario.id, "string");
    assert.notEqual(scenario.id.length, 0);
    assert.equal(scenario.name, "launch");
    assert.equal(scenario.description, "");
    assert.equal(scenario.revision, 0);
    assert.deepEqual(scenario.events, []);
    assert.match(scenario.createdAt, ISO_PATTERN);
  });
});

test("POST /scenarios accepts an optional description and charset content-type", async () => {
  await withServer(async baseUrl => {
    const response = await postJson(
      `${baseUrl}/scenarios`,
      { name: "launch", description: "first" },
      { "content-type": "application/json; charset=utf-8" }
    );
    assert.equal(response.status, 201);
    const scenario = await response.json();
    assert.equal(scenario.description, "first");
  });
});

test("GET /scenarios lists scenarios in creation order", async () => {
  await withServer(async baseUrl => {
    const first = await createScenario(baseUrl, { name: "one" });
    const second = await createScenario(baseUrl, { name: "two" });
    const third = await createScenario(baseUrl, { name: "three" });

    const response = await fetch(`${baseUrl}/scenarios`);
    assert.equal(response.status, 200);
    const scenarios = await response.json();
    assert.deepEqual(scenarios.map(s => s.id), [first.id, second.id, third.id]);
    assert.deepEqual(scenarios.map(s => s.name), ["one", "two", "three"]);
  });
});

test("GET /scenarios/:id returns the scenario", async () => {
  await withServer(async baseUrl => {
    const created = await createScenario(baseUrl, { name: "lookup" });
    const response = await fetch(`${baseUrl}/scenarios/${created.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), created);
  });
});

test("GET /scenarios/:id returns a JSON 404 for unknown ids", async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/scenarios/does-not-exist`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error, "not_found");
    assert.equal(typeof body.message, "string");
  });
});

test("POST /scenarios/:id/events appends events with increasing sequence and revision", async () => {
  await withServer(async baseUrl => {
    const scenario = await createScenario(baseUrl, { name: "timeline" });

    const firstResponse = await postJson(`${baseUrl}/scenarios/${scenario.id}/events`, {
      type: "started"
    });
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json();
    assert.equal(typeof first.id, "string");
    assert.equal(first.type, "started");
    assert.deepEqual(first.payload, {});
    assert.match(first.occurredAt, ISO_PATTERN);
    assert.equal(first.sequence, 1);

    const secondResponse = await postJson(`${baseUrl}/scenarios/${scenario.id}/events`, {
      type: "moved",
      payload: { x: 1, y: 2 }
    });
    assert.equal(secondResponse.status, 201);
    const second = await secondResponse.json();
    assert.equal(second.sequence, 2);
    assert.deepEqual(second.payload, { x: 1, y: 2 });
    assert.notEqual(second.id, first.id);

    const getResponse = await fetch(`${baseUrl}/scenarios/${scenario.id}`);
    const updated = await getResponse.json();
    assert.equal(updated.revision, 2);
    assert.deepEqual(updated.events.map(e => e.sequence), [1, 2]);
    assert.deepEqual(updated.events.map(e => e.type), ["started", "moved"]);
  });
});

test("POST /scenarios/:id/events returns a JSON 404 for unknown scenarios", async () => {
  await withServer(async baseUrl => {
    const response = await postJson(`${baseUrl}/scenarios/missing/events`, { type: "x" });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error, "not_found");
  });
});

test("scenarios are isolated from each other", async () => {
  await withServer(async baseUrl => {
    const a = await createScenario(baseUrl, { name: "a" });
    const b = await createScenario(baseUrl, { name: "b" });

    await postJson(`${baseUrl}/scenarios/${a.id}/events`, { type: "one" });
    await postJson(`${baseUrl}/scenarios/${a.id}/events`, { type: "two" });

    const aResponse = await fetch(`${baseUrl}/scenarios/${a.id}`);
    const aState = await aResponse.json();
    assert.equal(aState.revision, 2);
    assert.equal(aState.events.length, 2);

    const bResponse = await fetch(`${baseUrl}/scenarios/${b.id}`);
    const bState = await bResponse.json();
    assert.equal(bState.revision, 0);
    assert.deepEqual(bState.events, []);
  });
});

test("POST /scenarios rejects invalid bodies without writing data", async () => {
  await withServer(async baseUrl => {
    const cases = [
      ["empty body", ""],
      ["malformed JSON", "{not json"],
      ["JSON array", "[]"],
      ["JSON string", '"hello"'],
      ["missing name", { description: "no name" }],
      ["empty name", { name: "" }],
      ["blank name", { name: "   " }],
      ["non-string name", { name: 42 }],
      ["non-string description", { name: "ok", description: 7 }]
    ];

    for (const [label, body] of cases) {
      const response = await postJson(`${baseUrl}/scenarios`, body);
      assert.equal(response.status, 400, label);
      const parsed = await response.json();
      assert.equal(parsed.error, "bad_request", label);
      assert.equal(typeof parsed.message, "string", label);
    }

    const listResponse = await fetch(`${baseUrl}/scenarios`);
    assert.deepEqual(await listResponse.json(), []);
  });
});

test("POST /scenarios rejects non-JSON content types", async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/scenarios`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "nope" })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "bad_request");

    const listResponse = await fetch(`${baseUrl}/scenarios`);
    assert.deepEqual(await listResponse.json(), []);
  });
});

test("POST /scenarios/:id/events rejects invalid bodies without writing data", async () => {
  await withServer(async baseUrl => {
    const scenario = await createScenario(baseUrl, { name: "guarded" });

    const cases = [
      ["empty body", ""],
      ["malformed JSON", "{oops"],
      ["missing type", { payload: {} }],
      ["empty type", { type: "" }],
      ["non-string type", { type: 3 }],
      ["array payload", { type: "ok", payload: [1, 2] }],
      ["string payload", { type: "ok", payload: "nope" }],
      ["null payload", { type: "ok", payload: null }]
    ];

    for (const [label, body] of cases) {
      const response = await postJson(`${baseUrl}/scenarios/${scenario.id}/events`, body);
      assert.equal(response.status, 400, label);
      const parsed = await response.json();
      assert.equal(parsed.error, "bad_request", label);
    }

    const getResponse = await fetch(`${baseUrl}/scenarios/${scenario.id}`);
    const state = await getResponse.json();
    assert.equal(state.revision, 0);
    assert.deepEqual(state.events, []);
  });
});
