import fs from "fs-extra";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { uploadReelToR2 } from "../r2";
import { createSession, getSession, Session } from "../session";
import { chat } from "../engine";
import { transcribeVideo } from "../transcribe";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
const UPLOAD_DIR = "/tmp/reel-tg-uploads";

// ─── Types ─────────────────────────────────────────────────────────────────────

type TgFile = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { first_name?: string; username?: string };
    text?: string;
    caption?: string;
    video?: TgFile;
    document?: TgFile & { mime_type?: string };
    voice?: TgFile & { duration?: number };
  };
};

type ChatState = {
  sessionId: string;
  pendingVideoPath?: string;
  activeJobId?: string;
  awaitingConfirmation?: boolean;
  confirmationSummary?: string;
};

// jobId → chatId — checked by processJob in server.ts to send result back
export const telegramJobChatMap = new Map<string, number>();

// chatId → state
const chatStates = new Map<number, ChatState>();

// ─── Main handler ──────────────────────────────────────────────────────────────

// launchJob mirrors the server's internal processJob caller signature
export async function handleTelegramUpdate(
  update: TelegramUpdate,
  launchJob: (jobId: string, sessionId: string, videoPath: string, description: string) => void
): Promise<void> {
  console.log("[telegram] update:", JSON.stringify(update, null, 2));
  const msg = update.message;
  if (!msg) {
    console.log("[telegram] no message field, skipping");
    return;
  }
  console.log(`[telegram] chatId=${msg.chat.id} text=${msg.text ?? "(no text)"} hasVideo=${!!msg.video} hasVoice=${!!msg.voice}`);
  try {

  const chatId = msg.chat.id;

  if (msg.text === "/start") {
    await say(chatId,
      "Hey! Send me a video clip and tell me how to edit it.\n\nExample: \"Make this a motivational reel\" or \"Founder story, bold captions, high energy\"."
    );
    return;
  }

  if (msg.text?.trim()) {
    const session = await ensureSession(chatId);
    const state = getState(chatId, session.id);

    // ── Confirmation gate ──────────────────────────────────────────────────
    if (state.awaitingConfirmation) {
      const answer = msg.text.trim().toLowerCase();
      const isConfirm = ["yes", "yeah", "y", "go", "start", "ok", "okay", "sure", "yep", "lets go", "let's go", "do it", "render"].includes(answer);
      if (isConfirm) {
        if (!state.pendingVideoPath) {
          state.awaitingConfirmation = false;
          await say(chatId, "Hmm, I lost your video. Please send it again.");
          return;
        }
        const jobId = uuidv4();
        telegramJobChatMap.set(jobId, chatId);
        state.activeJobId = jobId;
        state.awaitingConfirmation = false;
        const videoPath = state.pendingVideoPath;
        state.pendingVideoPath = undefined;
        launchJob(jobId, session.id, videoPath, state.confirmationSummary ?? "");
        await say(chatId, `Rendering started! I'll send you the finished video when it's done.\nJob: \`${jobId}\``);
      } else {
        state.awaitingConfirmation = false;
        await say(chatId, "Got it, cancelled. Send your video again whenever you're ready.");
      }
      return;
    }

    // ── If video is already waiting, skip the interview — just confirm ────────
    if (state.pendingVideoPath) {
      const summary = buildSummary({}, msg.text);
      state.awaitingConfirmation = true;
      state.confirmationSummary = msg.text;
      await say(chatId, `${summary}\n\nReply YES to start or anything else to cancel.`);
      return;
    }

    // ── No video yet — run conversation to collect context ────────────────
    const { reply, ready, context } = await chat(session, msg.text);
    const hint = ready ? "\n\nNow send your video clip." : "";
    await say(chatId, `${reply}${hint}`);
    return;
  }

  // Video or document (.mp4)
  const videoRef =
    msg.video ??
    (msg.document?.mime_type?.startsWith("video/") ? msg.document : undefined);

  if (videoRef) {
    await say(chatId, "Downloading your video...");
    let localPath: string;
    try {
      localPath = await downloadTgFile(videoRef, ".mp4");
    } catch (e: any) {
      await say(chatId, "Couldn't download the video. Please try again.");
      return;
    }

    const session = await ensureSession(chatId);
    const state = getState(chatId, session.id);
    state.pendingVideoPath = localPath;

    const caption = msg.caption?.trim();
    if (caption) {
      const { reply, ready, context } = await chat(session, caption);
      if (ready) {
        const summary = buildSummary(context, caption);
        state.awaitingConfirmation = true;
        state.confirmationSummary = caption;
        await say(chatId, `${summary}\n\nReply YES to start rendering or anything else to cancel.`);
        return;
      }
      await say(chatId, `${reply}\n\n(I have your video — send any extra details to start.)`);
      return;
    }

    if (session.ready) {
      const summary = buildSummary(session.context, "");
      state.awaitingConfirmation = true;
      state.confirmationSummary = "";
      await say(chatId, `Got your video!\n\n${summary}\n\nReply YES to start rendering or anything else to cancel.`);
      return;
    }

    await say(chatId, "Got your video! Now tell me how you want it edited.\n\nExample: \"Motivational founder reel, high energy\".");
    return;
  }

  // Voice note → transcribe → treat as text instruction
  if (msg.voice) {
    await say(chatId, "Got your voice note. Transcribing...");
    let localPath: string | undefined;
    try {
      localPath = await downloadTgFile(msg.voice, ".ogg");
      const captions = await transcribeVideo(localPath);
      const text = captions.map((c) => c.text).join(" ").trim();

      if (!text) {
        await say(chatId, "Couldn't make out the voice note. Please type your instruction.");
        return;
      }

      const session = await ensureSession(chatId);
      const state = getState(chatId, session.id);
      const { reply, ready } = await chat(session, text);

      if (ready && state.pendingVideoPath) {
        const jobId = uuidv4();
        telegramJobChatMap.set(jobId, chatId);
        state.activeJobId = jobId;
        const videoPath = state.pendingVideoPath;
        state.pendingVideoPath = undefined;
        launchJob(jobId, session.id, videoPath, text);
        await say(chatId, `Got your voice instruction. Rendering started.\nJob: \`${jobId}\``);
        return;
      }

      const hint = state.pendingVideoPath
        ? "\n\n(I have your video — add any details to start.)"
        : ready ? "\n\nNow send your video." : "";
      await say(chatId, `Heard: "${text}"\n\n${reply}${hint}`);
    } catch (e: any) {
      console.error("[telegram] voice error:", e.message);
      await say(chatId, "Voice transcription failed. Please type your instruction.");
    } finally {
      if (localPath) fs.remove(localPath).catch(() => {});
    }
    return;
  }
  } catch (e: any) {
    console.error("[telegram] unhandled error in update handler:", e.message, e.stack);
    try { await say(msg.chat.id, "Something went wrong on my end. Please try again."); } catch {}
  }
}

