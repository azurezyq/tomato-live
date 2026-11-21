# Tomato Live · 番茄实时语音

A low-latency, interruptible, installable PWA voice-chat assistant built for **Mainland Chinese (`zh-CN`)** conversations (with 中英混说 code-switching), powered by **Vertex AI Gemini APIs** and **Firebase**.

## Key Features

* **Dual-Model Speculative Response (RelayS2S):** Immediately speaks a short, natural Mandarin opening sentence (`S1`) via `gemini-3.5-flash-lite` while `gemini-4-hydrogen` (with Google Search grounding) streams the full continuation (`S2..Sn`) in parallel.
* **Real-Time Streaming STT & TTS:** 16 kHz PCM microphone streaming to `gemini-3.5-transcribe-live` over WebSocket, and gapless 24 kHz PCM playback from `gemini-3.8-flash-lite-tts` via Web Audio `AudioWorklet`.
* **Natural Barge-In & Echo Guard:** Duck-then-cut interruption (`< 20 ms` fade-out), Mandarin backchannel filtering (`嗯`, `好的`, `明白`), 3-layer phone speakerphone echo protection, and character-level spoken truncation (`——[用户打断]`).
* **Zero Idle Cost Architecture:** Cloud Run scales to zero (`min-instances=0`) with an in-app `WARMING` indicator on session start.
* **Built-In Live Debug Inspector:** Press **`Ctrl/Cmd + D`** (or click the Debug button) to inspect Latency Waterfalls, Event Logs, Audio/Buffer Telemetry, Context & Grounding Citations, and run simulated utterances.

## Architecture

| Stage | Model / Service | Role |
|---|---|---|
| **Streaming STT** | `gemini-3.5-transcribe-live` via `services/stt-proxy` (Cloud Run) | Real-time 16 kHz PCM streaming transcription (`zh-CN` / auto), Hybrid VAD (`audioStreamEnd`), `VERBATIM` / `SMART` modes |
| **Fast Opening (`S1`)** | `gemini-3.5-flash-lite` via Cloud Run Vertex AI ADC | Drafts 1 concise Mandarin opening sentence (10–40 chars) immediately after end-of-speech (tools disabled) |
| **Grounded Continuation (`S2..Sn`)** | `gemini-4-hydrogen` + Google Search via Cloud Run Vertex AI ADC | Runs in parallel while `S1` plays; continues seamlessly after `S1` with real-time Search citations |
| **Streaming TTS** | `gemini-3.8-flash-lite-tts` / `gemini-3.8-flash-tts` | Streams raw 24 kHz 16-bit PCM into a gapless `AudioWorklet` ring buffer |
| **Auth & History** | Firebase Auth (Google Sign-In) + Firestore | Per-user session persistence, rolling summary compaction, and Firebase ID token verification on every API/WS request |

> **Security model:** No `GEMINI_API_KEY` or GCP private key is ever shipped to the browser or stored on Cloud Run. The Cloud Run backend authenticates to Vertex AI using **Application Default Credentials (ADC)** and verifies each user's Firebase Auth ID token (plus optional `ALLOWED_EMAILS` restriction).

## Local Development

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment variables
Copy both `.env.example` files and fill in your GCP / Firebase project values:
* `apps/web/.env` (from [`apps/web/.env.example`](apps/web/.env.example))
* `services/stt-proxy/.env` (from [`services/stt-proxy/.env.example`](services/stt-proxy/.env.example))

In **Google Cloud / Firebase Console**:
1. Enable APIs: `run.googleapis.com`, `cloudbuild.googleapis.com`, `artifactregistry.googleapis.com`, `aiplatform.googleapis.com`, `firebase.googleapis.com`, `firestore.googleapis.com`, `firebasehosting.googleapis.com`, `identitytoolkit.googleapis.com`.
2. Enable **Firebase Authentication → Google Sign-In**.
3. Create a **Firestore (Native mode)** database and deploy [`firestore.rules`](firestore.rules).
4. Authenticate locally with `gcloud auth application-default login` so `services/stt-proxy` can call Vertex AI via ADC.

### 3. Run locally
```bash
npm run dev
```
* Web app: `http://localhost:5173`
* STT & Vertex AI proxy: `ws://localhost:8081/ws/stt` (health: `http://localhost:8081/health`)

## Scripts

```bash
npm run typecheck   # TypeScript check across both workspaces
npm run test        # Vitest unit & Chinese CUJ tests
npm run build       # Production build for both workspaces
```

## Self-Hosting / Automated Deployment (GitHub Actions)

Fork this repository and add the following in **GitHub → Settings → Secrets and variables → Actions**, then push to `main` (or trigger **Run workflow** on [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)):

### Required Secrets
| Secret | Description |
|---|---|
| `GCP_SA_KEY` | JSON key for a GCP service account with `roles/run.admin`, `roles/iam.serviceAccountUser`, `roles/cloudbuild.builds.editor`, `roles/artifactregistry.admin`, `roles/storage.admin`, `roles/aiplatform.user`, and `roles/firebase.admin` |
| `VITE_FIREBASE_API_KEY` | Firebase Web App `apiKey` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Firebase Web App `messagingSenderId` |
| `VITE_FIREBASE_APP_ID` | Firebase Web App `appId` |

### Optional Variables / Secrets
| Name | Type | Description |
|---|---|---|
| `FIREBASE_PROJECT_ID` | Variable | Overrides the `project_id` embedded in `GCP_SA_KEY` |
| `FIREBASE_HOSTING_SITE` | Variable | Custom Firebase Hosting site ID (defaults to your GCP project ID) |
| `GCP_REGION` | Variable | Cloud Run region (default: `asia-east1`) |
| `VERTEX_LOCATION` | Variable | Vertex AI endpoint location (default: `global`) |
| `ALLOWED_EMAILS` | Secret or Variable | Semicolon- or comma-separated allowlist of Google emails permitted to call your Cloud Run backend (leave empty to allow any signed-in user) |

## License

[MIT](LICENSE)