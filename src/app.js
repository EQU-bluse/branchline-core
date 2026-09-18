const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, jsonHeaders);
  response.end(JSON.stringify(value));
}

export function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://branchline.local");

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "branchline-core",
      version: "0.1.0"
    });
    return;
  }

  sendJson(response, 404, {
    error: "not_found",
    message: "Route not found"
  });
}