// ─── Notify on job completion ──────────────────────────────────────────────────

export async function notifyJobDone(chatId: number, jobId: string, outputPath: string): Promise<void> {
  console.log(`[telegram] notifying chatId=${chatId} job=${jobId} done`);
  try {
    // Try direct send first (works for files under ~50MB)
    await sendVideo(chatId, outputPath, "Your reel is ready!");
  } catch (e: any) {
    console.error("[telegram] sendVideo failed, uploading to R2:", e.message);
    try {
      const url = await uploadReelToR2(outputPath, jobId);
      await say(chatId, `Your reel is ready! Download link (valid 24h):\n${url}`);
    } catch (r2err: any) {
      console.error("[telegram] R2 upload failed:", r2err.message);
      await say(chatId, `Your reel is done (job: ${jobId}) but I couldn't deliver it. Error: ${r2err.message}`);
    }
  }
  telegramJobChatMap.delete(jobId);
}

export async function notifyJobError(chatId: number, jobId: string, error: string): Promise<void> {
  console.log(`[telegram] notifying chatId=${chatId} job=${jobId} error`);
  await say(chatId, `Something went wrong with your render.\nError: ${error}`);
  telegramJobChatMap.delete(jobId);
}

// ─── Webhook helpers ───────────────────────────────────────────────────────────

