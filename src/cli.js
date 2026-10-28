import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CLIENT_TYPE, get, post } from "./api.js";
import {
  getToken,
  verifyToken,
  loginWithAppCookie,
  signInWithPassword,
  saveSession,
  logout,
  jwtUid,
  jwtExp,
  apiDeviceIdentity,
  desktopDeviceIdentity,
  refreshWithCookie,
} from "./auth.js";
import { browserLogin } from "./browser-login.js";
import { CONFIG_PATH, loadConfig } from "./config.js";
import { fetchModels, pickModel, videoModels } from "./models.js";
import { buildPlan, describePlan, submitGeneration, pollGeneration, processUpload } from "./video.js";
import { fetchVoiceCatalog, voiceList, selectVoice, quoteTTS, makeTTS, waitTTS, writeAudio } from "./tts.js";
import { c, confirm, download, printTable, out, progress, timestamp, writeReceipt, updateReceipt } from "./util.js";

// node:sqlite(앱 쿠키 읽기)의 실험 기능 경고만 조용히 넘긴다.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const message = typeof warning === "string" ? warning : warning?.message ?? "";
  if (/SQLite is an experimental feature/i.test(message)) return;
  return emitWarning(warning, ...rest);
};

const BOOLEAN = new Set([  "json",
  "yes",
  "dry-run",
  "no-enhance",
  "no-audio",
  "archive",
  "import-app-cookie",
  "keep-browser",
  "help",
  "version",
]);
const MULTI = new Set(["ref-image", "ref-video", "ref-audio", "start-frame", "end-frame"]);

export function parseArgs(argv) {
  const args = { _: [], audio: undefined };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const key = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
    if (BOOLEAN.has(key)) {
      args[key] = true;
      continue;
    }
    const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
    if (value === undefined) throw new Error(`--${key} 값이 필요합니다.`);
    if (MULTI.has(key)) {
      args[key] = args[key] || [];
      args[key].push(value);
    } else if (key === "audio") {
      args.audio = value !== "false";
    } else {
      args[key] = value;
    }
  }
  return args;
}

