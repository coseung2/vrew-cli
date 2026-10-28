import fs from "node:fs";
import path from "node:path";
import { get, post } from "./api.js";
import { CLIENT_TYPE } from "./api.js";
import { apiDeviceIdentity, jwtUid } from "./auth.js";
import { loadConfig } from "./config.js";
import { validateAttachment } from "./media.js";
import { dimsFor, durRange, estimateCredits } from "./models.js";
import { c, progress, sleep } from "./util.js";

const POLL = { initialDelayMs: 10_000, intervalMs: 5_000, maxAttempts: 60, deadlineMs: 9 * 60_000 };

const IMAGE_MIME = ["image/png", "image/jpeg", "image/webp"];

// 구형 모델은 generationOptions.startFrameImage 없이 startFrameAspectRatioMode 로만
// 시작 프레임 지원을 알린다. 두 표기를 모두 인정한다.
function startFrameSpec(model) {
  const options = model.generationOptions || {};
  if (options.startFrameImage) return options.startFrameImage;
  if (model.startFrameAspectRatioMode) return { mimeTypes: IMAGE_MIME, maxBytes: 20_000_000 };
  return undefined;
}

export function buildPlan({ catalog, model, args }) {
  const options = model.generationOptions || {};
  const ratio = args.ratio || options.aspectRatio?.defaultValue || "16:9";
  if (options.aspectRatio && !options.aspectRatio.values.includes(ratio)) {
    throw new Error(`이 모델은 ${ratio} 비율을 지원하지 않습니다. 가능: ${options.aspectRatio.values.join(", ")}`);
  }
  const resolution = args.resolution || options.resolution?.defaultValue || "720p";
  if (options.resolution && !options.resolution.values.includes(resolution)) {
    throw new Error(`이 모델은 ${resolution} 해상도를 지원하지 않습니다. 가능: ${options.resolution.values.join(", ")}`);
  }
  const range = durRange(model);
  const supportsDuration = range.min !== undefined;
  const durationSec = args.duration ? Number(args.duration) : supportsDuration ? range.def : undefined;
  if (supportsDuration) {
    const allowed = range.values && range.values.length ? range.values.includes(durationSec) : durationSec >= range.min && durationSec <= range.max;
    if (!Number.isFinite(durationSec) || durationSec <= 0 || !allowed) {
      throw new Error(`이 모델의 길이는 ${range.values?.join("/") || `${range.min}~${range.max}`}초입니다.`);
    }
  } else if (args.duration) {
    throw new Error("이 모델은 길이를 직접 지정할 수 없습니다 (고정 길이).");
  }
  const generateAudio = args.audio === false || args["no-audio"] ? false : true;

  const referenceImages = (args["ref-image"] || []).map((file) => validateAttachment(options.referenceImages, file, "참조 이미지"));
  const referenceVideos = (args["ref-video"] || []).map((file) => validateAttachment(options.referenceVideos, file, "참조 영상"));
  const referenceAudios = (args["ref-audio"] || []).map((file) => validateAttachment(options.referenceAudios, file, "참조 오디오"));
  const startFrame = (args["start-frame"] || []).slice(0, 1).map((file) => validateAttachment(startFrameSpec(model), file, "시작 프레임"));
  const endFrame = (args["end-frame"] || []).slice(0, 1).map((file) => validateAttachment(options.endFrameImage, file, "끝 프레임"));

  if (endFrame.length && !startFrame.length) throw new Error("--end-frame 은 --start-frame 과 함께 써야 합니다.");
  if (options.referenceImages?.maxCount && referenceImages.length > options.referenceImages.maxCount) {
    throw new Error(`참조 이미지는 최대 ${options.referenceImages.maxCount}개입니다.`);
  }
  if (options.referenceVideos?.maxCount && referenceVideos.length > options.referenceVideos.maxCount) {
    throw new Error(`참조 영상은 최대 ${options.referenceVideos.maxCount}개입니다.`);
  }
  if (options.referenceAudios?.maxCount && referenceAudios.length > options.referenceAudios.maxCount) {
    throw new Error(`참조 오디오는 최대 ${options.referenceAudios.maxCount}개입니다.`);
  }
  const totalReferenceVideoSec = referenceVideos.reduce((sum, item) => sum + (item.durationSec || 0), 0);
  if (options.referenceVideos?.maxTotalDurationSec && totalReferenceVideoSec > options.referenceVideos.maxTotalDurationSec) {
    throw new Error(`참조 영상 총 길이 ${totalReferenceVideoSec.toFixed(1)}초 — 최대 ${options.referenceVideos.maxTotalDurationSec}초`);
  }

  const hasReferences = referenceImages.length + referenceVideos.length + referenceAudios.length > 0;
  const inputMode = hasReferences ? "reference" : "frame";
  const inputModes = options.inputModes || ["frame"];
  if (!inputModes.includes(inputMode)) {
    throw new Error(`이 모델은 '${inputMode}' 입력을 지원하지 않습니다. 가능: ${inputModes.join(", ")}`);
  }

  const { width, height } = args.width && args.height ? { width: Number(args.width), height: Number(args.height) } : dimsFor(ratio, resolution);
  const estimate = estimateCredits(model, {
    durationSec,
    resolution,
    generateAudio,
    archive: Boolean(args.archive),
    hasVideoInput: referenceVideos.length > 0,
  });

  return {
    model,
    modelId: model.id,
    modelName: model.name,
    ratio,
    resolution,
    width,
    height,
    durationSec,
    generateAudio,
    supportsDuration,
    inputMode,
    startFrame,
    endFrame,
    referenceImages,
    referenceVideos,
    referenceAudios,
    inputs: { referenceImages: Boolean(options.referenceImages), startFrame: Boolean(options.startFrameImage) },
    credits: estimate.credits,
    creditBasis: estimate.basis,
  };
}

