import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { CLIENT_TYPE, post, rotateCookie, ApiError } from "./api.js";
import { CONFIG_PATH, loadConfig, saveConfig, readRefreshCookie, writeRefreshCookie } from "./config.js";

export function jwtClaims(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function jwtUid(token) {
  const claims = jwtClaims(token) || {};
  return claims.user_id || claims.sub || null;
}

export function jwtExp(token) {
  const claims = jwtClaims(token);
  return claims && typeof claims.exp === "number" ? claims.exp * 1000 : null;
}

export function tokenIsValid(token, skewMs = 30_000) {
  const exp = jwtExp(token);
  return exp !== null && exp > Date.now() + skewMs;
}

// 영상·TTS 요청에 쓰는 기기 식별자. Vrew 웹앱과 같은 규칙이며 서버가 이 접두사를 검사한다.
export function apiDeviceIdentity(cid) {
  const key = "try_" + cid;
  return { deviceId: key, deviceName: key, machineId: key.slice(0, 8) };
}

// 세션 갱신에 쓰는 기기 식별자. 데스크톱 앱이 보내는 값과 같은 규칙으로 계산한다.
export function desktopDeviceIdentity() {
  const fallback = { deviceId: "cli_" + os.hostname(), deviceName: os.hostname(), machineId: "cli_" + os.hostname().slice(0, 4) };
  if (process.platform !== "win32") return fallback;
  let guid = "";
  try {
    const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
      encoding: "utf8",
      windowsHide: true,
    });
    guid = (out.match(/MachineGuid\s+REG_SZ\s+(\S+)/) || [])[1] || "";
  } catch {}
  if (!guid) return fallback;
  const digest = crypto.createHash("sha256").update(guid).digest("hex");
  const checksum = crc32(digest).toString(16).padStart(8, "0");
  return { deviceId: digest.padStart(64, "0") + checksum, deviceName: os.hostname(), machineId: crc32(primaryMac()).toString(16) };
}

function crc32(text) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, "utf8")) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function primaryMac() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces).sort()) {
    for (const addr of interfaces[name] || []) {
      if (!addr.internal && addr.mac && addr.mac !== "00:00:00:00:00:00") return addr.mac.toLowerCase();
    }
  }
  return "00:00:00:00:00:00";
}

// ---------------------------------------------------------------- desktop cookie import

export const APP_COOKIE_DB = path.join(process.env.APPDATA || "", "vrew", "Network", "Cookies");

