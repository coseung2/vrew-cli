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

// 입력 방식(inputMode)별 길이 범위. 모델은 inputModeRules[mode] 로 방식마다 규칙을 따로 둔다:
// durationSecOption(그 방식 전용 범위), durationSec {type:"fixed"|"source"}(고정값 / 원본 영상 길이를 따름).
export function modeDurRange(model, mode, sourceDurationSec) {
  const base = durRange(model);
  const rule = model.generationOptions?.inputModeRules?.[mode];
  if (!rule || base.min === undefined) return base;
  const fixed = (value) => ({ min: value, max: value, def: value, values: undefined, locked: true });
  if (rule.durationSec?.type === "fixed") return fixed(rule.durationSec.value);
  if (rule.durationSec?.type === "source") {
    if (sourceDurationSec === undefined || sourceDurationSec === null) return base;
    if (base.values?.length) {
      const rounded = Math.round(sourceDurationSec);
      return fixed(base.values.reduce((best, value) => (Math.abs(value - rounded) < Math.abs(best - rounded) ? value : best), base.def));
    }
    return fixed(Math.max(base.min, Math.min(base.max, Math.floor(sourceDurationSec))));
  }
  const option = rule.durationSecOption;
  if (option) {
    return {
      min: option.min ?? Math.min(...(option.values || [])),
      max: option.max ?? Math.max(...(option.values || [])),
      def: option.defaultValue ?? option.min ?? option.values?.[0],
      values: option.values,
    };
  }
  return base;
}

// 첨부 종류별 스펙. 스펙에 inputModes 가 있으면 그 방식에서만 받는다 (예: 연장에서는 참조 이미지 불가).
export function modeSpec(options, key, mode) {
  const spec = options?.[key];
  if (!spec) return undefined;
  if (spec.inputModes && !spec.inputModes.includes(mode)) return undefined;
  return spec;
}

// 원본 영상의 종횡비에 가장 가까운 지원 비율 (로그 거리).
export function nearestRatio(width, height, values, fallback) {
  if (!width || !height || !values?.length) return fallback;
  const target = width / height;
  const distance = (ratio) => {
    const [w, h] = ratio.split(":").map(Number);
    return Math.abs(Math.log(target / (w / h)));
  };
  return values.reduce((best, ratio) => (distance(ratio) < distance(best) ? ratio : best), values.includes(fallback) ? fallback : values[0]);
}

// 편집·연장의 원본 영상은 참조 영상 최대 길이보다 1초 이상 짧아야 한다 (앱과 같은 규칙: floor(길이) <= floor(max) - 1).
export function sourceDurationError(durationSec, spec) {
  if (durationSec === undefined || durationSec === null || !spec) return null;
  if (spec.minDurationSec !== undefined && durationSec < spec.minDurationSec) return `최소 ${spec.minDurationSec}초 필요`;
  if (spec.maxDurationSec !== undefined && Math.floor(durationSec) > Math.floor(spec.maxDurationSec) - 1) {
    return `${Math.floor(spec.maxDurationSec)}초 미만이어야 합니다`;
  }
  return null;
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
