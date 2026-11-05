const BACKEND_URL = process.env.YAPPAY_BACKEND_URL;
const PREFIX = "/.netlify/functions/api";
const HOP_BY_HOP = new Set([
  "connection", "content-length", "host", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
]);

export default async (request) => {
  if (!BACKEND_URL) {
    return Response.json({ error: "The YapPay API backend is not configured yet." }, { status: 503 });
  }

  const incoming = new URL(request.url);
  const forwardedPath = incoming.pathname.startsWith(PREFIX)
    ? incoming.pathname.slice(PREFIX.length)
    : "";
  const apiPath = `/api${forwardedPath || "/"}`;
  const destination = new URL(apiPath + incoming.search, BACKEND_URL);
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== "accept-encoding") {
      headers.set(name, value);
    }
  }

  try {
    const upstream = await fetch(destination, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: "manual",
    });
    const responseHeaders = new Headers();
    for (const [name, value] of upstream.headers) {
      if (name.toLowerCase() !== "set-cookie" && !HOP_BY_HOP.has(name.toLowerCase())) {
        responseHeaders.append(name, value);
      }
    }
    const cookies = typeof upstream.headers.getSetCookie === "function"
      ? upstream.headers.getSetCookie()
      : (upstream.headers.get("set-cookie") || "").split(/,(?=\s*[^;,=\s]+=[^;,]*)/).filter(Boolean);
    for (const cookie of cookies) responseHeaders.append("set-cookie", cookie);
    const body = [204, 304].includes(upstream.status) ? null : await upstream.arrayBuffer();
    return new Response(body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    console.error("YapPay backend proxy error:", error);
    return Response.json({ error: "Could not reach the YapPay backend. Please try again." }, { status: 502 });
  }
};