import { handleApiRequest } from "../lib/decisionproof.mjs";

export const config = { maxDuration: 30 };

export default async function handler(request, response) {
  await handleApiRequest(request, response);
}
