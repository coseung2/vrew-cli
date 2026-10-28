import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};

export function mimeOf(file) {
  const mime = MIME_BY_EXT[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`지원하지 않는 확장자입니다: ${file}`);
  return mime;
}

// PNG / JPEG / WebP 헤더에서 크기만 읽는다 (전체 디코딩 없음).
export function imageSize(buffer) {
  if (buffer.length > 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let i = 2;
    while (i < buffer.length - 9) {
      if (buffer[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buffer[i + 1];
      const length = buffer.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
      }
      i += 2 + length;
    }
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const kind = buffer.toString("ascii", 12, 16);
    if (kind === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (kind === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

export function probeVideo(file) {
  const run = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,duration", "-show_entries", "format=duration", "-of", "json", file],
    { encoding: "utf8" },
  );
  if (run.status !== 0 || !run.stdout) return null;
  try {
    const json = JSON.parse(run.stdout);
    const stream = json.streams?.[0] || {};
    const durationSec = Number(stream.duration ?? json.format?.duration);
    return { width: Number(stream.width), height: Number(stream.height), durationSec: Number.isFinite(durationSec) ? durationSec : null };
  } catch {
    return null;
  }
}

export function checkGeometry(geometry, width, height, label) {
  if (!geometry || !width || !height) return null;
  const within = (value, range) => {
    if (!range) return true;
    if (range.min !== undefined) {
      if (range.minInclusive === false ? !(value > range.min) : !(value >= range.min)) return false;
    }
    if (range.max !== undefined) {
      if (range.maxInclusive === false ? !(value < range.max) : !(value <= range.max)) return false;
    }
    return true;
  };
  if (!within(width, geometry.widthPx)) return `${label}: 가로 ${width}px 이 허용 범위를 벗어났습니다.`;
  if (!within(height, geometry.heightPx)) return `${label}: 세로 ${height}px 이 허용 범위를 벗어났습니다.`;
  if (!within(width / height, geometry.aspectRatio)) return `${label}: 종횡비 ${(width / height).toFixed(3)} 이 허용 범위를 벗어났습니다.`;
  if (geometry.pixelCount && !within(width * height, geometry.pixelCount)) {
    return `${label}: ${width}×${height} = ${(width * height).toLocaleString()}px 이 허용 범위를 벗어났습니다.`;
  }
  return null;
}

// 모델 스펙에 맞춰 첨부 파일을 검사한다. 위반 시 즉시 중단한다.
export function validateAttachment(spec, file, kind) {
  if (!spec) throw new Error(`이 모델은 ${kind} 첨부를 지원하지 않습니다.`);
  const stat = fs.statSync(file);
  const mime = mimeOf(file);
  const label = `${kind} ${path.basename(file)}`;
  if (spec.mimeTypes && !spec.mimeTypes.includes(mime)) {
    throw new Error(`${label}: ${mime} 형식 미지원 (허용: ${spec.mimeTypes.join(", ")})`);
  }
  if (spec.maxBytes && stat.size > spec.maxBytes) {
    throw new Error(`${label}: ${(stat.size / 1048576).toFixed(1)}MB — 최대 ${(spec.maxBytes / 1048576).toFixed(0)}MB`);
  }
  if (mime.startsWith("image/")) {
    const size = imageSize(fs.readFileSync(file));
    const error = checkGeometry(spec.geometry, size?.width, size?.height, label);
    if (error) throw new Error(error);
    return { file, mime, bytes: stat.size, width: size?.width ?? null, height: size?.height ?? null, durationSec: null };
  }
  const info = probeVideo(file);
  if (!info) {
    return { file, mime, bytes: stat.size, width: null, height: null, durationSec: null, unverified: true };
  }
  const error = checkGeometry(spec.geometry, info.width, info.height, label);
  if (error) throw new Error(error);
  if (spec.minDurationSec && info.durationSec !== null && info.durationSec < spec.minDurationSec) {
    throw new Error(`${label}: ${info.durationSec.toFixed(1)}초 — 최소 ${spec.minDurationSec}초 필요`);
  }
  if (spec.maxDurationSec && info.durationSec !== null && info.durationSec > spec.maxDurationSec) {
    throw new Error(`${label}: ${info.durationSec.toFixed(1)}초 — 최대 ${spec.maxDurationSec}초`);
  }
  return { file, mime, bytes: stat.size, ...info };
}