async function readSecret(question) {
  if (!process.stdin.isTTY) throw new Error("비밀번호는 대화형 터미널에서 입력하거나 --password 로 넘기세요.");
  process.stderr.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stderr.write("\n");
          return resolve(value);
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          stdin.pause();
          return reject(new Error("취소했습니다."));
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

function printUser(user) {
  const credits = Array.isArray(user.credits)
    ? user.credits.reduce((sum, item) => sum + Number(item.creditBalance ?? 0), 0)
    : null;
  const plan = user.planInfo?.planType ?? user.planType ?? "-";
  process.stdout.write(`email : ${user.email ?? "-"}\n`);
  process.stdout.write(`uid   : ${user.uid ?? "-"}\n`);
  process.stdout.write(`plan  : ${plan}\n`);
  if (credits !== null) process.stdout.write(`credit: ${credits.toFixed(2)}\n`);
  const ttsLimit = user.planInfo?.ttsLimit;
  if (ttsLimit) process.stdout.write(`tts   : ${user.userAccTTSTextMonthly ?? 0}/${ttsLimit} (이번달 글자)\n`);
}

// ---------------------------------------------------------------- commands

async function cmdLogin(args) {
  let result;
  if (args.email) {
    const password = args.password || (await readSecret("Vrew 비밀번호: "));
    const session = await signInWithPassword(args.email, password);
    const user = await verifyToken(session.idToken);
    await saveSession({ ...session, user, source: "password" });
    result = { ok: true, source: "password", account: user.email };
  } else if (args["import-app-cookie"]) {
    const session = await loginWithAppCookie();
    await saveSession({ ...session, user: {}, source: "app-cookie" });
    const refreshed = await getToken({ force: true });
    const user = await verifyToken(refreshed);
    await saveSession({ ...session, user, idToken: refreshed, source: "app-cookie" });
    result = { ok: true, source: "app-cookie", account: user.email };
  } else if (args.cookie) {
    // 브라우저 없이 세션 쿠키만 넘기는 경로(수동 복구용).
    const user = await finishCookieLogin(args.cookie.trim().replace(/^VREW_RTK=/, ""), args.account);
    result = { ok: true, source: "cookie", account: user.email };
  } else {
    if (!args.json) {
      process.stderr.write(c.bold("브라우저에서 Vrew 로그인을 완료해 주세요.") + "\n");
      process.stderr.write(c.dim("  창이 자동으로 열립니다. 로그인이 확인되면 이 명령이 알아서 끝납니다.\n\n"));
    }
    const { cookie } = await browserLogin({
      onPrompt: ({ url }) => {
        if (args.json) return;
        process.stderr.write(c.dim(`  안내 링크: ${url}\n`));
      },
      timeoutMs: Number(args.timeout ?? 300) * 1000,
      keepOpen: Boolean(args["keep-browser"]),
    });
    const user = await finishCookieLogin(cookie.replace(/^VREW_RTK=/, ""), args.account);
    result = { ok: true, source: "browser", account: user.email };
  }
  if (args.json) return out({ ...result, config: CONFIG_PATH });
  process.stdout.write(c.green("로그인 완료") + ` → ${result.account} (${result.source})\n`);
  process.stdout.write(c.dim(`  세션 저장: ${CONFIG_PATH}\n`));
}

// 쿠키를 세션으로 바꿔 저장한다. 웹에서 발급된 쿠키일 수 있으므로 기기 식별자를 바꿔 가며 시도한다.
async function finishCookieLogin(rawCookie, account) {
  const cfg = loadConfig();
  const cookie = "VREW_RTK=" + rawCookie;
  const candidates = [desktopDeviceIdentity(), apiDeviceIdentity(cfg.cid || crypto.randomUUID())];
  let identity = candidates[0];
  let token = null;
  for (const candidate of candidates) {
    try {
      const refreshed = await refreshWithCookie(cookie, candidate);
      token = refreshed.idToken;
      identity = candidate;
      break;
    } catch {}
  }
  if (!token) throw new Error("세션 쿠키로 로그인하지 못했습니다. `vrew login`을 다시 실행해 주세요.");
  const user = await verifyToken(token);
  if (account && String(user.email).toLowerCase() !== String(account).toLowerCase()) {
    throw new Error(`로그인 계정이 --account(${account})와 다릅니다: ${user.email}`);
  }
  await saveSession({ cookie, identity, user, idToken: token, source: "browser" });
  return user;
}

async function cmdWhoami(args) {
  const token = await getToken();
  const user = await verifyToken(token);
  if (args.json) return out({ ok: true, user, expiresAt: new Date(jwtExp(token)).toISOString() });
  printUser(user);
}

async function cmdLogout(args) {
  logout();
  if (args.json) return out({ ok: true, removed: CONFIG_PATH });
  process.stdout.write(`로그아웃 완료 (${CONFIG_PATH} 삭제)\n`);
}

async function cmdModels(args) {
  const catalog = await fetchModels();
  const list = videoModels(catalog);
  if (args.json) return out({ ok: true, models: list });
  printTable(
    list.map((model) => {
      const options = model.generationOptions || {};
      const duration = options.durationSec;
      return {
        id: model.id,
        이름: model.name,
        크레딧: String(model.credits),
        길이: duration ? `${duration.defaultValue ?? duration.values?.[0]}초` : "-",
        해상도: options.resolution ? options.resolution.values.join("/") : "-",
        오디오: options.generateAudio ? "가능" : "-",
        입력: (options.inputModes || []).join(","),
      };
    }),
  );
  process.stdout.write(c.dim("\n--model 에 id 를 그대로 쓰세요.\n"));
}

async function cmdCredits(args) {
  const token = await getToken();
  const user = await verifyToken(token);
  const now = new Date();
  const { json } = await post(
    "/auth/get-credit-history",
    {
      kind: "user",
      from: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
      to: new Date(now.getTime() + 86_400_000).toISOString(),
      timezoneMin: -now.getTimezoneOffset(),
    },
    { token },
  );
  if (args.json) return out({ ok: true, user, history: json });
  printUser(user);
  const items = json.result ?? json.history ?? [];
  if (Array.isArray(items) && items.length) {
    printTable(items.slice(0, 20).map((item) => ({ 날짜: item.createdAt ?? item.date ?? "-", 종류: item.type ?? "-", 금액: item.amount ?? item.credits ?? "-" })));
  }
}

async function cmdGen(args) {
  const prompt = args.prompt || args._[1];
  if (!prompt) throw new Error('프롬프트가 필요합니다.\n  예: vrew gen --prompt "벚꽃 거리, 천천히 걷는 사람" --out a.mp4');
  const catalog = await fetchModels();
  const model = pickModel(catalog, args.model);
  const plan = buildPlan({ catalog, model, args });

  if (!args.json) process.stdout.write(describePlan(plan, prompt) + "\n");
  if (args["dry-run"]) {
    return out({ ok: true, dryRun: true, plan: { ...plan, model, modelName: undefined } });
  }

  const limit = args["max-credits"] !== undefined ? Number(args["max-credits"]) : null;
  if (limit !== null && (!Number.isFinite(limit) || limit < 0)) throw new Error("--max-credits 는 0 이상의 숫자여야 합니다.");
  if (limit !== null && plan.credits > limit) {
    throw new Error(`예상 비용 ${plan.credits} 크레딧이 한도(--max-credits ${limit})를 넘습니다.`);
  }
  if (!args.yes) {
    if (!process.stdin.isTTY) throw new Error("비대화형 실행에서는 --yes 가 필요합니다. (미리보기: --dry-run)");
    const ok = await confirm(`\n${plan.credits} 크레딧을 사용해 생성을 시작할까요? (y/N) `);
    if (!ok) throw new Error("취소했습니다.");
  }

  const outPath = path.resolve(args.out || `vrew-${model.id}-${timestamp()}.mp4`);
  const receiptPath = outPath + ".request.json";
  if (fs.existsSync(outPath) || fs.existsSync(receiptPath)) {
    throw new Error("출력 또는 요청 기록이 이미 있습니다. 재생성 대신 status로 기존 요청을 확인하세요.");
  }

  const token = await getToken();
  const submitted = await submitGeneration({ token, plan, prompt, args });
  writeReceipt(receiptPath, {
    reqId: submitted.reqId,
    model: model.id,
    inputMode: plan.inputMode,
    creditsEstimated: plan.credits,
    status: "submitted",
    createdAt: new Date().toISOString(),
  });
  process.stderr.write(`요청 접수: ${submitted.reqId}\n`);
  if (submitted.fileKey) await processUpload(token, submitted.fileKey);

  progress(args, "생성 중… (보통 30초~3분)");
  const result = await pollGeneration(submitted.reqId, token, args);
  updateReceipt(receiptPath, {
    reqId: submitted.reqId,
    model: model.id,
    creditsEstimated: plan.credits,
    status: result.status,
    createdAt: new Date().toISOString(),
    errorMsg: result.errorMsg,
  });
  if (result.status !== "done") {
    throw new Error(`생성 미완료 (${submitted.reqId}): ${result.status}. status로 확인하세요. ${result.errorMsg ?? ""}`);
  }
  const bytes = await download(result.signedUrl, outPath);
  if (args.json) {
    return out({
      ok: true,
      file: outPath,
      bytes,
      reqId: submitted.reqId,
      sid: result.sid,
      durationSec: result.mediaDurationSec,
      model: model.id,
      inputMode: plan.inputMode,
      creditsEstimated: plan.credits,
      prompt: result.prompt ?? submitted.promptObject,
    });
  }
  process.stdout.write(c.green("완료: ") + outPath + "\n");
  process.stdout.write(c.dim(`  ${(bytes / 1048576).toFixed(2)} MB · ${result.mediaDurationSec ?? plan.durationSec}초 · sid=${result.sid ?? "-"}\n`));
}

async function cmdStatus(args) {
  const reqId = args["req-id"] || args.reqId || args._[1];
  if (!reqId) throw new Error("--req-id 가 필요합니다.");
  const token = await getToken();
  const { json } = await get(`/stock/get-genvideo?reqId=${encodeURIComponent(reqId)}`, { token });
  let file;
  if (args.out && json.status === "done" && json.signedUrl) {
    file = path.resolve(args.out);
    await download(json.signedUrl, file);
  }
  const { signedUrl, ...safe } = json;
  return out({ ok: json.status !== "error", reqId, ...safe, ...(file ? { file } : {}) });
}

async function cmdTts(args) {
  const sub = args._[1] || "voices";
  if (sub === "voices") {
    const catalog = await fetchVoiceCatalog();
    let voices = voiceList(catalog);
    if (args.lang) voices = voices.filter((voice) => voice.lang === args.lang);
    if (args.voice) voices = voices.filter((voice) => voice.speakerId.toLowerCase().includes(String(args.voice).toLowerCase()));
    if (args.json) return out({ ok: true, pricingPolicyVersion: catalog.pricingPolicyVersion, voices });
    printTable(
      voices.slice(0, 200).map((voice) => ({
        provider: voice.provider,
        lang: voice.lang,
        speakerId: voice.speakerId,
        성별: voice.gender ?? "-",
        크레딧: String(voice.creditsPer100Chars ?? "-"),
      })),
    );
    process.stdout.write(c.dim(`\n${voices.length}개\n`));
    return;
  }

  if (sub !== "gen" && sub !== "status") {
    throw new Error("사용법: vrew tts voices | vrew tts gen --voice ID --text-file f.txt --out a.mp3 | vrew tts status --out a.mp3");
  }
  if (!args.out || path.extname(args.out).toLowerCase() !== ".mp3") throw new Error("--out 새 MP3 경로가 필요합니다.");
  const output = path.resolve(args.out);
  const receipt = output + ".request.json";

  if (sub === "status") {
    if (!fs.existsSync(receipt)) throw new Error("요청 기록이 없습니다: " + receipt);
    const record = JSON.parse(fs.readFileSync(receipt, "utf8"));
    if (!record.reqId) throw new Error("접수 여부가 불확실한 기록입니다. 자동 재제출하지 않습니다.");
    const token = await getToken();
    const { bytes, timestamps } = await waitTTS(record.reqId, token);
    writeAudio(output, bytes);
    updateReceipt(receipt, {
      ...record,
      state: "downloaded",
      bytes: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    });
    return out({ ok: true, output, bytes: bytes.length, reqId: record.reqId, timestamps });
  }

  if (!args.voice) throw new Error("--voice 가 필요합니다. `vrew tts voices --lang ko-KR`로 확인하세요.");
  const text = (args.text ?? (args["text-file"] ? fs.readFileSync(args["text-file"], "utf8") : "")).trim().normalize("NFC");
  if (!text) throw new Error("--text 또는 --text-file 이 필요합니다.");
  const catalog = await fetchVoiceCatalog();
  const voice = selectVoice(catalog, args.voice, args.lang ?? "ko-KR");
  const estimate = quoteTTS(text, voice);
  const record = {
    state: "prepared",
    createdAt: new Date().toISOString(),
    voice: voice.speakerId,
    provider: voice.provider,
    lang: voice.lang,
    characters: text.length,
    estimatedCredits: estimate,
    textSha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
  if (args["dry-run"]) return out({ ok: true, dryRun: true, ...record });
  const cap = args["max-credits"] !== undefined ? Number(args["max-credits"]) : null;
  if (!args.yes || cap === null || !Number.isFinite(cap) || estimate > cap) {
    throw new Error(`--yes 와 견적 이상의 --max-credits 가 필요합니다 (견적 ${estimate} 크레딧).`);
  }
  if (fs.existsSync(output) || fs.existsSync(receipt)) throw new Error("기존 출력 또는 요청 기록이 있습니다. status로 복구하세요.");

  const token = await getToken();
  const cfg = loadConfig();
  if (!cfg.uid || cfg.uid !== jwtUid(token)) throw new Error("저장된 계정과 토큰 계정이 다릅니다. `vrew login`을 다시 실행하세요.");
  writeReceipt(receipt, record);
  const made = await makeTTS({ token, voice, text, pricingPolicyVersion: catalog.pricingPolicyVersion, expectedCredits: estimate });
  updateReceipt(receipt, { ...record, state: "accepted", reqId: made.reqId, appliedPricing: made.appliedPricing });

  const { bytes, timestamps } = await waitTTS(made.reqId, token);
  writeAudio(output, bytes);
  updateReceipt(receipt, {
    ...record,
    state: "downloaded",
    reqId: made.reqId,
    appliedPricing: made.appliedPricing,
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    timestamps,
    listening: "not performed",
  });
  return out({ ok: true, output, bytes: bytes.length, reqId: made.reqId, voice: voice.speakerId, estimatedCredits: estimate });
}

// ---------------------------------------------------------------- entry

const HELP = `vrew — Vrew(브루) 영상·TTS CLI (앱·브라우저 없이 실행)

사용법
  vrew login                      브라우저를 열어 Vrew 로그인 → 자동으로 세션 저장
  vrew login --import-app-cookie   설치된 Vrew 앱 세션 가져오기 (앱 종료 필요)
  vrew login --email <이메일>      이메일·비밀번호로 로그인
  vrew login --cookie <VREW_RTK>   세션 쿠키 직접 입력 (수동 복구)
  vrew logout
  vrew whoami
  vrew models
  vrew gen --prompt "설명" [--out a.mp4] [옵션]
  vrew status --req-id <id> [--out a.mp4]
  vrew credits
  vrew tts voices [--lang ko-KR] [--voice <일부>]
  vrew tts gen --voice <id> --text "문장" --out a.mp3 [--dry-run] [--yes --max-credits N]
  vrew tts status --out a.mp3

login 옵션
  --account <이메일>   로그인한 계정이 다르면 실패 처리
  --timeout <초>       브라우저 로그인 대기 시간 (기본 300)
  --keep-browser       로그인 후 브라우저 창을 닫지 않음

gen 옵션
  --model <id>            모델 (vrew models)
  --ratio 16:9|9:16|1:1|4:3|3:4   --resolution 720p|1080p   --duration <초>
  --start-frame <이미지>  i2v 시작 프레임
  --end-frame <이미지>    시작 프레임과 함께
  --ref-image <이미지>    r2v 참조 이미지 (반복 가능)
  --ref-video <영상>      r2v 참조 영상 (반복 가능)
  --ref-audio <오디오>    r2v 참조 오디오 (반복 가능)
  --no-audio              생성 오디오 끄기
  --no-enhance            프롬프트 다듬기 생략
  --dry-run               계획·견적만 확인
  --yes --max-credits N   실제 생성 (비대화형 필수)
  --json                  기계 판독용 JSON

환경 변수
  VREW_CONFIG_PATH   설정 파일 경로 (기본 ~/.vrew/config.json)
  VREW_API_BASE      API 주소 (기본 https://api-release.vrew.ai)
  VREW_APP_VERSION   X-Version 값 (기본 4.8.1)
`;

export async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || args.help || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  switch (command) {
    case "login":
      return cmdLogin(args);
    case "logout":
      return cmdLogout(args);
    case "whoami":
      return cmdWhoami(args);
    case "models":
      return cmdModels(args);
    case "credits":
      return cmdCredits(args);
    case "gen":
      return cmdGen(args);
    case "status":
      return cmdStatus(args);
    case "tts":
      return cmdTts(args);
    case "version":
      process.stdout.write("0.1.0\n");
      return;
    default:
      throw new Error(`알 수 없는 명령입니다: ${command}\n\n` + HELP);
  }
}
