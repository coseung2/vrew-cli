import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli.js";
import { apiDeviceIdentity, jwtClaims, jwtUid } from "../src/auth.js";
import { dimsFor, durRange, estimateCredits, pickModel } from "../src/models.js";
import { checkGeometry } from "../src/media.js";
import { quoteTTS, selectVoice, voiceList } from "../src/tts.js";

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

test("apiDeviceIdentity: 웹앱과 같은 try_ 접두사", () => {
  assert.deepEqual(apiDeviceIdentity("abc"), { deviceId: "try_abc", deviceName: "try_abc", machineId: "try_abc" });
});

test("jwtUid/jwtClaims: 서명 없이 payload만 해석", () => {
  const payload = Buffer.from(JSON.stringify({ user_id: "u1", sub: "u1" })).toString("base64url");
  const token = `a.${payload}.c`;
  assert.equal(jwtUid(token), "u1");
  assert.equal(jwtClaims(token).sub, "u1");
  assert.equal(jwtUid("not-a-token"), null);
});