export function isAuthorized(secret?: string): boolean {
  if (!SECRET) return true;
  return secret === SECRET;
}

export async function setWebhook(publicBaseUrl: string): Promise<void> {
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set in .env");
  const webhookPath = SECRET ? `/telegram/webhook/${SECRET}` : "/telegram/webhook";
  const url = `${publicBaseUrl.replace(/\/$/, "")}${webhookPath}`;
  const res = await tgApi("setWebhook", { url, drop_pending_updates: true });
  if (!res.ok) throw new Error(`setWebhook failed: ${JSON.stringify(res)}`);
  console.log(`[telegram] webhook registered → ${url}`);
}

export function getStatus() {
  return {
    configured: Boolean(TOKEN),
    secretProtected: Boolean(SECRET),
    activeSessions: chatStates.size,
  };
}

// ─── Internals ─────────────────────────────────────────────────────────────────

async function ensureSession(chatId: number): Promise<Session> {
  const state = chatStates.get(chatId);
  if (state?.sessionId) {
    const s = getSession(state.sessionId);
    if (s) return s;
  }
  const s = createSession();
  chatStates.set(chatId, { sessionId: s.id });
  return s;
}

function getState(chatId: number, sessionId: string): ChatState {
  const s = chatStates.get(chatId);
  if (s) return s;
  const created: ChatState = { sessionId };
  chatStates.set(chatId, created);
  return created;
}

async function downloadTgFile(file: TgFile, fallbackExt: string): Promise<string> {
  const info = await tgApi("getFile", { file_id: file.file_id });
  if (!info.ok || !info.result?.file_path) throw new Error(`getFile failed for ${file.file_id}`);
  const ext = path.extname(file.file_name ?? info.result.file_path) || fallbackExt;
  const dest = path.join(UPLOAD_DIR, `${file.file_id}${ext}`);
  await fs.ensureDir(UPLOAD_DIR);
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${info.result.file_path}`);
  if (!res.ok) throw new Error(`File download failed: ${res.status}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function say(chatId: number, text: string): Promise<void> {
  console.log(`[telegram] say → chatId=${chatId}: ${text.slice(0, 80)}`);
  await tgApi("sendMessage", { chat_id: chatId, text });
}

async function sendVideo(chatId: number, videoPath: string, caption: string): Promise<void> {
  const fileBuffer = await fs.readFile(videoPath);
  const blob = new Blob([fileBuffer], { type: "video/mp4" });
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("video", blob, "reel.mp4");
  form.append("caption", caption);
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendVideo`, {
    method: "POST",
    body: form,
  });
  const json = await res.json() as any;
  if (!json.ok) throw new Error(json.description ?? "sendVideo failed");
}

function buildSummary(context: Record<string, any>, description: string): string {
  const desc = description.toLowerCase();
  const type = context.videoType ?? (desc.includes("educational") ? "educational" : desc.includes("comedy") ? "comedy" : desc.includes("emotional") ? "emotional" : "founder");
  const energy = context.energyLevel ?? (desc.includes("high energy") || desc.includes("fast") ? "high" : desc.includes("calm") || desc.includes("slow") ? "low" : "medium");
  const motivational = desc.includes("motivational") ? "\nMotivational mode: Rumic TTS voiceover will be generated" : "";
  return `Here's what I got:\n\nType: ${type}\nEnergy: ${energy}\nDescription: ${description.slice(0, 100)}${motivational}`;
}

async function tgApi(method: string, body: Record<string, unknown>): Promise<any> {
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) {
    console.error(`[telegram] API error on ${method}:`, JSON.stringify(json));
    throw new Error(`Telegram ${method} failed: ${json.description ?? "unknown"}`);
  }
  return json;
}
