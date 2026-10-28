import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const CONFIG_DIR = process.env.VREW_CONFIG_DIR || path.join(os.homedir(), ".vrew");
export const CONFIG_PATH = process.env.VREW_CONFIG_PATH || path.join(CONFIG_DIR, "config.json");

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {}
}

// 세션 쿠키는 Windows에서 CurrentUser DPAPI로 감싸 보관한다.
// 다른 OS에서는 0600 파일 권한에만 의존하고, 저장 형식을 config에 남긴다.
function powershell(script, input) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    env,
  });
  if (run.error || run.status !== 0 || !run.stdout) throw new Error("DPAPI 보호/복호화에 실패했습니다.");
  return run.stdout.trim();
}

const ENCRYPT = "$s=ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString $s))";
const DECRYPT = "$s=[Console]::In.ReadToEnd() | ConvertTo-SecureString; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}";

export function protectSecret(value) {
  if (process.platform === "win32") {
    return { protection: "dpapi", value: powershell(ENCRYPT, value) };
  }
  return { protection: "file", value };
}

export function revealSecret(stored, previous) {
  if (!stored) return previous ?? null;
  if (stored.protection === "dpapi") {
    if (process.platform !== "win32") throw new Error("Windows DPAPI로 보관된 세션입니다. 이 OS에서는 다시 로그인하세요.");
    return powershell(DECRYPT, stored.value);
  }
  return stored.value;
}

// 기존 local-vrew-cli(0.1.x) 설정과 호환되게 읽는다.
export function readRefreshCookie(cfg) {
  if (cfg.refreshSecret) return revealSecret(cfg.refreshSecret, null);
  if (cfg.refreshCookie) return cfg.refreshCookie;
  if (cfg.refreshCookieProtected) {
    return revealSecret({ protection: "dpapi", value: cfg.refreshCookieProtected }, null);
  }
  return null;
}

export function writeRefreshCookie(cfg, cookie) {
  const stored = protectSecret(cookie);
  cfg.refreshSecret = stored;
  delete cfg.refreshCookie;
  delete cfg.refreshCookieProtected;
  return cfg;
}