export function describePlan(plan, prompt) {
  const lines = [
    `${c.bold("모델")}      ${plan.modelName} ${c.dim("(" + plan.modelId + ")")}`,
    `${c.bold("프롬프트")}  ${prompt}`,
    `${c.bold("비율/크기")} ${plan.ratio} → ${plan.width}×${plan.height} (${plan.resolution})`,
    `${c.bold("길이")}      ${plan.durationSec === undefined ? "모델 고정" : plan.durationSec + "초"} · 오디오 ${plan.generateAudio ? "포함" : "없음"}`,
    `${c.bold("입력")}      ${plan.inputMode}`,
    `${c.bold("예상 비용")} ${c.yellow(plan.credits + " 크레딧")} ${c.dim("(" + plan.creditBasis + ")")}`,
  ];
  const attachments = [
    ...plan.startFrame.map((item) => `시작 프레임 ${path.basename(item.file)}`),
    ...plan.endFrame.map((item) => `끝 프레임 ${path.basename(item.file)}`),
    ...plan.referenceImages.map((item) => `참조 이미지 ${path.basename(item.file)}`),
    ...plan.referenceVideos.map((item) => `참조 영상 ${path.basename(item.file)}`),
    ...plan.referenceAudios.map((item) => `참조 오디오 ${path.basename(item.file)}`),
  ];
  return lines.join("\n") + (attachments.length ? "\n" + c.dim("  " + attachments.join(" / ")) : "");
}

