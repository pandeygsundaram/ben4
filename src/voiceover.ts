import fs from "fs-extra";
import path from "path";
import { VideoType } from "./session";
import { transcribeVideo, Caption } from "./transcribe";

const RUMIC_BASE = "https://silk-api.rumik.ai";

// ─── Voice mapping ─────────────────────────────────────────────────────────────
// muga  → ultra-low latency, tone via [tag] prefix on text
// mulberry → expressive, steered by natural-language description + optional preset speaker

type MugaTone = "neutral" | "happy" | "sad" | "excited" | "angry" | "whisper";

type MugaParams = {
  model: "muga";
  tone: MugaTone;
};

type MulberryParams = {
  model: "mulberry";
  description: string;
  speaker: "speaker_1" | "speaker_2" | "speaker_3" | "speaker_4";
  f0_up_key?: number;
};

type RumicParams = MugaParams | MulberryParams;

const VOICE_MAP: Record<VideoType, Record<string, RumicParams>> = {
  founder: {
    low:    { model: "mulberry", description: "confident founder, conversational and direct, measured pace", speaker: "speaker_3" },
    medium: { model: "mulberry", description: "confident entrepreneur, passionate and engaging", speaker: "speaker_3" },
    high:   { model: "mulberry", description: "high-energy founder, fast-paced, fired up and confident", speaker: "speaker_3" },
  },
  educational: {
    low:    { model: "mulberry", description: "calm, clear professional narrator, slow and thorough", speaker: "speaker_1" },
    medium: { model: "mulberry", description: "clear educator, engaging and informative", speaker: "speaker_1" },
    high:   { model: "mulberry", description: "enthusiastic educator, energetic and engaging, fast paced", speaker: "speaker_1" },
  },
  emotional: {
    low:    { model: "mulberry", description: "warm, gentle storyteller, slow and heartfelt, sincere", speaker: "speaker_2" },
    medium: { model: "mulberry", description: "warm, empathetic narrator, genuine and sincere", speaker: "speaker_2" },
    high:   { model: "mulberry", description: "passionate storyteller, emotionally charged, deeply sincere", speaker: "speaker_2" },
  },
  comedy: {
    low:    { model: "muga", tone: "happy" },
    medium: { model: "muga", tone: "happy" },
    high:   { model: "muga", tone: "excited" },
  },
};

// ─── TTS call ─────────────────────────────────────────────────────────────────

async function callRumicTTS(
  script: string,
  params: RumicParams,
  apiKey: string
): Promise<Buffer> {
  let body: Record<string, unknown>;

  if (params.model === "muga") {
    body = {
      model: "muga",
      text: `[${params.tone}] ${script}`,
    };
  } else {
    body = {
      model: "mulberry",
      text: script,
      description: params.description,
      speaker: params.speaker,
      ...(params.f0_up_key !== undefined ? { f0_up_key: params.f0_up_key } : {}),
    };
  }

  console.log(`[voiceover] → POST ${RUMIC_BASE}/v1/tts`);
  console.log(`[voiceover] body:`, JSON.stringify(body));

  const response = await fetch(`${RUMIC_BASE}/v1/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  console.log(`[voiceover] response status: ${response.status} ${response.statusText}`);

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    console.error(`[voiceover] error body:`, err);
    throw new Error(`Rumic AI TTS error ${response.status}: ${(err as any).error ?? "unknown"}`);
  }

  const buffer = await response.arrayBuffer();
  console.log(`[voiceover] ✓ received ${(buffer.byteLength / 1024).toFixed(0)} KB WAV`);
  return Buffer.from(buffer);
}

// ─── Public API ────────────────────────────────────────────────────────────────

export type VoiceoverResult = {
  audioPath: string;   // path to the saved WAV
  captions: Caption[]; // word-level timestamps from Groq (same shape as video captions)
};

export async function generateVoiceover(
  script: string,
  videoType: VideoType,
  energyLevel: "low" | "medium" | "high" = "medium",
  outputPath: string
): Promise<VoiceoverResult> {
  const apiKey = process.env.RUMIC_API_KEY;
  if (!apiKey) throw new Error("RUMIC_API_KEY env var not set");

  const params = VOICE_MAP[videoType]?.[energyLevel] ?? VOICE_MAP.founder.medium;

  console.log(`[voiceover] model=${params.model}, type=${videoType}, energy=${energyLevel}`);

  const wav = await callRumicTTS(script, params, apiKey);
  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, wav);

  console.log(`[voiceover] saved ${outputPath} (${(wav.byteLength / 1024).toFixed(0)} KB)`);

  // Transcribe the generated audio to get word-level captions for Remotion
  const captions = await transcribeVideo(outputPath);
  console.log(`[voiceover] transcribed ${captions.length} words`);

  return { audioPath: outputPath, captions };
}
