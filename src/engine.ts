import {
  GoogleGenerativeAI,
  GenerativeModel,
  HarmCategory,
  HarmBlockThreshold,
} from "@google/generative-ai";
import { Session, VideoContext, VideoType, appendMessage, updateSession } from "./session";
import { Caption } from "./transcribe";

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// Flash for conversation — fast, low cost per turn
const flashModel = genai.getGenerativeModel({
  model: "gemini-2.0-flash",
  safetySettings: [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  ],
});

// Pro for RenderConfig generation — runs once per job, quality matters
const proModel = genai.getGenerativeModel({
  model: "gemini-2.5-pro",
  safetySettings: [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  ],
});

// ─── Types ────────────────────────────────────────────────────────────────────

export type StyleConfig = {
  fontPreset: "bold" | "clean" | "condensed" | "playful";
  highlightColor: string;    // single accent color, no gradients
  captionSize: number;       // px
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
  events: TimelineEvent[];   // what fires every ~3 seconds
  captions: Caption[];
  musicSrc?: string;
};

// ─── Style presets per video type ─────────────────────────────────────────────
// Clean, no gradients, no emoji spam — typography-first

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

// ─── Conversation ─────────────────────────────────────────────────────────────

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
- Always respond with valid JSON in this shape:
  { "message": "your reply to the user", "context": { ...extracted fields... }, "ready": false }
- Context fields: videoType, coreMessage, targetAudience, energyLevel, musicPreference, additionalNotes
- videoType must be one of: founder, educational, emotional, comedy
- energyLevel must be one of: low, medium, high
- Only set ready=true when you have videoType and coreMessage at minimum`;

export async function chat(
  session: Session,
  userText: string
): Promise<{ reply: string; context: VideoContext; ready: boolean }> {
  appendMessage(session.id, { role: "user", text: userText });

  // Build history for Gemini multi-turn
  const history = session.history.slice(0, -1).map((m) => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));

  const geminiChat = flashModel.startChat({
    history: [
      { role: "user", parts: [{ text: CONVERSATION_SYSTEM }] },
      { role: "model", parts: [{ text: '{"message":"Understood. Ready to collect video context.","context":{},"ready":false}' }] },
      ...history,
    ],
  });

  const result = await geminiChat.sendMessage(userText);
  const raw = result.response.text().trim();

  let parsed: { message: string; context: VideoContext; ready: boolean };
  try {
    // Strip markdown code fences if Gemini wraps it
    const json = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    parsed = JSON.parse(json);
  } catch {
    // Fallback if Gemini doesn't return clean JSON
    parsed = { message: raw, context: {}, ready: false };
  }

  appendMessage(session.id, { role: "model", text: parsed.message });

  // Merge extracted context into session
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
CORE MESSAGE: ${session.context.coreMesage ?? "not specified"}
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

Respond with ONLY a valid JSON array of events, no explanation:
[{ "atMs": 0, "durationMs": 2500, "type": "hook", "text": "..." }, ...]`;

  const result = await proModel.generateContent(prompt);
  const raw = result.response.text().trim();

  let events: TimelineEvent[] = [];
  try {
    const json = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    events = JSON.parse(json);
  } catch {
    console.warn("[engine] failed to parse events JSON, using empty timeline");
  }

  return { videoType, style, events, captions };
}
