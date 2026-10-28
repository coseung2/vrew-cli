# vrew-cli

Unofficial headless CLI for **Vrew (브루)** — AI video generation (text→video, image→video, reference→video) and TTS, straight from the terminal.

No desktop app and no browser automation are needed at run time. The CLI talks to Vrew's own API with your own account session.

> **Not affiliated with VoyagerX.** This is an unofficial client for personal automation. The API is internal and may change without notice. Use only with your own account, and check Vrew's terms before automating.

## 요구 사항

- Node.js **20+** (Node 22.5+ 권장 — 앱 쿠키 가져오기에 내장 SQLite 사용)
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

## 로그인

세션은 `~/.vrew/config.json`에만 저장되며(0600), 비밀번호는 저장하지 않습니다.

```bash
# 1) Vrew 데스크톱 앱 세션 가져오기 (Windows, 앱은 종료 상태여야 함)
vrew login --import-app-cookie

# 2) 이메일·비밀번호 (모든 OS)
vrew login --email you@example.com

# 3) 이미 저장된 세션 갱신
vrew login
```

Google/Apple 로그인으로 만든 계정은 1번을 쓰세요. 앱이 실행 중이면 쿠키 DB가 잠겨 있어 가져올 수 없습니다.

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
vrew tts voices --lang ko-KR                # 목소리 목록
vrew tts gen --voice vos-male28 --text "안녕하세요" --out a.mp3 --dry-run
vrew tts gen --voice vos-male28 --text-file script.txt --out a.mp3 --yes --max-credits 50
vrew tts status --out a.mp3                 # 끊긴 요청 회수
```

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
| `이 모델은 'reference' 입력을 지원하지 않습니다` | `vrew models`의 입력 열 확인 |
| `Unsupported or oversized GenVideo input file` | 그 모델이 해당 첨부 업로드를 지원하지 않음. 프레임/참조 지원 모델로 변경 |
| `pricing_changed` | 모델 요율이 바뀜. CLI를 최신 버전으로 |

## 개발

```bash
npm test        # 네트워크·계정·크레딧 없이 도는 단위 테스트
```

구조: `src/api.js`(HTTP), `src/auth.js`(로그인·갱신), `src/models.js`(모델·견적), `src/media.js`(첨부 검사), `src/video.js`(영상), `src/tts.js`(음성), `src/cli.js`(명령).

## 라이선스

MIT. Vrew 및 관련 상표는 VoyagerX의 자산입니다.
