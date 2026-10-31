# vrew-cli

**Vrew(브루)의 AI 영상 생성과 음성 합성(TTS)을 터미널에서 사용하는 비공식 CLI입니다.** 텍스트·이미지·참조 미디어로 영상을 만들고, 원고를 음성으로 변환할 수 있습니다.

## 목적

반복되는 영상·음성 제작 작업을 명령어와 스크립트로 실행하기 위한 도구입니다. 자신의 Vrew 계정으로 로그인하여 모델을 조회하고, 생성 전 예상 사용량을 확인한 뒤 결과 파일을 내려받습니다.

- **영상 생성:** 텍스트→영상, 이미지→영상, 참조 이미지·영상·오디오 기반 생성
- **음성 합성:** 한국어 등 지원 언어의 목소리 조회 및 텍스트 파일을 MP3로 변환
- **자동화:** JSON 출력, 생성 요청 상태 조회, 중단된 요청의 결과 회수
- **사용량 제어:** `--dry-run` 사전 확인과 `--max-credits` 상한 지정

일반 브라우저 로그인에는 Chrome 또는 Edge를 사용합니다. 로그인 후 영상·음성 생성은 저장된 계정 세션으로 Vrew API를 호출하므로 데스크톱 앱이나 브라우저 자동화가 필요하지 않습니다.

> **VoyagerX와 제휴하거나 공식 지원받는 도구가 아닙니다.** 개인 자동화를 위한 비공식 클라이언트이며, 내부 API는 예고 없이 바뀔 수 있습니다. 반드시 본인 계정만 사용하고 자동화 전에 Vrew 이용약관을 확인하세요. 구독·사용량 제한을 우회하는 도구가 아닙니다.

## 요구 사항

- Node.js **20+**. **Windows에서는 24.5 이상 권장** — 시스템의 신뢰된 인증서를 함께 사용합니다. 앱 쿠키 가져오기는 내장 SQLite가 있는 Node 22.5 이상이 필요합니다.
- `ffprobe` (선택) — 참조 영상의 길이·해상도 검사. 없으면 경고 후 진행

## 설치

```bash
npm install -g vrew-cli
```

저장소에서 직접 쓸 때:

```bash
git clone https://github.com/coseung2/vrew-cli.git
cd vrew-cli
npm link
```

`npm link`는 클론한 소스를 전역 `vrew` 명령에 연결합니다. 이 방식으로 설치하면 저장소의 수정 사항이 바로 반영됩니다. 아래 명령은 Windows PowerShell에서도 사용할 수 있습니다.

## 빠른 시작

```bash
# 1. 브라우저에서 본인 계정으로 로그인
vrew login

# 2. 로그인 계정과 사용량 확인
vrew whoami

# 3. 지원 모델 확인
vrew models

# 4. 서버에 생성 요청을 보내지 않고 영상 생성 계획·예상 크레딧 확인
vrew gen --prompt "고요한 연못 위 종이배" --model Seedance_1_Pro --dry-run
```

견적과 계정을 확인한 후에만 실제 생성을 실행하세요. 다음 예시는 예상 크레딧이 20을 넘으면 중단합니다. 모델 요율과 사용 가능 여부는 변경될 수 있습니다.

```bash
vrew gen --prompt "고요한 연못 위 종이배" --model Seedance_1_Pro --out paper-boat.mp4 --yes --max-credits 20
```

음성을 만들 때는 먼저 목소리 목록을 확인하고, 원고 파일로 사전 확인합니다.

```bash
vrew tts voices --lang ko-KR
vrew tts gen --voice vos-male28 --text-file script.txt --out narration.mp3 --dry-run
```

목소리마다 감정·연기 옵션이 다르므로, 고른 목소리의 `감정`·`연기` 열을 확인하고 `--emotion`·`--acting`으로 지정합니다.

`script.txt`는 사용자가 준비한 원고 파일입니다. `--dry-run`은 결과 영상을 만들거나 MP3를 생성하지 않습니다. TTS의 실제 사용량은 계정의 월 글자 한도에서 차감됩니다.

