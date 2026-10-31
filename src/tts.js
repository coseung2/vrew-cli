import fs from "node:fs";
import { get, post } from "./api.js";
import { CLIENT_TYPE } from "./api.js";
import { apiDeviceIdentity, jwtUid } from "./auth.js";
import { loadConfig } from "./config.js";
import { sleep } from "./util.js";

export function voiceList(catalog) {
  return Object.values(catalog.allVoices ?? {}).flatMap((group) => Object.values(group ?? {}));
}

export function selectVoice(catalog, id, lang = "ko-KR") {
  const matches = voiceList(catalog).filter((voice) => voice.speakerId === id && voice.lang === lang);
  if (matches.length !== 1) {
    const available = voiceList(catalog)
      .filter((voice) => voice.lang === lang)
      .map((voice) => voice.speakerId)
      .slice(0, 40)
      .join(", ");
    throw new Error(`목소리 식별자와 언어가 유일하게 일치해야 합니다: ${id} / ${lang}\n예: ${available}`);
  }
  return matches[0];
}

export async function fetchVoiceCatalog() {
  const { json } = await get("/operator/tts-voice-list-v2");
  return json.result ?? json;
}

export function quoteTTS(text, voice) {
  if (!text.trim() || text.length > 10_000) throw new Error("원고는 1~10000자여야 합니다.");
  if (!Number.isFinite(voice.creditsPer100Chars)) throw new Error("음성 요율 정보가 없어 견적을 낼 수 없습니다.");
  return Math.ceil(text.length / 100) * voice.creditsPer100Chars;
}

// Per-voice delivery settings. Defaults follow the app: each voice's own version, "auto" acting when
// offered, "neutral" emotion when offered. Explicit values must be ones the voice lists.
export function resolveVoiceSetting(voice, opts = {}) {
  const pick = (value, allowed, fallback, label) => {
    if (value === undefined) return fallback;
    if (allowed?.length && !allowed.includes(value)) {
      throw new Error(`${voice.speakerId}의 ${label} 값은 ${allowed.join(", ")} 중 하나여야 합니다: ${value}`);
    }
    return value;
  };
  const num = (value, label) => {
    if (value === undefined) return 0;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${label}은 숫자여야 합니다: ${value}`);
    return n;
  };
  const emotions = voice.emotions ?? [];
  const acting = voice.actingOptions ?? [];
  return {
    emotion: pick(opts.emotion, emotions, emotions.includes("neutral") || !emotions.length ? "neutral" : emotions[0], "감정"),
    emotionIntensity: opts.intensity === undefined ? 1 : num(opts.intensity, "감정 강도"),
    acting: pick(opts.acting, acting, acting.includes("auto") || !acting.length ? "auto" : acting[0], "연기"),
    version: pick(opts["tts-version"], voice.versions, voice.versions?.[0] ?? "v1", "버전"),
    speed: num(opts.speed, "속도"),
    pitch: num(opts.pitch, "높낮이"),
    volume: num(opts.volume, "음량"),
  };
}

export async function makeTTS({ token, voice, text, setting, pricingPolicyVersion, expectedCredits }) {
  const cfg = loadConfig();
  const uid = jwtUid(token);
  if (!cfg.cid) throw new Error("기기 식별자(cid)가 없습니다. `vrew login`을 다시 실행하세요.");
  const body = {
    requestType: 1,
    speakerInfo: { provider: voice.provider, lang: voice.lang, name: voice.name, speakerId: voice.speakerId },
    userInfo: { cid: cfg.cid, uid, clientType: CLIENT_TYPE, ...apiDeviceIdentity(cfg.cid) },
    infos: [
      {
        text,
        textAspectLang: voice.lang,
        ...(setting ?? resolveVoiceSetting(voice)),
      },
    ],
  };
  if (pricingPolicyVersion) body.expectedPricing = { pricingPolicyVersion, discountPolicyVersion: null };
  const { json } = await post("/operator/make-tts", body, { token });
  if (json.result !== "success" || !json.reqId) {
    throw new Error("TTS 접수 실패: " + String(json.errorType ?? json.result ?? json.msg) + ". 자동 재요청하지 않습니다.");
  }
  return { reqId: json.reqId, appliedPricing: json.appliedPricing, expectedCredits };
}

export async function waitTTS(reqId, token, { attempts = 120, intervalMs = 2500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const { json } = await post(
      "/operator/get-tts",
      { reqId, timezoneMin: -new Date().getTimezoneOffset() },
      { token },
    );
    if (json.result === "pending") {
      await sleep(intervalMs);
      continue;
    }
    if (json.result !== "success" || !Array.isArray(json.ttsDatas?.[0]?.audioData)) {
      throw new Error("TTS 결과 실패: " + String(json.errorType ?? json.ttsDatas?.[0]?.errorType ?? json.result));
    }
    const audio = json.ttsDatas[0].audioData;
    if (!audio.length || audio.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new Error("잘못된 오디오 바이트입니다.");
    }
    return { bytes: Buffer.from(audio), timestamps: json.ttsDatas[0].timestamps };
  }
  throw new Error("대기 시간 종료. 같은 출력 경로로 `vrew tts status`를 실행하세요.");
}

export function writeAudio(file, bytes) {
  if (fs.existsSync(file)) throw new Error("기존 음성 파일은 덮어쓰지 않습니다.");
  fs.writeFileSync(file, bytes, { flag: "wx" });
}
