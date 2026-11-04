// GET /api/auth/login?return=<review page>  starts GitHub sign-in.

import { randomBytes } from "node:crypto";
import { authorizeUrl, oauthApp } from "../../lib/github.js";
import { failure, returnUrl } from "../../lib/http.js";

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const back = returnUrl(url.searchParams.get("return"));
    const { id } = oauthApp();
    const state = randomBytes(16).toString("hex");
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizeUrl(id, `${url.origin}/api/auth/callback`, state),
        "Set-Cookie": `rq_oauth=${state}.${encodeURIComponent(back)}; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return failure(e);
  }
}
