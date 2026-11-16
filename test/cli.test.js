import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli.js";
import { apiDeviceIdentity, jwtClaims, jwtUid, refreshWithCookie } from "../src/auth.js";
import { dimsFor, durRange, estimateCredits, modeDurRange, modeSpec, nearestRatio, pickModel, sourceDurationError } from "../src/models.js";
import { buildPlan } from "../src/video.js";
import { checkGeometry } from "../src/media.js";
import { quoteTTS, resolveVoiceSetting, selectVoice, voiceList } from "../src/tts.js";

test("parseArgs: 반복 첨부와 불리언, = 표기", () => {
  const args = parseArgs([
    "gen",
    "--prompt",
    "hello",
    "--ref-image",
    "a.png",
    "--ref-image",
    "b.png",
    "--no-audio",
    "--max-credits=50",
    "--json",
  ]);
  assert.deepEqual(args._, ["gen"]);
  assert.equal(args.prompt, "hello");
  assert.deepEqual(args["ref-image"], ["a.png", "b.png"]);
  assert.equal(args["no-audio"], true);
  assert.equal(args["max-credits"], "50");
  assert.equal(args.json, true);
});

test("parseArgs: 값 누락은 오류", () => {
  assert.throws(() => parseArgs(["gen", "--prompt"]), /값이 필요합니다/);
});

test("dimsFor: 비율·해상도", () => {
  assert.deepEqual(dimsFor("16:9", "720p"), { width: 1280, height: 720 });
  assert.deepEqual(dimsFor("9:16", "1080p"), { width: 1080, height: 1920 });
});

test("estimateCredits: 오디오·영상 입력 요율", () => {
  const model = {
    generationOptions: { durationSec: { defaultValue: 5 } },
    creditPricing: {
      rates: { "720p": { audioOff: 20, audioOn: 30, videoInput: { audioOff: 40, audioOn: 50 } } },
    },
  };
  assert.equal(estimateCredits(model, { resolution: "720p", generateAudio: false }).credits, 100);
  assert.equal(estimateCredits(model, { resolution: "720p", generateAudio: true }).credits, 150);
  assert.equal(
    estimateCredits(model, { resolution: "720p", generateAudio: false, hasVideoInput: true }).credits,
    200,
  );
  assert.throws(() => estimateCredits({ generationOptions: {} }, { resolution: "720p", generateAudio: false }), /요율/);
});

test("durRange: values 목록과 범위", () => {
  assert.deepEqual(durRange({ generationOptions: { durationSec: { values: [4, 6, 8] } } }), {
    min: 4,
    max: 8,
    def: 4,
    values: [4, 6, 8],
  });
  assert.deepEqual(durRange({ videoSecRange: { min: 5, max: 5 } }), { min: 5, max: 5, def: 5 });
});

test("pickModel: id·name·부분 일치", () => {
  const catalog = { genVideoModels: [{ id: "Seedance_2_0_Mini", name: "Seedance 2.0 Mini" }] };
  assert.equal(pickModel(catalog, "seedance_2_0_mini").id, "Seedance_2_0_Mini");
  assert.equal(pickModel(catalog, "Mini").id, "Seedance_2_0_Mini");
  assert.throws(() => pickModel(catalog, "nope"), /모델을 찾을 수 없습니다/);
});

test("checkGeometry: 경계값과 종횡비", () => {
  const geometry = { widthPx: { min: 300, max: 6000 }, heightPx: { min: 300, max: 6000 }, aspectRatio: { min: 0.4, max: 2.5 } };
  assert.equal(checkGeometry(geometry, 1280, 720, "img"), null);
  assert.match(checkGeometry(geometry, 200, 720, "img"), /가로/);
  assert.match(checkGeometry(geometry, 4000, 400, "img"), /종횡비/);
});

test("selectVoice: 식별자와 언어가 유일해야 한다", () => {
  const catalog = {
    allVoices: {
      kt: { "vos-male28": { provider: "kt", speakerId: "vos-male28", lang: "ko-KR", name: "vos-male28" } },
      gemini: { Charon: { provider: "gemini", speakerId: "Chirp3-HD-Charon", lang: "ko-KR", name: "Charon" } },
    },
  };
  assert.equal(selectVoice(catalog, "vos-male28", "ko-KR").provider, "kt");
  assert.equal(voiceList(catalog).length, 2);
  assert.throws(() => selectVoice(catalog, "vos-male28", "en-US"), /일치해야/);
});