export async function readAppCookies(dbPath = APP_COOKIE_DB) {
  if (process.platform !== "win32") {
    throw new Error("앱 쿠키 가져오기는 Windows에서만 지원합니다. `vrew login --email`을 쓰세요.");
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Vrew 앱 쿠키를 찾을 수 없습니다 (${dbPath}). 데스크톱 앱 설치·로그인을 확인하세요.`);
  }
  const tmp = path.join(os.tmpdir(), `vrew-cli-cookies-${process.pid}-${Date.now()}.db`);
  try {
    fs.copyFileSync(dbPath, tmp);
  } catch (error) {
    if (error?.code === "EBUSY" || error?.code === "EPERM") {
      throw new Error("Vrew 앱이 실행 중입니다. 앱을 완전히 종료한 뒤 다시 시도하세요.");
    }
    throw error;
  }
  try {
    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      throw new Error("이 Node 버전에는 내장 SQLite가 없습니다. Node 22.5 이상이 필요합니다.");
    }
    const db = new DatabaseSync(tmp, { readOnly: true });
    const rows = db.prepare("SELECT host_key, name, value FROM cookies WHERE host_key LIKE '%vrew.ai%'").all();
    db.close();
    const cookies = {};
    for (const row of rows) if (row.value) cookies[row.name] = row.value;
    return cookies;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------------------------------------------------------------- session

export async function signInWithPassword(email, password, { language = "ko" } = {}) {
  const identity = desktopDeviceIdentity();
  const { response, json } = await post("/auth/v2/sign-in", {
    email,
    password,
    clientType: CLIENT_TYPE,
    ...identity,
    language,
    persistSession: true,
  });
  const token = json?.session?.idToken;
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const refresh = setCookies.map((item) => item.split(";")[0]).find((item) => item.startsWith("VREW_RTK="));
  if (!token || !refresh) {
    throw new Error("로그인 응답에 세션이 없습니다. Google/Apple로 가입한 계정이면 `vrew login --import-app-cookie`를 쓰세요.");
  }
  return { idToken: token, cookie: refresh, identity, user: json.user || {} };
}

export async function loginWithAppCookie() {
  const cookies = await readAppCookies();
  if (!cookies.VREW_RTK) throw new Error("VREW_RTK 쿠키가 없습니다. Vrew 앱에 로그인되어 있는지 확인하세요.");
  return { cookie: "VREW_RTK=" + cookies.VREW_RTK, identity: desktopDeviceIdentity() };
}

export async function refreshWithCookie(cookie, identity = desktopDeviceIdentity()) {
  try {
    const { response, json } = await post(
      "/auth/v2/refresh-token",
      {
        clientType: CLIENT_TYPE,
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        machineId: identity.machineId,
        language: "ko",
        refreshFor: "auto_sign_in",
        windowId: 1,
        windowCount: 1,
        clientRequestedAt: new Date().toISOString(),
      },
      { cookie },
    );
    const token = json?.session?.idToken;
    if (!token) {
      throw new ApiError("세션 갱신 응답에 idToken이 없습니다.", {
        code: json?.result === "error" ? "SERVER_REJECTED" : "MISSING_TOKEN",
        status: response.status,
      });
    }
    return { idToken: token, cookie: rotateCookie(response.headers, cookie) };
  } catch (error) {
    // 서버 본문과 원본 오류 메시지는 쿠키·토큰을 포함할 수 있어 출력하지 않는다.
    const known = ["AUTH", "SESSION_ENDED", "SERVER_REJECTED", "MISSING_TOKEN"];
    const code = known.includes(error.code) ? error.code
      : error.name === "TimeoutError" ? "TIMEOUT"
      : error instanceof ApiError ? "HTTP_RESPONSE" : "NETWORK";
    const status = Number.isInteger(error.status) ? error.status : undefined;
    const networkCodes = ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID"];
    const causes = [error, error.cause, ...(Array.isArray(error.cause?.errors) ? error.cause.errors : [])];
    const details = [...new Set(causes.map((cause) => cause?.code).filter((value) => networkCodes.includes(value)))];
    if (error.cause?.message === "unexpected redirect") details.push("REDIRECT_BLOCKED");
    const detail = details.length ? ` [${details.join(", ")}]` : "";
    throw new ApiError(`세션 갱신 실패: ${code}${detail}${status === undefined ? "" : ` (HTTP ${status})`}`, { code, status });
  }
}

export async function refreshSession({ refreshFor = "refresh_token" } = {}) {
  const cfg = loadConfig();
  const cookie = readRefreshCookie(cfg);
  if (!cookie) throw new Error("저장된 갱신 세션이 없습니다. `vrew login`으로 로그인하세요.");
  const identity = cfg.refreshIdentity || desktopDeviceIdentity();
  const { response, json } = await post(
    "/auth/v2/refresh-token",
    {
      clientType: CLIENT_TYPE,
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      machineId: identity.machineId,
      language: cfg.language || "ko",
      refreshFor,
      windowId: 1,
      windowCount: 1,
      clientRequestedAt: new Date().toISOString(),
    },
    { cookie },
  );
  const token = json?.session?.idToken;
  if (!token) throw new Error("세션 갱신 응답에 idToken이 없습니다. `vrew login`으로 다시 로그인하세요.");
  const claims = jwtClaims(token);
  if (cfg.uid && claims?.sub && claims.sub !== cfg.uid) {
    throw new Error("갱신된 계정이 저장된 계정과 다릅니다. 설정을 덮어쓰지 않았습니다.");
  }
  const next = {
    ...cfg,
    idToken: token,
    uid: cfg.uid || claims?.sub,
    authAccount: cfg.authAccount || claims?.email,
    refreshIdentity: identity,
    autoRefresh: true,
    lastRefreshedAt: new Date().toISOString(),
  };
  writeRefreshCookie(next, rotateCookie(response.headers, cookie));
  saveConfig(next);
  return next;
}

export async function getToken({ force = false } = {}) {
  const cfg = loadConfig();
  if (!force && tokenIsValid(cfg.idToken)) return cfg.idToken;
  const next = await refreshSession();
  return next.idToken;
}

export async function verifyToken(token) {
  const { json } = await post("/auth/get-user-info", { clientType: CLIENT_TYPE }, { token });
  const user = json?.user;
  if (!user?.uid) throw new Error("서버에서 계정을 확인하지 못했습니다.");
  return user;
}

export async function saveSession({ cookie, identity, user, idToken, source }) {
  const cfg = loadConfig();
  const next = {
    ...cfg,
    uid: user.uid,
    authAccount: user.email,
    cid: cfg.cid || crypto.randomUUID(),
    refreshIdentity: identity,
    authSource: source,
    autoRefresh: true,
    language: cfg.language || "ko",
  };
  writeRefreshCookie(next, cookie);
  if (idToken) next.idToken = idToken;
  saveConfig(next);
  return next;
}

// 저장된 세션만으로 복구를 시도한다(앱 쿠키 없이).
export async function loginExisting() {
  const cfg = loadConfig();
  if (!readRefreshCookie(cfg)) throw new Error("저장된 세션이 없습니다. `vrew login --import-app-cookie` 또는 `--email`을 쓰세요.");
  const refreshed = await refreshSession({ refreshFor: "auto_sign_in" });
  const user = await verifyToken(refreshed.idToken);
  return { user, source: "existing" };
}

export function logout() {
  fs.rmSync(CONFIG_PATH, { force: true });
}

export { ApiError };