## 로그인

```bash
vrew login
```

Chrome 또는 Edge 창이 열리고 Vrew 로그인 페이지가 뜹니다. Google 등으로 로그인하면, CLI가 그 세션을 읽어 저장하고 창을 닫습니다. 링크를 직접 열어야 하면 터미널에 표시되는 안내 URL을 브라우저에 붙여 넣어도 됩니다.

- 브라우저 프로필은 `~/.vrew/browser-profile`에 보관되어 다음 로그인 때 Google 세션이 재사용됩니다.
- 세션은 `~/.vrew/config.json`(0600)에만 저장하며 비밀번호는 저장하지 않습니다.

다른 경로:

```bash
# 이메일·비밀번호 (터미널에서 비밀번호 입력)
vrew login --email you@example.com

# 이미 로그인된 Vrew 데스크톱 앱 세션 가져오기 (Windows, 앱 종료 상태)
vrew login --import-app-cookie

# 세션 쿠키만 직접 넣기 (수동 복구)
vrew login --cookie <VREW_RTK 값>
```

옵션: `--account <이메일>`(다른 계정이면 실패), `--timeout <초>`(기본 300), `--keep-browser`(로그인 후 창 유지).

```bash
vrew whoami
vrew logout
```

## 영상 생성

```bash
vrew models                     # 모델·크레딧·입력 모드 확인
vrew gen --prompt "..." --dry-run   # 계획 + 예상 크레딧만
vrew gen --prompt "..." --out a.mp4 --yes --max-credits 200
```

### text → video

```bash
vrew gen --prompt "고요한 연못 위 종이배, 카메라 푸시인" --model Seedance_1_Pro --out t2v.mp4 --yes --max-credits 20
```

### image → video (i2v)

```bash
vrew gen --prompt "종이배가 천천히 떠간다" --model Veo_3_1_Lite \
  --start-frame keyframe.png --out i2v.mp4 --yes --max-credits 200
```

`--end-frame`은 `--start-frame`과 함께 쓸 수 있는 모델에서만 동작합니다.

### reference → video (r2v)

```bash
vrew gen --prompt "파란 유리 공이 천천히 회전한다" --model Seedance_2_0_Mini \
  --ref-image subject.png --ref-video motion.mp4 --ref-audio tone.wav \
  --out r2v.mp4 --yes --max-credits 400
```

첨부는 모델 스펙(형식·용량·해상도·길이·최대 개수)으로 검사한 뒤에 업로드합니다. 모델이 지원하지 않는 입력 모드는 실행 전에 거부됩니다.

### 주요 옵션

| 옵션 | 설명 |
| --- | --- |
| `--model <id>` | `vrew models`의 id (생략 시 기본 모델) |
| `--ratio 16:9\|9:16\|1:1\|4:3\|3:4` | 화면 비율 |
| `--resolution 720p\|1080p` | 해상도 (모델 지원 범위 내) |
| `--duration <초>` | 길이 (모델이 허용하는 값만) |
| `--no-audio` | 생성 오디오 끄기 |
| `--no-enhance` | 프롬프트 다듬기 생략 |
| `--dry-run` | 계획·견적만 출력, 서버 호출 없음 |
| `--yes --max-credits N` | 실제 생성. 견적이 상한을 넘으면 중단 |
| `--json` | 기계 판독용 출력 |

### 실패·재시작

요청마다 `<출력>.request.json` 영수증을 남깁니다. 중간에 끊기면 같은 요청을 다시 만들지 말고 조회하세요.

```bash
vrew status --req-id <id> --out a.mp4
```

## TTS

