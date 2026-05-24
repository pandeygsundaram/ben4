import Anthropic from "@anthropic-ai/sdk";
import { Session, VideoContext, VideoType, appendMessage, updateSession } from "./session";
import { Caption } from "./transcribe";

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Types ────────────────────────────────────────────────────────────────────

export type StyleConfig = {
  fontPreset: "bold" | "clean" | "condensed" | "playful";
  highlightColor: string;
  captionSize: number;
  animationSpeed: "fast" | "medium" | "slow";
  captionPosition: "bottom" | "center";
};

export type TimelineEvent = {
  atMs: number;
  durationMs: number;
  type: "hook" | "quote" | "stat" | "cta" | "chapter";
  text: string;
};

export type RenderConfig = {
  videoType: VideoType;
  style: StyleConfig;
  events: TimelineEvent[];
  captions: Caption[];
  musicSrc?: string;
};

// ─── Style presets ─────────────────────────────────────────────────────────────

const STYLE_PRESETS: Record<VideoType, StyleConfig> = {
  founder: {
    fontPreset: "bold",
    highlightColor: "#FFE500",
    captionSize: 120,
    animationSpeed: "fast",
    captionPosition: "bottom",
  },
  educational: {
    fontPreset: "clean",
    highlightColor: "#60A5FA",
    captionSize: 88,
    animationSpeed: "medium",
    captionPosition: "bottom",
  },
  emotional: {
    fontPreset: "condensed",
    highlightColor: "#F97316",
    captionSize: 84,
    animationSpeed: "slow",
    captionPosition: "center",
  },
  comedy: {
    fontPreset: "playful",
    highlightColor: "#EC4899",
    captionSize: 104,
    animationSpeed: "fast",
    captionPosition: "bottom",
  },
};

// ─── Conversation (Claude) ────────────────────────────────────────────────────

const CONVERSATION_SYSTEM = `You are the intake agent for an AI video editor called Rumic.
Your job is to collect enough information from the user to edit their video reel.

You need to figure out:
1. What type of video is this? (founder/startup story, educational, emotional/personal story, comedy)
2. What is the core message or story they want to tell?
3. Who is the audience?
4. Energy level — high energy and fast, or calm and slow?
5. Do they want background music? If so what vibe?

Rules:
- Ask one or two questions at a time, not all at once
- Be concise — this is a messaging interface, not a form
- Once you have enough context (at minimum: type + core message), set ready=true in your response
- Always respond with valid JSON in this exact shape:
  { "message": "your reply to the user", "context": { ...extracted fields... }, "ready": false }
- Context fields: videoType, coreMessage, targetAudience, energyLevel, musicPreference, additionalNotes
- videoType must be one of: founder, educational, emotional, comedy
- energyLevel must be one of: low, medium, high
- Only set ready=true when you have videoType and coreMessage at minimum
- Respond with raw JSON only — no markdown fences, no explanation`;

export async function chat(
  session: Session,
  userText: string
): Promise<{ reply: string; context: VideoContext; ready: boolean }> {
  appendMessage(session.id, { role: "user", text: userText });

  const messages: Anthropic.MessageParam[] = session.history.map((m) => ({
    role: m.role === "model" ? "assistant" : "user",
    content: m.text,
  }));

  const result = await claude.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    system: CONVERSATION_SYSTEM,
    messages,
  });

  const raw = (result.content[0] as Anthropic.TextBlock).text.trim();

  let parsed: { message: string; context: VideoContext; ready: boolean };
  try {
    const json = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    parsed = JSON.parse(json);
  } catch {
    parsed = { message: raw, context: {}, ready: false };
  }

  appendMessage(session.id, { role: "model", text: parsed.message });

  const mergedContext = { ...session.context, ...parsed.context };
  updateSession(session.id, { context: mergedContext, ready: parsed.ready });

  return { reply: parsed.message, context: mergedContext, ready: parsed.ready };
}

// ─── RenderConfig generation ───────────────────────────────────────────────────

export async function generateRenderConfig(
  session: Session,
  transcript: string,
  captions: Caption[],
  totalDurationMs: number
): Promise<RenderConfig> {
  const videoType: VideoType = (session.context.videoType as VideoType) ?? "founder";
  const style = STYLE_PRESETS[videoType];

  const prompt = `You are a video editor AI. Generate a timeline of engagement events for this reel.

VIDEO TYPE: ${videoType}
CORE MESSAGE: ${session.context.coreMessage ?? "not specified"}
ENERGY LEVEL: ${session.context.energyLevel ?? "medium"}
TOTAL DURATION: ${Math.round(totalDurationMs / 1000)} seconds

TRANSCRIPT:
${transcript}

Rules for events:
- Place an event roughly every 3 seconds throughout the video
- Events must land at natural speech pauses (between sentences/phrases), not mid-word
- Types available: hook (opening grab), quote (pull a strong line), stat (a number or fact), chapter (label a new section), cta (call to action — end only)
- First event is always type=hook at atMs=0
- Last event is always type=cta
- Text must be short — max 6 words per card
- NO gradients, NO emoji in text, clean text only
- durationMs is how long the card stays visible (1500–3000ms)

Respond with ONLY a valid JSON array of events, no explanation, no markdown:
[{ "atMs": 0, "durationMs": 2500, "type": "hook", "text": "..." }, ...]`;

  const result = await claude.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = (result.content[0] as Anthropic.TextBlock).text.trim();

  let events: TimelineEvent[] = [];
  try {
    const json = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    events = JSON.parse(json);
  } catch {
    console.warn("[engine] failed to parse events JSON, using empty timeline");
  }

  return { videoType, style, events, captions };
}

// ─── Motivational script generator ───────────────────────────────────────────

export async function generateMotivationalScript(
  transcript: string,
  totalDurationMs: number
): Promise<string> {
  const targetWords = Math.round((totalDurationMs / 1000) * 2.5);
  const prompt = `You are a motivational content writer. Below is a raw transcript from a video.
Write a short, punchy motivational voiceover script that fits the theme of the original content.
The script should be ${targetWords} words max (to match ~${Math.round(totalDurationMs / 1000)} seconds of audio).
Use short sentences. High energy. Direct. No filler. No hashtags. No emoji.

ORIGINAL TRANSCRIPT:
${transcript}

Respond with ONLY the script text — no labels, no explanations.`;

  const result = await claude.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  return (result.content[0] as Anthropic.TextBlock).text.trim();
}
