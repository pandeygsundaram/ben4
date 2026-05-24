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
import { chat, generateRenderConfig } from "./engine";
import { generateVoiceover } from "./voiceover";

const app = express();
app.use(cors());
app.use(express.json());

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
    // Step 1: Transcribe all clips
    updateJob(jobId, { status: "transcribing" });
    await persistJobStatus(jobId, "transcribing", jobDir);

    for (const clip of job.clips) {
      console.log(`[job:${jobId}] transcribing ${path.basename(clip.videoPath)}`);
      clip.captions = await transcribeVideo(clip.videoPath);
    }

    await fs.writeJson(
      path.join(jobDir, "transcripts.json"),
      job.clips.map((c) => ({ videoPath: c.videoPath, captions: c.captions })),
      { spaces: 2 }
    );

    // Step 2: Generate RenderConfig via Gemini if session exists
    updateJob(jobId, { status: "rendering" });
    await persistJobStatus(jobId, "rendering", jobDir);

    const allCaptions = job.clips.flatMap((c) => c.captions ?? []);
    const transcript = allCaptions.map((c) => c.text).join(" ");
    const totalDurationMs = allCaptions.length
      ? allCaptions[allCaptions.length - 1].endMs
      : 0;

    const session = sessionId ? getSession(sessionId) : undefined;
    let renderConfig = null;

    if (session) {
      console.log(`[job:${jobId}] generating RenderConfig via Gemini`);
      renderConfig = await generateRenderConfig(session, transcript, allCaptions, totalDurationMs);
    }

    // Resolve music path if musicId provided
    let musicSrc: string | undefined;
    if (musicId) {
      const musicFiles = await fs.readdir(MUSIC_DIR).catch(() => [] as string[]);
      const musicFile = musicFiles.find((f) => f.startsWith(musicId));
      if (musicFile) musicSrc = path.join(MUSIC_DIR, musicFile);
    }
    if (renderConfig && musicSrc) renderConfig.musicSrc = musicSrc;

    // Step 3: generate Rumic AI voiceover if a script was provided
    let voiceoverPath: string | undefined;
    if (script?.trim()) {
      console.log(`[job:${jobId}] generating Rumic AI voiceover`);
      const videoType = session?.context.videoType ?? "founder";
      const energyLevel = session?.context.energyLevel ?? "medium";
      const voiceOutputPath = path.join(jobDir, "voiceover.wav");
      const result = await generateVoiceover(script, videoType, energyLevel, voiceOutputPath);
      voiceoverPath = result.audioPath;
      // Use voiceover captions instead of transcribed video captions
      if (renderConfig) renderConfig.captions = result.captions;
    }

    await fs.writeJson(path.join(jobDir, "render-config.json"), renderConfig ?? { captions: allCaptions }, { spaces: 2 });

    const clipsForRender = job.clips.map((c) => ({
      videoPath: c.videoPath,
      captions: c.captions ?? [],
    }));

    const outputPath = await renderVideo(jobId, jobDir, clipsForRender, renderConfig ?? undefined, voiceoverPath);

    console.log(`[job:${jobId}] done → ${outputPath}`);
    updateJob(jobId, { status: "done", outputPath });
    await persistJobStatus(jobId, "done", jobDir, outputPath);
  } catch (err: any) {
    console.error(`[job:${jobId}] error:`, err.message);
    updateJob(jobId, { status: "error", error: err.message });
    await persistJobStatus(jobId, "error", jobDir, undefined, err.message);
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
