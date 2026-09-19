import { randomUUID } from "node:crypto";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

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

    const event = {
      id: randomUUID(),
      type: body.type,
      payload: body.payload ?? {},
      occurredAt: new Date().toISOString(),
      sequence: scenario.events.length + 1
    };
    scenario.events.push(event);
    scenario.revision += 1;
    sendJson(response, 201, event);
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
      } else if (segments.length === 4 && segments[1] === "scenarios" && segments[3] === "events") {
        const id = decodeURIComponent(segments[2]);
        if (request.method === "POST") {
          await appendEvent(request, response, id);
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
