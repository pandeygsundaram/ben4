import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs-extra";
import { v4 as uuidv4 } from "uuid";
import { transcribeVideo } from "./transcribe";
import { createJob, getJob, updateJob, loadJobsFromDisk, PROJECTS_DIR } from "./jobs";
import { renderVideo } from "./render";
import { createSession, getSession, appendMessage } from "./session";
import { chat, generateRenderConfig, generateMotivationalScript } from "./engine";
import { generateVoiceover } from "./voiceover";
import {
  handleTelegramUpdate,
  notifyJobDone,
  notifyJobError,
  telegramJobChatMap,
  setWebhook,
  isAuthorized,
  getStatus as getTelegramStatus,
  TelegramUpdate,
} from "./integrations/telegram";

const app = express();
app.use(cors());
app.use(express.json());

// Log every incoming request
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

const upload = multer({ dest: "/tmp/reel-uploads/" });

const MUSIC_DIR = "/home/sundaram/data/reel-server/music";

// ─── Session endpoints ─────────────────────────────────────────────────────────

// POST /session — start a new conversation session
app.post("/session", (_req, res) => {
  const session = createSession();
  res.json({ sessionId: session.id });
});

// POST /session/:id/message — user sends a message (text or transcribed voice)
app.post("/session/:id/message", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const { text } = req.body;
  if (!text?.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }

  try {
    const { reply, context, ready } = await chat(session, text);
    res.json({ reply, context, ready });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /session/:id — get current session state
app.get("/session/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({
    sessionId: session.id,
    context: session.context,
    ready: session.ready,
    messageCount: session.history.length,
  });
});

// ─── Music endpoint ────────────────────────────────────────────────────────────