```bash
vrew tts voices --lang ko-KR                # 목소리 목록(이름·감정·연기·태그 포함)
vrew tts gen --voice vos-male28 --text "안녕하세요" --out a.mp3 --dry-run
vrew tts gen --voice vos-male28 --text-file script.txt --out a.mp3 --yes --max-credits 50

# 목소리가 지원하는 범위 안에서만 지정할 수 있습니다(목록에 없는 값은 거부)
vrew tts gen --voice vos-male28 --text "안녕하세요" --out a.mp3 \
  --emotion happy --intensity 1.5 --acting auto --tts-version v1 --speed 1.1 --pitch 0
vrew tts voices --provider typecast         # 제공자별로 목록 좁히기
vrew tts status --out a.mp3                 # 끊긴 요청 회수
```

- `--emotion`·`--acting`·`--tts-version`은 목소리마다 다릅니다. `tts voices` 표의 `감정`·`연기`·태그를 보고 그 목록에 있는 값만 쓰세요.
- 지정하지 않으면 앱과 같은 기본값을 씁니다: 그 목소리의 첫 버전, `auto` 연기(있을 때), `neutral` 감정(있을 때, 없으면 첫 감정).
- `--intensity`(기본 1)·`--speed`·`--pitch`·`--volume`(기본 0)은 숫자입니다.

- 견적은 `ceil(글자수/100) × creditsPer100Chars`의 보수적 상한입니다(실청구액과 다를 수 있음).
- 원고는 최대 10,000자, 결과는 변환 없이 원본 MP3로 저장합니다.
- 기존 출력·영수증을 덮어쓰지 않습니다.

## 비용

- 영상 생성은 크레딧을 씁니다. `--dry-run`으로 먼저 견적을 확인하고 `--max-credits`로 상한을 두세요.
- 견적은 서버 요율표(`creditPricing.rates`)로 계산하며, 요율을 확인할 수 없으면 실행을 거부합니다.
- TTS는 크레딧 대신 계정의 월 글자 한도를 씁니다.

## 보안·개인정보

- 로그인 세션(갱신 쿠키)은 Windows에서 CurrentUser DPAPI로 감싸 보관하고, 그 외 OS에서는 0600 권한 파일에 둡니다.
- 비밀번호·토큰·쿠키를 출력하지 않습니다. `--json` 출력에도 포함되지 않습니다.
- 앱 쿠키 가져오기는 사용자가 지정한 로컬 Vrew DB를 읽기 전용으로 복사해 쓰고 즉시 삭제합니다.

## 문제 해결

| 증상 | 대응 |
| --- | --- |
| `Vrew 앱이 실행 중입니다` | 앱을 완전히 종료한 뒤 `vrew login --import-app-cookie` |
| `세션 갱신 실패` / 401 | `vrew login`으로 다시 로그인 |
| `NETWORK [SELF_SIGNED_CERT_IN_CHAIN]` | Windows에서는 Node 24.5+ 권장: CLI가 시스템의 신뢰된 CA를 함께 사용합니다. 계속 실패하면 조직의 인증서·프록시 설정을 확인하세요. TLS 검증은 끄지 마세요. |
| `NETWORK [ENOTFOUND]` / `[ETIMEDOUT]` | DNS·인터넷·프록시 연결을 확인하세요. |
| `이 모델은 'reference' 입력을 지원하지 않습니다` | `vrew models`의 입력 열 확인 |
| `Unsupported or oversized GenVideo input file` | 그 모델이 해당 첨부 업로드를 지원하지 않음. 프레임/참조 지원 모델로 변경 |
| `pricing_changed` | 모델 요율이 바뀜. CLI를 최신 버전으로 |

## 개발

```bash
npm test        # 네트워크·계정·크레딧 없이 도는 단위 테스트
```

구조: `src/api.js`(HTTP), `src/auth.js`(로그인·갱신), `src/models.js`(모델·견적), `src/media.js`(첨부 검사), `src/video.js`(영상), `src/tts.js`(음성), `src/cli.js`(명령).

### 배포

`v*` 태그를 푸시하면 `.github/workflows/publish.yml`이 테스트 후 npm에 배포합니다. 저장소 시크릿에 `NPM_TOKEN`이 필요합니다.

```bash
npm version patch && git push --follow-tags
```

## 라이선스

MIT. Vrew 및 관련 상표는 VoyagerX의 자산입니다.