test("quoteTTS: 100자 올림 견적", () => {
  assert.equal(quoteTTS("가".repeat(1), { creditsPer100Chars: 3 }), 3);
  assert.equal(quoteTTS("가".repeat(101), { creditsPer100Chars: 3 }), 6);
  assert.throws(() => quoteTTS("   ", { creditsPer100Chars: 3 }), /1~10000자/);
  assert.throws(() => quoteTTS("가".repeat(10_001), { creditsPer100Chars: 3 }), /1~10000자/);
});

test("resolveVoiceSetting: 목소리별 기본값", () => {
  const rich = { speakerId: "rich", emotions: ["neutral", "happy"], actingOptions: ["auto", "talk"], versions: ["v2", "v1"] };
  assert.deepEqual(resolveVoiceSetting(rich), {
    emotion: "neutral", emotionIntensity: 1, acting: "auto", version: "v2", speed: 0, pitch: 0, volume: 0,
  });
  const bare = { speakerId: "bare", emotions: ["happy", "sad"], actingOptions: ["talk"] };
  const setting = resolveVoiceSetting(bare);
  assert.equal(setting.emotion, "happy", "neutral이 없으면 첫 감정");
  assert.equal(setting.acting, "talk", "auto가 없으면 첫 연기");
  assert.equal(setting.version, "v1", "versions가 없으면 v1");
  assert.equal(resolveVoiceSetting({ speakerId: "none" }).emotion, "neutral");
});

test("resolveVoiceSetting: 지정값 검증과 숫자 변환", () => {
  const voice = { speakerId: "vos", emotions: ["neutral", "happy"], actingOptions: ["auto"], versions: ["v1"] };
  const setting = resolveVoiceSetting(voice, { emotion: "happy", acting: "auto", "tts-version": "v1", intensity: "2", speed: "1.2", pitch: "-1" });
  assert.equal(setting.emotion, "happy");
  assert.equal(setting.emotionIntensity, 2);
  assert.equal(setting.speed, 1.2);
  assert.equal(setting.pitch, -1);
  assert.equal(setting.volume, 0);
  assert.throws(() => resolveVoiceSetting(voice, { emotion: "angry" }), /감정/);
  assert.throws(() => resolveVoiceSetting(voice, { "tts-version": "v9" }), /버전/);
  assert.throws(() => resolveVoiceSetting(voice, { speed: "빠르게" }), /숫자/);
});

test("apiDeviceIdentity: 웹앱과 같은 try_ 접두사", () => {
  assert.deepEqual(apiDeviceIdentity("abc"), { deviceId: "try_abc", deviceName: "try_abc", machineId: "try_abc" });
});

test("refreshWithCookie: 새 갱신 쿠키 반환", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ session: { idToken: "test-token" } }), {
    headers: { "Set-Cookie": "VREW_RTK=rotated; HttpOnly; Secure" },
  }));
  assert.deepEqual(await refreshWithCookie("VREW_RTK=old", apiDeviceIdentity("test")), {
    idToken: "test-token", cookie: "VREW_RTK=rotated",
  });
});

for (const [status, body, code] of [
  [401, { secret: "private-cookie" }, "AUTH"],
  [403, { secret: "private-cookie" }, "HTTP_RESPONSE"],
  [200, { result: "error", message: "private-cookie" }, "SERVER_REJECTED"],
  [200, { secret: "private-cookie" }, "MISSING_TOKEN"],
]) {
  test(`refreshWithCookie: ${status}/${code} 민감정보 제외`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status }));
    await assert.rejects(refreshWithCookie("VREW_RTK=private-cookie", apiDeviceIdentity("test")), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes("private-cookie"));
      assert.equal(error.body, undefined);
      return true;
    });
  });
}

for (const name of ["TypeError", "TimeoutError"]) {
  test(`refreshWithCookie: ${name} 안전한 진단`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      const error = new Error("private-cookie");
      error.name = name;
      throw error;
    });
    await assert.rejects(refreshWithCookie("VREW_RTK=private-cookie", apiDeviceIdentity("test")), (error) => {
      assert.equal(error.code, name === "TimeoutError" ? "TIMEOUT" : "NETWORK");
      assert.ok(!error.message.includes("private-cookie"));
      return true;
    });
  });
}

test("refreshWithCookie: TLS 원인 코드만 공개", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    const cause = Object.assign(new Error("private-cookie"), { code: "CERT_HAS_EXPIRED" });
    throw new TypeError("fetch failed", { cause });
  });
  await assert.rejects(refreshWithCookie("VREW_RTK=private-cookie", apiDeviceIdentity("test")), (error) => {
    assert.match(error.message, /NETWORK \[CERT_HAS_EXPIRED\]/);
    assert.ok(!error.message.includes("private-cookie"));
    return true;
  });
});