// POST /music — upload a background music track, returns musicId
app.post("/music", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No audio file received" });
      return;
    }

    await fs.mkdirp(MUSIC_DIR);

    const ext = path.extname(req.file.originalname) || ".mp3";
    const musicId = uuidv4();
    const dest = path.join(MUSIC_DIR, `${musicId}${ext}`);
    await fs.move(req.file.path, dest);

    console.log(`[music] saved ${dest}`);
    res.json({ musicId, filename: `${musicId}${ext}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Project endpoints ─────────────────────────────────────────────────────────

// POST /project — upload clips, optionally with sessionId + musicId
app.post("/project", upload.array("videos"), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    const descriptions: string[] = JSON.parse(req.body.descriptions ?? "[]");
    const sessionId: string | undefined = req.body.sessionId;
    const musicId: string | undefined = req.body.musicId;
    const script: string | undefined = req.body.script;          // optional: triggers voiceover mode
    const voiceoverMode: boolean = req.body.voiceoverMode === true || Boolean(script);

    if (!files?.length) {
      res.status(400).json({ error: "No videos uploaded" });
      return;
    }

    const session = sessionId ? getSession(sessionId) : undefined;
    if (sessionId && !session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const jobId = uuidv4();
    const jobDir = path.join(PROJECTS_DIR, jobId);
    await fs.mkdirp(jobDir);

    const clips = await Promise.all(files.map(async (f, i) => {
      const dest = path.join(jobDir, `clip_${i}${path.extname(f.originalname) || ".mp4"}`);
      await fs.move(f.path, dest);
      return { videoPath: dest, description: descriptions[i] ?? "" };
    }));

    await fs.writeJson(
      path.join(jobDir, "job.json"),
      { jobId, status: "pending", clips, sessionId, musicId, script, voiceoverMode, createdAt: Date.now() },
      { spaces: 2 }
    );

    const job = createJob(jobId, clips, jobDir);

    console.log(`[job:${jobId}] ${clips.length} clip(s), session=${sessionId ?? "none"}, music=${musicId ?? "none"}, voiceover=${voiceoverMode}`);

    processJob(jobId, sessionId, musicId, script).catch(console.error);

    res.json({ jobId, status: job.status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /project/:id — poll status
app.get("/project/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({ jobId: job.id, status: job.status, error: job.error ?? null });
});

// GET /projects — list all jobs
app.get("/projects", (_req, res) => {
  // Jobs are in-memory; list what we have
  // In Phase 4 this will pull from disk for full history
  res.json({ message: "coming in Phase 4 — use GET /project/:id to poll a specific job" });
});

// GET /project/:id/download — stream final MP4
app.get("/project/:id/download", (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.status !== "done" || !job.outputPath) {
    res.status(404).json({ error: "Not ready" });
    return;
  }
  res.download(job.outputPath, `reel-${req.params.id}.mp4`);
});

// ─── Telegram endpoints ────────────────────────────────────────────────────────

// GET /telegram/status — check if bot token is configured
app.get("/telegram/status", (_req, res) => {
  res.json(getTelegramStatus());
});

// POST /telegram/set-webhook — register the Telegram webhook (call once after ngrok starts)
// Body: { "url": "https://xxxx.ngrok-free.app" }
app.post("/telegram/set-webhook", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) { res.status(400).json({ error: "url required" }); return; }
    await setWebhook(url);
    res.json({ ok: true, url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /telegram/webhook/:secret? — receives updates from Telegram
app.post("/telegram/webhook/:secret?", async (req, res) => {
  if (!isAuthorized(req.params.secret)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.sendStatus(200); // ack Telegram immediately

  const update = req.body as TelegramUpdate;
  handleTelegramUpdate(update, (jobId, sessionId, videoPath, description) => {
    // Build a one-clip job from the downloaded Telegram video
    const jobDir = path.join(PROJECTS_DIR, jobId);
    fs.mkdirp(jobDir).then(async () => {
      // Move the temp file into the job dir so it survives cleanup
      const dest = path.join(jobDir, "clip_0.mp4");
      await fs.move(videoPath, dest, { overwrite: true });
      const clips = [{ videoPath: dest, description }];
      await fs.writeJson(
        path.join(jobDir, "job.json"),
        { jobId, status: "pending", clips, sessionId, createdAt: Date.now() },
        { spaces: 2 }
      );
      createJob(jobId, clips, jobDir);
      processJob(jobId, sessionId).catch(console.error);
    }).catch(console.error);
  }).catch(console.error);
});

// POST /voice — raw audio blob (Phase 4: WhatsApp voice notes)
app.post("/voice", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No audio received" });
      return;
    }
    console.log(`[voice] received audio: ${req.file.path} (${req.file.size} bytes)`);
    res.json({ received: true, path: req.file.path });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Job processor ─────────────────────────────────────────────────────────────

async function processJob(jobId: string, sessionId?: string, musicId?: string, script?: string) {
  const job = getJob(jobId)!;
  const jobDir = path.join(PROJECTS_DIR, jobId);

  try {
    // ── Step 1: Transcribe ──────────────────────────────────────────────────
    console.log(`\n[job:${jobId}] ━━ STEP 1: TRANSCRIBE (${job.clips.length} clips) ━━`);
    updateJob(jobId, { status: "transcribing" });
    await persistJobStatus(jobId, "transcribing", jobDir);

    for (let i = 0; i < job.clips.length; i++) {
      const clip = job.clips[i];
      console.log(`[job:${jobId}] transcribing clip ${i + 1}/${job.clips.length}: ${path.basename(clip.videoPath)}`);
      clip.captions = await transcribeVideo(clip.videoPath);
      console.log(`[job:${jobId}] clip ${i + 1} → ${clip.captions.length} words`);
    }

    await fs.writeJson(
      path.join(jobDir, "transcripts.json"),
      job.clips.map((c) => ({ videoPath: c.videoPath, captions: c.captions })),
      { spaces: 2 }
    );
    console.log(`[job:${jobId}] transcripts saved`);

    // ── Step 2: Gemini RenderConfig ─────────────────────────────────────────
    console.log(`\n[job:${jobId}] ━━ STEP 2: GEMINI RENDER CONFIG ━━`);
    updateJob(jobId, { status: "rendering" });
    await persistJobStatus(jobId, "rendering", jobDir);

    const allCaptions = job.clips.flatMap((c) => c.captions ?? []);
    const transcript = allCaptions.map((c) => c.text).join(" ");
    const totalDurationMs = allCaptions.length ? allCaptions[allCaptions.length - 1].endMs : 0;
    console.log(`[job:${jobId}] total captions: ${allCaptions.length}, duration: ${(totalDurationMs / 1000).toFixed(1)}s`);
    console.log(`[job:${jobId}] transcript preview: "${transcript.slice(0, 120)}..."`);

    const session = sessionId ? getSession(sessionId) : undefined;
    let renderConfig = null;

    if (session) {
      console.log(`[job:${jobId}] session context:`, JSON.stringify(session.context));
      console.log(`[job:${jobId}] → calling Gemini to generate RenderConfig`);
      renderConfig = await generateRenderConfig(session, transcript, allCaptions, totalDurationMs);
      console.log(`[job:${jobId}] ✓ RenderConfig: type=${renderConfig.videoType}, events=${renderConfig.events.length}`);
    } else {
      console.log(`[job:${jobId}] no session — skipping Gemini, using default style`);
    }

    let musicSrc: string | undefined;
    if (musicId) {
      console.log(`[job:${jobId}] looking for music: ${musicId}`);
      const musicFiles = await fs.readdir(MUSIC_DIR).catch(() => [] as string[]);
      const musicFile = musicFiles.find((f) => f.startsWith(musicId));
      if (musicFile) {
        musicSrc = path.join(MUSIC_DIR, musicFile);
        console.log(`[job:${jobId}] ✓ music found: ${musicSrc}`);
      } else {
        console.warn(`[job:${jobId}] music file not found for id: ${musicId}`);
      }
    }
    if (renderConfig && musicSrc) renderConfig.musicSrc = musicSrc;

    // ── Step 3: Rumic AI Voiceover (optional / motivational mode) ─────────────
    let voiceoverPath: string | undefined;

    // Detect motivational mode: check session history, clip descriptions, or explicit script
    const allSessionText = session
      ? session.history.map((m) => m.text).join(" ").toLowerCase()
      : "";
    const allDescriptions = job.clips.map((c) => (c.description ?? "")).join(" ").toLowerCase();
    const isMotivational =
      allSessionText.includes("motivational") ||
      allDescriptions.includes("motivational") ||
      (script?.toLowerCase().includes("motivational") ?? false);

    console.log(`[job:${jobId}] motivational=${isMotivational} (session="${allSessionText.slice(0, 60)}" desc="${allDescriptions.slice(0, 60)}"`);

    let effectiveScript = script?.trim();

    if (isMotivational && !effectiveScript) {
      console.log(`\n[job:${jobId}] ━━ STEP 3a: GENERATING MOTIVATIONAL SCRIPT ━━`);
      effectiveScript = await generateMotivationalScript(transcript, totalDurationMs);
      console.log(`[job:${jobId}] motivational script: "${effectiveScript.slice(0, 120)}..."`);
      const motivationalStyle = {
        fontPreset: "bold" as const,
        highlightColor: "#FF6B35",
        captionSize: 110,
        animationSpeed: "fast" as const,
        captionPosition: "bottom" as const,
      };
      if (renderConfig) {
        renderConfig.style = motivationalStyle;
        renderConfig.videoType = "emotional";
      } else {
        // No session — build a minimal renderConfig for motivational mode
        renderConfig = {
          videoType: "emotional" as const,
          style: motivationalStyle,
          events: [],
          captions: allCaptions,
        };
      }
    }

    if (effectiveScript) {
      console.log(`\n[job:${jobId}] ━━ STEP 3: RUMIC AI VOICEOVER ━━`);
      console.log(`[job:${jobId}] script (${effectiveScript.length} chars): "${effectiveScript.slice(0, 100)}..."`);
      const videoType = isMotivational ? "emotional" : (session?.context.videoType ?? "founder");
      const energyLevel = isMotivational ? "high" : (session?.context.energyLevel ?? "medium");
      const voiceOutputPath = path.join(jobDir, "voiceover.wav");
      const result = await generateVoiceover(effectiveScript, videoType, energyLevel, voiceOutputPath);
      voiceoverPath = result.audioPath;
      console.log(`[job:${jobId}] ✓ voiceover at ${voiceoverPath}`);
      if (renderConfig) renderConfig.captions = result.captions;
    } else {
      console.log(`[job:${jobId}] no script — skipping voiceover`);
    }

    await fs.writeJson(path.join(jobDir, "render-config.json"), renderConfig ?? { captions: allCaptions }, { spaces: 2 });
    console.log(`[job:${jobId}] render-config.json saved`);

    // ── Step 4: Render ──────────────────────────────────────────────────────
    console.log(`\n[job:${jobId}] ━━ STEP 4: REMOTION RENDER ━━`);
    const clipsForRender = job.clips.map((c) => ({
      videoPath: c.videoPath,
      captions: c.captions ?? [],
    }));

    const outputPath = await renderVideo(jobId, jobDir, clipsForRender, renderConfig ?? undefined, voiceoverPath);

    console.log(`\n[job:${jobId}] ✅ DONE → ${outputPath}`);
    updateJob(jobId, { status: "done", outputPath });
    await persistJobStatus(jobId, "done", jobDir, outputPath);

    // Notify Telegram if this job came from the bot
    const tgChatId = telegramJobChatMap.get(jobId);
    if (tgChatId) notifyJobDone(tgChatId, jobId, outputPath).catch(console.error);
  } catch (err: any) {
    console.error(`\n[job:${jobId}] ❌ ERROR:`, err.message);
    console.error(err.stack);
    updateJob(jobId, { status: "error", error: err.message });
    await persistJobStatus(jobId, "error", jobDir, undefined, err.message);

    const tgChatId = telegramJobChatMap.get(jobId);
    if (tgChatId) notifyJobError(tgChatId, jobId, err.message).catch(console.error);
  }
}

async function persistJobStatus(
  jobId: string,
  status: string,
  jobDir: string,
  outputPath?: string,
  error?: string
) {
  const jobFile = path.join(jobDir, "job.json");
  const existing = await fs.readJson(jobFile).catch(() => ({}));
  await fs.writeJson(jobFile, { ...existing, status, outputPath, error }, { spaces: 2 });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

const PORT = 4000;
loadJobsFromDisk().then(() => {
  app.listen(PORT, () => console.log(`Reel server running on http://localhost:${PORT}`));
});
