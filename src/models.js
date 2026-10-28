import { get } from "./api.js";

let cache = null;

export async function fetchModels({ force = false } = {}) {
  if (cache && !force) return cache;
  const { json } = await get("/stock/get-generate-asset-model-list");
  if (json.result === "error" || !Array.isArray(json.genVideoModels)) {
    throw new Error("모델 목록 조회 실패: " + JSON.stringify(json).slice(0, 200));
  }
  cache = json;
  return json;
}

export function videoModels(catalog) {
  return catalog.genVideoModels || [];
}

export function pickModel(catalog, id) {
  const list = videoModels(catalog);
  if (!id) return list.find((model) => model.isDefault) || list[0];
  const needle = String(id).toLowerCase();
  const found =
    list.find((model) => model.id.toLowerCase() === needle) ||
    list.find((model) => model.name.toLowerCase() === needle) ||
    list.find((model) => model.id.toLowerCase().includes(needle));
  if (!found) throw new Error(`모델을 찾을 수 없습니다: ${id}\n사용 가능: ${list.map((model) => model.id).join(", ")}`);
  return found;
}

const RATIOS = {
  "16:9": { w: 1280, h: 720 },
  "9:16": { w: 720, h: 1280 },
  "1:1": { w: 960, h: 960 },
  "4:3": { w: 960, h: 720 },
  "3:4": { w: 720, h: 960 },
};

export function dimsFor(ratio, resolution) {
  const base = RATIOS[ratio] || RATIOS["16:9"];
  if (resolution === "1080p") return { width: Math.round(base.w * 1.5), height: Math.round(base.h * 1.5) };
  return { width: base.w, height: base.h };
}

export function durRange(model) {
  const spec = model.generationOptions?.durationSec;
  if (spec) {
    return {
      min: spec.min ?? Math.min(...(spec.values || [])),
      max: spec.max ?? Math.max(...(spec.values || [])),
      def: spec.defaultValue ?? spec.min ?? spec.values?.[0],
      values: spec.values,
    };
  }
  const range = model.videoSecRange;
  if (range) return { min: range.min, max: range.max, def: range.min };
  return { min: undefined, max: undefined, def: 5 };
}

// 서버 요율표(creditPricing.rates)로 견적을 낸다. 요율을 확인할 수 없으면 실행하지 않는다.
export function estimateCredits(model, { durationSec, resolution, generateAudio, archive = false, hasVideoInput = false }) {
  const rates = archive ? model.creditPricing?.archiveRates : model.creditPricing?.rates;
  let rate = rates?.[resolution];
  if (hasVideoInput && rate) {
    if (!rate.videoInput) throw new Error("참조 영상 요율을 확인할 수 없습니다.");
    rate = rate.videoInput;
  }
  if (archive && !rate) throw new Error("보관 요율을 확인할 수 없습니다.");
  const duration = durationSec ?? model.generationOptions?.durationSec?.defaultValue ?? 5;
  if (!rate || typeof rate.audioOff !== "number") {
    throw new Error("이 설정의 요율을 확인할 수 없어 실행을 중단합니다.");
  }
  const perSecond = generateAudio ? (rate.audioOn ?? rate.audioOff) : rate.audioOff;
  return {
    credits: Math.max(1, duration * perSecond),
    basis: `${duration}s × ${perSecond}/s${generateAudio ? " (오디오 포함)" : ""}${hasVideoInput ? " (영상 입력)" : ""}`,
  };
}
