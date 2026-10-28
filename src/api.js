export const API_BASE = process.env.VREW_API_BASE || "https://api-release.vrew.ai";
export const APP_VERSION = process.env.VREW_APP_VERSION || "4.8.1";
// Vrew ClientType.DESKTOP_APP = 0, TRY(web) = 1
export const CLIENT_TYPE = Number(process.env.VREW_CLIENT_TYPE ?? 0);
export const AUTH_SCOPE_PREFIX = "vrew-release";

export class ApiError extends Error {
  constructor(message, { code, status, body } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

async function readJson(response, where) {
  const text = await response.text();
  if (response.status === 401) {
    throw new ApiError("인증이 필요합니다 (401). `vrew login`으로 다시 로그인하세요.", { code: "AUTH", status: 401 });
  }
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(`${where} 응답이 JSON이 아닙니다 (HTTP ${response.status}): ${text.slice(0, 200)}`, {
      status: response.status,
    });
  }
  if (!response.ok && json?.result !== "error") {
    throw new ApiError(`${where} 실패 (HTTP ${response.status}): ${JSON.stringify(json).slice(0, 300)}`, {
      status: response.status,
      body: json,
    });
  }
  return json;
}

export async function request(pathname, { method = "GET", body, token, cookie, timeoutMs = 60_000 } = {}) {
  const headers = { "X-Version": APP_VERSION };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = token;
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(API_BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body ?? {}),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { response, json: await readJson(response, pathname) };
}

export const post = (pathname, body, options) => request(pathname, { ...options, method: "POST", body: body ?? {} });
export const get = (pathname, options) => request(pathname, { ...options, method: "GET" });

export function rotateCookie(headers, previous) {
  const list = headers.getSetCookie?.() ?? [headers.get("set-cookie") || ""];
  for (const item of list) {
    const match = item.match(/^VREW_RTK=([^;]*)/);
    if (!match) continue;
    if (!match[1] || /Max-Age=0(?:;|$)/i.test(item)) {
      throw new ApiError("Vrew 갱신 세션이 종료됐습니다. `vrew login`으로 다시 로그인하세요.", { code: "SESSION_ENDED" });
    }
    return "VREW_RTK=" + match[1];
  }
  return previous;
}
