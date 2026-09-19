import { randomUUID } from "node:crypto";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 1_000_000;

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, jsonHeaders);
  response.end(JSON.stringify(value));
}

function sendBadRequest(response, message) {
  sendJson(response, 400, { error: "bad_request", message });
}

function sendNotFound(response, message) {
  sendJson(response, 404, { error: "not_found", message });
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function readJsonBody(request) {
  const contentType = request.headers["content-type"];
  if (contentType !== undefined) {
    const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json") {
      return { ok: false, message: "Content-Type must be application/json" };
    }
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      return { ok: false, message: "Request body too large" };
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") {
    return { ok: false, message: "Request body must be a JSON object" };
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: "Request body is not valid JSON" };
  }
  return { ok: true, value };
}

export function createHandler() {
  const scenarios = [];
  const scenariosById = new Map();

  async function handleCreateScenario(request, response) {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendBadRequest(response, body.message);
      return;
    }
    if (!isPlainObject(body.value)) {
      sendBadRequest(response, "Request body must be a JSON object");
      return;
    }
    if (!isNonEmptyString(body.value.name)) {
      sendBadRequest(response, 'Field "name" is required and must be a non-empty string');
      return;
    }
    if (body.value.description !== undefined && typeof body.value.description !== "string") {
      sendBadRequest(response, 'Field "description" must be a string');
      return;
    }

    const scenario = {
      id: randomUUID(),
      name: body.value.name,
      description: body.value.description ?? "",
      revision: 0,
      events: [],
      createdAt: new Date().toISOString()
    };
    scenarios.push(scenario);
    scenariosById.set(scenario.id, scenario);
    sendJson(response, 201, scenario);
  }

  async function handleCreateEvent(request, response, scenario) {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendBadRequest(response, body.message);
      return;
    }
    if (!isPlainObject(body.value)) {
      sendBadRequest(response, "Request body must be a JSON object");
      return;
    }
    if (!isNonEmptyString(body.value.type)) {
      sendBadRequest(response, 'Field "type" is required and must be a non-empty string');
      return;
    }
    if (body.value.payload !== undefined && !isPlainObject(body.value.payload)) {
      sendBadRequest(response, 'Field "payload" must be a JSON object');
      return;
    }

    const event = {
      id: randomUUID(),
      type: body.value.type,
      payload: body.value.payload ?? {},
      occurredAt: new Date().toISOString(),
      sequence: scenario.events.length + 1
    };
    scenario.events.push(event);
    scenario.revision += 1;
    sendJson(response, 201, event);
  }

  function findScenario(idSegment) {
    try {
      return scenariosById.get(decodeURIComponent(idSegment));
    } catch {
      return undefined;
    }
  }

  return async function handleRequest(request, response) {
    const url = new URL(request.url ?? "/", "http://branchline.local");
    const pathname = url.pathname;

    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        service: "branchline-core",
        version: "0.1.0"
      });
      return;
    }

    if (pathname === "/scenarios") {
      if (request.method === "POST") {
        await handleCreateScenario(request, response);
        return;
      }
      if (request.method === "GET") {
        sendJson(response, 200, scenarios);
        return;
      }
    }

    const scenarioMatch = pathname.match(/^\/scenarios\/([^/]+)(\/events)?$/);
    if (scenarioMatch) {
      const scenario = findScenario(scenarioMatch[1]);
      if (!scenario) {
        sendNotFound(response, "Scenario not found");
        return;
      }
      if (!scenarioMatch[2] && request.method === "GET") {
        sendJson(response, 200, scenario);
        return;
      }
      if (scenarioMatch[2] === "/events" && request.method === "POST") {
        await handleCreateEvent(request, response, scenario);
        return;
      }
    }

    sendNotFound(response, "Route not found");
  };
}

export const handleRequest = createHandler();
