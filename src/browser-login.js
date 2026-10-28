import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

const LOGIN_URL = process.env.VREW_LOGIN_URL || "https://vrew.ai/ko/try/";
const COOKIE_HOSTS = ["https://api-release.vrew.ai/auth/v2/refresh-token", "https://vrew.ai/"];
const BROWSER_CANDIDATES = [
  process.env.VREW_BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/microsoft-edge",
];

export function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function httpJson(url, timeoutMs = 2000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      }
    });
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP 연결 실패")), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 시간 초과: ${method}`));
      }, 10_000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

function vrewCookie(cookies) {
  const match = (cookies || []).find((cookie) => cookie.name === "VREW_RTK" && String(cookie.domain).includes("vrew.ai"));
  return match ? "VREW_RTK=" + match.value : null;
}

async function readCookie(port, version) {
  const targets = await httpJson(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find((item) => item.type === "page" && /vrew\.ai/.test(item.url)) || targets.find((item) => item.type === "page");
  if (!target?.webSocketDebuggerUrl) return null;
  const cdp = await Cdp.open(target.webSocketDebuggerUrl);
  try {
    const result = await cdp.send("Storage.getCookies", {});
    const cookie = vrewCookie(result.cookies);
    if (cookie) return cookie;
    const scoped = await cdp.send("Network.getCookies", { urls: COOKIE_HOSTS });
    return vrewCookie(scoped.cookies);
  } finally {
    cdp.close();
    void version;
  }
}

function killTree(pid) {
  try {
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
  } catch {}
}

// 우리 전용 프로필로 떠 있는 브라우저를 정리한다. 같은 프로필이 이미 실행 중이면
// 새 인스턴스는 디버깅 포트를 열지 않고 기존 인스턴스로 URL만 넘기기 때문이다.
function killProfileBrowsers(profileDir) {
  if (process.platform !== "win32") return;
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" +
    profileDir.replace(/'/g, "''") +
    "*' -and ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try {
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: "ignore", timeout: 15000 });
  } catch {}
}

const debug = (...args) => {
  if (process.env.VREW_DEBUG) process.stderr.write(`[debug] ${args.join(" ")}\n`);
};

/**
 * 브라우저를 띄워 사용자가 직접 로그인하게 하고, 로그인으로 생긴 Vrew 세션 쿠키를 읽어 온다.
 * 열려 있는 창은 사용자가 닫아도 되고, 성공하면 우리가 정리한다.
 */
export async function browserLogin({ onPrompt = () => {}, timeoutMs = 300_000, keepOpen = false } = {}) {
  const executable = findBrowser();
  if (!executable) {
    throw new Error(
      "Chrome 또는 Edge를 찾지 못했습니다. 브라우저를 설치하거나 `vrew login --import-app-cookie` / `--email`을 쓰세요.",
    );
  }
  const port = await freePort();
  const profileDir = path.join(os.homedir(), ".vrew", "browser-profile");
  fs.mkdirSync(profileDir, { recursive: true });
  killProfileBrowsers(profileDir);
  await sleep(300);

  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      LOGIN_URL,
    ],
    { detached: false, stdio: "ignore", windowsHide: false },
  );

  onPrompt({ url: LOGIN_URL, port });

  const deadline = Date.now() + timeoutMs;
  let cookie = null;
  try {
    // 브라우저 디버깅 포트가 열릴 때까지 기다린다.
    while (Date.now() < deadline) {
      try {
        await httpJson(`http://127.0.0.1:${port}/json/version`);
        break;
      } catch {
        await sleep(500);
      }
    }
    while (Date.now() < deadline) {
      try {
        cookie = await readCookie(port);
        if (cookie) debug("VREW_RTK 확인");
        else debug("CDP 연결됨, 로그인 대기 중");
      } catch (error) {
        debug("CDP 대기:", error.message);
        cookie = null;
      }
      if (cookie) break;
      await sleep(1500);
    }
  } finally {
    if (!keepOpen) {
      killTree(child.pid);
      killProfileBrowsers(profileDir);
    }
  }

  if (!cookie) {
    throw new Error("시간 안에 Vrew 로그인을 확인하지 못했습니다. 다시 `vrew login`을 실행해 주세요.");
  }
  return { cookie, url: LOGIN_URL };
}
