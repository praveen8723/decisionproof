import { handleApiRequest } from "../../lib/decisionproof.mjs";

export default async function handler(request) {
  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : await request.text();

  const nodeRequest = {
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers),
    body,
  };

  let status = 200;
  let headers = {};
  let responseBody = "";
  const nodeResponse = {
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      headers = nextHeaders;
    },
    end(value = "") {
      responseBody = value;
    },
  };

  await handleApiRequest(nodeRequest, nodeResponse, new URL(request.url));
  return new Response(responseBody, { status, headers });
}