async function uploadInput(token, modelId, inputType, item) {
  const { json } = await post(
    "/stock/get-genvideo-input-upload-url",
    { engine: modelId, inputType, fileType: item.mime, fileSize: item.bytes },
    { token },
  );
  if (json.result === "error" || !json.uploadUrl) {
    throw new Error(`업로드 URL 발급 실패 (${inputType}): ${JSON.stringify(json).slice(0, 200)}`);
  }
  const body = fs.readFileSync(item.file);
  const put = await fetch(json.uploadUrl, { method: "PUT", headers: { "Content-Type": item.mime }, body });
  if (!put.ok) throw new Error(`업로드 실패 (${inputType}): HTTP ${put.status} ${put.statusText}`);
  return json.assetUrl;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function pollPrompt(rid, polling = {}) {
  const interval = polling.intervalMs ?? 3000;
  const attempts = polling.maxAttempts ?? 20;
  if (polling.initialDelayMs) await sleep(polling.initialDelayMs);
  for (let i = 0; i < attempts; i++) {
    const { json } = await get(`/stock/prompt-results?rid=${encodeURIComponent(rid)}`);
    if (json.result === "error") throw new Error(json.msg || "프롬프트 생성 실패");
    if (json.result === "success") return json.text;
    await sleep(interval);
  }
  throw new Error("프롬프트 생성 시간 초과");
}

// 웹앱은 생성 전에 프롬프트 다듬기 잡을 돌리고 결과를 prompt 로 보낸다.
// prompt 는 문자열이 아니라 { positive, negative? } 객체다.
async function buildPromptObject({ token, modelId, userText, style, generationOptions, startFrameImageUrl }) {
  try {
    const { json } = await post(
      "/stock/start-genvideo-prompt-job",
      {
        type: "video",
        userText,
        style,
        engine: modelId,
        ...(startFrameImageUrl ? { startFrameImageUrl } : {}),
        ...(generationOptions ? { generationOptions } : {}),
      },
      { token },
    );
    if (!json?.rid) return { positive: userText };
    const text = parseMaybeJson(await pollPrompt(json.rid, json.polling));
    const prompt = text?.prompt;
    if (prompt && typeof prompt === "object") {
      const result = {};
      if (typeof prompt.positive === "string" && prompt.positive) result.positive = prompt.positive;
      if (typeof prompt.negative === "string" && prompt.negative) result.negative = prompt.negative;
      if (result.positive) return result;
    }
    if (typeof prompt === "string" && prompt) return { positive: prompt };
    return { positive: userText };
  } catch {
    return { positive: userText };
  }
}

export async function submitGeneration({ token, plan, prompt, args, receiptPath }) {
  const generationOptions = {};
  if (plan.supportsDuration) generationOptions.durationSec = plan.durationSec;
  if (plan.model.generationOptions?.resolution) generationOptions.resolution = plan.resolution;
  if (plan.model.generationOptions?.generateAudio) generationOptions.generateAudio = plan.generateAudio;
  generationOptions.inputMode = plan.inputMode;

  let startFrameImageUrl;
  if (plan.startFrame.length) {
    progress(args, "첨부 업로드: 시작 프레임");
    startFrameImageUrl = await uploadInput(token, plan.modelId, "start_frame_image", plan.startFrame[0]);
  }
  let endFrameImageUrl;
  if (plan.endFrame.length) {
    progress(args, "첨부 업로드: 끝 프레임");
    endFrameImageUrl = await uploadInput(token, plan.modelId, "end_frame_image", plan.endFrame[0]);
  }
  if (plan.referenceImages.length) {
    progress(args, `첨부 업로드: 참조 이미지 ${plan.referenceImages.length}개`);
    generationOptions.referenceImages = await Promise.all(
      plan.referenceImages.map((item) => uploadInput(token, plan.modelId, "reference_image", item)),
    );
  }
  if (plan.referenceVideos.length) {
    progress(args, `첨부 업로드: 참조 영상 ${plan.referenceVideos.length}개`);
    generationOptions.referenceVideos = await Promise.all(
      plan.referenceVideos.map((item) => uploadInput(token, plan.modelId, "reference_video", item)),
    );
  }
  if (plan.referenceAudios.length) {
    progress(args, `첨부 업로드: 참조 오디오 ${plan.referenceAudios.length}개`);
    generationOptions.referenceAudios = await Promise.all(
      plan.referenceAudios.map((item) => uploadInput(token, plan.modelId, "reference_audio", item)),
    );
  }

  let promptObject = { positive: prompt };
  if (!args["no-enhance"]) {
    progress(args, "프롬프트 다듬기");
    promptObject = await buildPromptObject({
      token,
      modelId: plan.modelId,
      userText: prompt,
      style: args.style || "none",
      generationOptions,
      startFrameImageUrl,
    });
  }

  const cfg = loadConfig();
  const body = {
    type: "genvideo",
    userPrompt: prompt,
    style: args.style || "none",
    prompt: promptObject,
    width: plan.width,
    height: plan.height,
    engine: plan.modelId,
    uid: jwtUid(token),
    cid: cfg.cid,
    clientType: CLIENT_TYPE,
    ...apiDeviceIdentity(cfg.cid),
    timezoneMin: -new Date().getTimezoneOffset(),
    generationOptions,
  };
  if (startFrameImageUrl) body.startFrameImageUrl = startFrameImageUrl;
  if (endFrameImageUrl) generationOptions.endFrameImageUrl = endFrameImageUrl;
  if (args.archive) body.archive = true;
  if (plan.model.pricingRevision) body.pricingRevision = plan.model.pricingRevision;

  progress(args, "생성 요청을 보냅니다…");
  const { json } = await post("/stock/make-genvideo", body, { token });
  if (json.result === "error") {
    throw new Error(`생성 요청 거부: ${json.errorType ?? ""} ${json.errorMsg ?? JSON.stringify(json).slice(0, 200)}`);
  }
  if (!json.reqId) throw new Error("reqId 를 받지 못했습니다: " + JSON.stringify(json).slice(0, 200));
  return { reqId: json.reqId, fileKey: json.fileKey, promptObject };
}

export async function pollGeneration(reqId, token, args) {
  await sleep(POLL.initialDelayMs);
  const deadline = Date.now() + POLL.deadlineMs;
  for (let i = 0; i < POLL.maxAttempts; i++) {
    if (Date.now() > deadline) return { status: "error", errorMsg: "클라이언트 대기 시간 초과 (서버 작업은 계속될 수 있음)" };
    const { json } = await get(`/stock/get-genvideo?reqId=${encodeURIComponent(reqId)}`, { token });
    if (json.status === "done" && json.signedUrl) return json;
    if (json.status === "error") return json;
    if (!args.json) process.stderr.write(c.dim("."));
    await sleep(POLL.intervalMs);
  }
  return { status: "pending", errorMsg: "대기 종료. 서버 작업은 취소되지 않았습니다." };
}

export async function processUpload(token, fileKey) {
  try {
    await post("/stock/process-genvideo", { Key: fileKey }, { token });
  } catch {
    // 웹앱도 이 단계 실패는 무시하고 폴링을 계속한다.
  }
}