test("jwtUid/jwtClaims: 서명 없이 payload만 해석", () => {
  const payload = Buffer.from(JSON.stringify({ user_id: "u1", sub: "u1" })).toString("base64url");
  const token = `a.${payload}.c`;
  assert.equal(jwtUid(token), "u1");
  assert.equal(jwtClaims(token).sub, "u1");
  assert.equal(jwtUid("not-a-token"), null);
});

// ---- 연장(extend) 입력

const EXTEND_MODEL = {
  id: "M",
  name: "M",
  generationOptions: {
    durationSec: { min: 3, max: 15, defaultValue: 5 },
    resolution: { values: ["720p"], defaultValue: "720p" },
    aspectRatio: { values: ["16:9", "9:16"], defaultValue: "16:9" },
    referenceImages: { maxCount: 10, mimeTypes: ["image/png"], inputModes: ["reference", "edit"] },
    referenceVideos: { maxCount: 1, mimeTypes: ["video/mp4"], inputModes: ["reference", "edit", "extend"], minDurationSec: 1, maxDurationSec: 15, maxTotalDurationSec: 15 },
    inputModes: ["frame", "reference", "edit", "extend"],
    inputModeRules: {
      edit: { durationSec: { type: "source" }, aspectRatio: { type: "source" } },
      extend: { aspectRatio: { type: "source" }, durationSecOption: { min: 3, max: 10, defaultValue: 5 } },
    },
  },
  creditPricing: { rates: { "720p": { audioOff: 35, audioOn: 35, videoInput: { audioOff: 40, audioOn: 40 } } } },
};

test("modeDurRange: 방식별 길이 규칙", () => {
  assert.deepEqual(modeDurRange(EXTEND_MODEL, "extend"), { min: 3, max: 10, def: 5, values: undefined });
  assert.equal(modeDurRange(EXTEND_MODEL, "frame").max, 15);
  assert.deepEqual(modeDurRange(EXTEND_MODEL, "edit", 7.9), { min: 7, max: 7, def: 7, values: undefined, locked: true });
  // 규칙이 없는 방식은 모델 기본 범위
  assert.equal(modeDurRange(EXTEND_MODEL, "reference").max, 15);
});

test("modeSpec: 방식에 따라 첨부 종류를 막는다", () => {
  const options = EXTEND_MODEL.generationOptions;
  assert.equal(modeSpec(options, "referenceImages", "extend"), undefined);
  assert.equal(modeSpec(options, "referenceImages", "reference"), options.referenceImages);
  assert.equal(modeSpec(options, "referenceVideos", "extend"), options.referenceVideos);
});

test("nearestRatio: 원본 영상에 가장 가까운 비율", () => {
  assert.equal(nearestRatio(720, 1280, ["16:9", "9:16"], "16:9"), "9:16");
  assert.equal(nearestRatio(1920, 1080, ["16:9", "4:3", "1:1"], "16:9"), "16:9");
  assert.equal(nearestRatio(1000, 1000, ["16:9", "4:3", "1:1"], "16:9"), "1:1");
  assert.equal(nearestRatio(null, null, ["16:9"], "16:9"), "16:9");
});

test("sourceDurationError: 원본은 최대 길이보다 1초 이상 짧아야 한다", () => {
  const spec = { minDurationSec: 1, maxDurationSec: 15 };
  assert.equal(sourceDurationError(14.9, spec), null);
  assert.match(sourceDurationError(15.0, spec), /15초 미만/);
  assert.match(sourceDurationError(0.5, spec), /최소 1초/);
  assert.equal(sourceDurationError(null, spec), null);
});

test("buildPlan: 연장 입력은 길이 범위·함께 쓸 수 없는 옵션을 검사한다", () => {
  const plan = (args) => buildPlan({ model: EXTEND_MODEL, args });
  assert.throws(() => plan({ extend: "a.mp4", "start-frame": ["s.png"] }), /함께 쓸 수 없습니다/);
  assert.throws(() => plan({ extend: "a.mp4", "ref-image": ["r.png"] }), /'extend' 입력에서 참조 이미지/);
  const noExtend = { ...EXTEND_MODEL, generationOptions: { ...EXTEND_MODEL.generationOptions, inputModes: ["frame", "reference"] } };
  assert.throws(() => buildPlan({ model: noExtend, args: { extend: "a.mp4" } }), /'extend' 입력을 지원하지 않습니다/);
  // 연장이 아닌 기존 경로는 그대로
  const frame = plan({ duration: "12" });
  assert.equal(frame.inputMode, "frame");
  assert.equal(frame.durationSec, 12);
  assert.deepEqual(frame.sourceVideo, []);
});
