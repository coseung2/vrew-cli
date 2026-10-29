#!/usr/bin/env node
import tls from "node:tls";
import { main } from "../src/cli.js";

// Windows가 신뢰하는 인증서를 추가하되 기존 CA와 TLS 검증은 유지한다.
if (process.platform === "win32" && typeof tls.setDefaultCACertificates === "function") {
  tls.setDefaultCACertificates([...new Set([
    ...tls.getCACertificates("default"),
    ...tls.getCACertificates("system"),
  ])]);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write("오류: " + (error?.message ?? String(error)) + "\n");
  process.exitCode = 1;
});
