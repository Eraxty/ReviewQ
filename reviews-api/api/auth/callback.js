// GET /api/auth/callback?code&state  where GitHub sends people back. The token
// goes to the review page in the URL fragment, which never reaches a server,
// and the page moves it into localStorage straight away.

import { exchangeCode } from "../../lib/github.js";
import { returnUrl } from "../../lib/http.js";

function redirect(to, hash) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${to}#${hash}`,
      "Set-Cookie": "rq_oauth=; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request) {
  const url = new URL(request.url);
  const cookie = (request.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith("rq_oauth="));
  // "<state>.<return url>"; the state is hex, so the first dot splits them.
  const raw = cookie ? cookie.slice("rq_oauth=".length) : "";
  const dot = raw.indexOf(".");
  const state = dot > 0 ? raw.slice(0, dot) : "";
  const back = dot > 0 ? raw.slice(dot + 1) : "";
  let to;
  try {
    to = returnUrl(decodeURIComponent(back));
  } catch {
    to = returnUrl(null);
  }
  if (!state || url.searchParams.get("state") !== state) return redirect(to, "gh_error=expired");
  if (url.searchParams.get("error") || !url.searchParams.get("code")) return redirect(to, "gh_error=denied");
  try {
    const token = await exchangeCode(url.searchParams.get("code"), `${url.origin}/api/auth/callback`);
    return redirect(to, `gh_token=${encodeURIComponent(token)}`);
  } catch {
    return redirect(to, "gh_error=failed");
  }
}
