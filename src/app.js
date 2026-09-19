import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DECIMAL_INTEGER_PATTERN = /^\d+$/;
const EVENT_QUERY_PARAMS = new Set(["from", "to", "limit", "cursor"]);
const DEFAULT_EVENTS_LIMIT = 50;
const MAX_EVENTS_LIMIT = 100;

// Per-process secret so cursors cannot be forged or tampered with.
const cursorSecret = randomUUID();

function signCursorToken(token) {
  return createHmac("sha256", cursorSecret).update(token).digest("base64url");
}

function parseUtcTimestamp(value) {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    return null;
  }
  return date;
}

function encodeCursor(payload) {
  const token = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${token}.${signCursorToken(token)}`;
}

function decodeCursor(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  const token = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expected = signCursorToken(token);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(data) || data.v !== 1) {
    return null;
  }
  const { sid, from, to, limit, seq, rev } = data;
  if (typeof sid !== "string" || sid.length === 0) {
    return null;
  }
  if (from !== null && typeof from !== "string") {
    return null;
  }
  if (to !== null && typeof to !== "string") {
    return null;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENTS_LIMIT) {
    return null;
  }
  if (!Number.isInteger(seq) || seq < 1) {
    return null;
  }
  if (!Number.isInteger(rev) || rev < 0) {
    return null;
  }
  return { sid, from: from ?? null, to: to ?? null, limit, seq, rev };
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, jsonHeaders);
  response.end(JSON.stringify(value));
}

function badRequest(response, message) {
  sendJson(response, 400, { error: "bad_request", message });
}

function notFound(response, message) {
  sendJson(response, 404, { error: "not_found", message });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function createScenarioStore() {
  return { scenarios: new Map() };
}

export function createApp(store = createScenarioStore()) {
  function isJsonContentType(request) {
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string") {
      return false;
    }
    const mediaType = contentType.split(";")[0].trim().toLowerCase();
    return mediaType === "application/json";
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      request.on("data", chunk => {
        chunks.push(chunk);
        size += chunk.length;
      });
      request.on("end", () => resolve(Buffer.concat(chunks, size).toString("utf8")));
      request.on("error", reject);
    });
  }

  async function readJsonObject(request, response) {
    if (!isJsonContentType(request)) {
      badRequest(response, "Content-Type must be application/json");
      return null;
    }

    const raw = await readBody(request);
    if (raw.length === 0) {
      badRequest(response, "Request body must not be empty");
      return null;
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      badRequest(response, "Request body must be valid JSON");
      return null;
    }

    if (!isPlainObject(body)) {
      badRequest(response, "Request body must be a JSON object");
      return null;
    }

    return body;
  }

  async function createScenario(request, response) {
    const body = await readJsonObject(request, response);
    if (body === null) {
      return;
    }

    if (!isNonEmptyString(body.name)) {
      badRequest(response, "name must be a non-empty string");
      return;
    }
    if (body.description !== undefined && typeof body.description !== "string") {
      badRequest(response, "description must be a string");
      return;
    }

    const scenario = {
      id: randomUUID(),
      name: body.name,
      description: body.description ?? "",
      revision: 0,
      events: [],
      createdAt: new Date().toISOString()
    };
    store.scenarios.set(scenario.id, scenario);
    sendJson(response, 201, scenario);
  }

  async function createBranch(request, response, parentId) {
    const parent = store.scenarios.get(parentId);
    if (!parent) {
      notFound(response, "Scenario not found");
      return;
    }

    const body = await readJsonObject(request, response);
    if (body === null) {
      return;
    }

    if (!isNonEmptyString(body.name)) {
      badRequest(response, "name must be a non-empty string");
      return;
    }
    if (body.description !== undefined && typeof body.description !== "string") {
      badRequest(response, "description must be a string");
      return;
    }
    if (typeof body.fromRevision !== "number" || !Number.isInteger(body.fromRevision)) {
      badRequest(response, "fromRevision must be a decimal integer between 0 and the parent scenario's current revision");
      return;
    }
    if (body.fromRevision < 0 || body.fromRevision > parent.revision) {
      badRequest(response, "fromRevision must be between 0 and the parent scenario's current revision");
      return;
    }

    const fromRevision = body.fromRevision;
    const branch = {
      id: randomUUID(),
      name: body.name,
      description: body.description ?? "",
      revision: fromRevision,
      events: structuredClone(parent.events.slice(0, fromRevision)),
      createdAt: new Date().toISOString(),
      parentScenarioId: parent.id,
      parentRevision: fromRevision
    };
    store.scenarios.set(branch.id, branch);
    sendJson(response, 201, branch);
  }

  function listScenarios(response) {
    sendJson(response, 200, [...store.scenarios.values()]);
  }

  function getScenario(response, id) {
    const scenario = store.scenarios.get(id);
    if (!scenario) {
      notFound(response, "Scenario not found");
      return;
    }
    sendJson(response, 200, scenario);
  }

  async function appendEvent(request, response, id) {
    const scenario = store.scenarios.get(id);
    if (!scenario) {
      notFound(response, "Scenario not found");
      return;
    }

    const body = await readJsonObject(request, response);
    if (body === null) {
      return;
    }

    if (!isNonEmptyString(body.type)) {
      badRequest(response, "type must be a non-empty string");
      return;
    }
    if (body.payload !== undefined && !isPlainObject(body.payload)) {
      badRequest(response, "payload must be a JSON object");
      return;
    }

    let occurredAt;
    if (body.occurredAt === undefined) {
      occurredAt = new Date().toISOString();
    } else {
      const parsed = parseUtcTimestamp(body.occurredAt);
      if (parsed === null) {
        badRequest(response, "occurredAt must be a UTC timestamp formatted as YYYY-MM-DDTHH:mm:ss.SSSZ");
        return;
      }
      const last = scenario.events[scenario.events.length - 1];
      if (last !== undefined && parsed.getTime() < Date.parse(last.occurredAt)) {
        badRequest(response, "occurredAt must not be earlier than the previous event's occurredAt");
        return;
      }
      occurredAt = body.occurredAt;
    }

    const event = {
      id: randomUUID(),
      type: body.type,
      payload: body.payload ?? {},
      occurredAt,
      sequence: scenario.events.length + 1
    };
    scenario.events.push(event);
    scenario.revision += 1;
    sendJson(response, 201, event);
  }

  function readSingleParam(url, name) {
    const values = url.searchParams.getAll(name);
    if (values.length > 1) {
      return { error: `${name} must appear at most once` };
    }
    return { value: values.length === 1 ? values[0] : undefined };
  }

  function listEvents(response, id, url) {
    const scenario = store.scenarios.get(id);
    if (!scenario) {
      notFound(response, "Scenario not found");
      return;
    }

    const paramKeys = new Set(url.searchParams.keys());
    for (const key of paramKeys) {
      if (!EVENT_QUERY_PARAMS.has(key)) {
        badRequest(response, `Unknown query parameter: ${key}`);
        return;
      }
    }

    let fromIso = null;
    let toIso = null;
    let limit = DEFAULT_EVENTS_LIMIT;
    let cursorToken = undefined;

    for (const name of ["from", "to", "limit", "cursor"]) {
      const result = readSingleParam(url, name);
      if (result.error) {
        badRequest(response, result.error);
        return;
      }
      const raw = result.value;
      if (raw === undefined) {
        continue;
      }
      if (raw === "") {
        badRequest(response, `${name} must not be empty`);
        return;
      }
      if (name === "from" || name === "to") {
        const date = parseUtcTimestamp(raw);
        if (date === null) {
          badRequest(response, `${name} must be a UTC timestamp formatted as YYYY-MM-DDTHH:mm:ss.SSSZ`);
          return;
        }
        if (name === "from") {
          fromIso = raw;
        } else {
          toIso = raw;
        }
      } else if (name === "limit") {
        if (!DECIMAL_INTEGER_PATTERN.test(raw) || raw.length > 9) {
          badRequest(response, "limit must be a decimal integer between 1 and 100");
          return;
        }
        limit = Number(raw);
        if (limit < 1 || limit > MAX_EVENTS_LIMIT) {
          badRequest(response, "limit must be a decimal integer between 1 and 100");
          return;
        }
      } else {
        cursorToken = raw;
      }
    }

    if (fromIso !== null && toIso !== null && Date.parse(toIso) < Date.parse(fromIso)) {
      badRequest(response, "to must not be earlier than from");
      return;
    }

    let cursor = null;
    if (cursorToken !== undefined) {
      cursor = decodeCursor(cursorToken);
      if (cursor === null) {
        badRequest(response, "cursor is invalid");
        return;
      }
      if (
        cursor.sid !== id
        || cursor.from !== fromIso
        || cursor.to !== toIso
        || cursor.limit !== limit
      ) {
        badRequest(response, "cursor does not match this query");
        return;
      }
      if (cursor.rev !== scenario.revision) {
        badRequest(response, "cursor is no longer valid because the scenario was modified");
        return;
      }
    }

    const fromTime = fromIso === null ? null : Date.parse(fromIso);
    const toTime = toIso === null ? null : Date.parse(toIso);
    const afterSequence = cursor === null ? 0 : cursor.seq;

    const page = [];
    let nextSequence = 0;
    for (const event of scenario.events) {
      if (event.sequence <= afterSequence) {
        continue;
      }
      const occurredAt = Date.parse(event.occurredAt);
      if (fromTime !== null && occurredAt < fromTime) {
        continue;
      }
      if (toTime !== null && occurredAt > toTime) {
        continue;
      }
      if (page.length === limit) {
        nextSequence = page[page.length - 1].sequence;
        break;
      }
      page.push(event);
    }

    let nextCursor = null;
    if (nextSequence > 0) {
      nextCursor = encodeCursor({
        v: 1,
        sid: id,
        from: fromIso,
        to: toIso,
        limit,
        seq: nextSequence,
        rev: scenario.revision
      });
    }

    sendJson(response, 200, {
      revision: scenario.revision,
      events: page,
      nextCursor
    });
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url ?? "/", "http://branchline.local");
    const segments = url.pathname.split("/");

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "branchline-core",
          version: "0.1.0"
        });
        return;
      }

      if (segments.length === 2 && segments[1] === "scenarios") {
        if (request.method === "POST") {
          await createScenario(request, response);
          return;
        }
        if (request.method === "GET") {
          listScenarios(response);
          return;
        }
      } else if (segments.length === 3 && segments[1] === "scenarios") {
        const id = decodeURIComponent(segments[2]);
        if (request.method === "GET") {
          getScenario(response, id);
          return;
        }
      } else if (segments.length === 4 && segments[1] === "scenarios" && segments[3] === "branches") {
        const id = decodeURIComponent(segments[2]);
        if (request.method === "POST") {
          await createBranch(request, response, id);
          return;
        }
      } else if (segments.length === 4 && segments[1] === "scenarios" && segments[3] === "events") {
        const id = decodeURIComponent(segments[2]);
        if (request.method === "POST") {
          await appendEvent(request, response, id);
          return;
        }
        if (request.method === "GET") {
          listEvents(response, id, url);
          return;
        }
      }

      notFound(response, "Route not found");
    } catch (error) {
      sendJson(response, 500, { error: "internal_error", message: "Internal server error" });
    }
  }

  return { handleRequest };
}

const defaultApp = createApp();

export function handleRequest(request, response) {
  return defaultApp.handleRequest(request, response);
}
