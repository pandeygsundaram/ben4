import { execSync } from "child_process";
import path from "path";
import fs from "fs-extra";
import { Caption } from "./transcribe";
import { RenderConfig } from "./engine";
import { runCodeAgent } from "./video-agent/single-agent";

const TEMPLATE_DIR = path.join(__dirname, "../template");
const OUTPUT_DIR = "/home/sundaram/data/reel-server/output";

console.log(`[render] TEMPLATE_DIR: ${TEMPLATE_DIR}`);

export type ClipInput = {
  videoPath: string;
  captions: Caption[];
};

// ─── Isolated project per job ─────────────────────────────────────────────────
// Each job gets a full copy of the template + its own npm install.
// Completely independent — no shared state between jobs.

async function bootstrapProject(jobId: string, jobDir: string): Promise<string> {
  const projectDir = path.join(jobDir, "remotion");
  console.log(`[render:${jobId}] bootstrapping isolated project at ${projectDir}`);

  // 1. Copy template (no node_modules, no .git)
  await fs.copy(TEMPLATE_DIR, projectDir, {
    overwrite: true,
    filter: (src) => {
      const rel = path.relative(TEMPLATE_DIR, src);
      return !rel.startsWith("node_modules") && !rel.startsWith(".git");
    },
  });
  console.log(`[render:${jobId}] template copied`);

  // 2. npm install — uses local npm cache so subsequent jobs are fast
  console.log(`[render:${jobId}] running npm install...`);
  execSync("npm install --prefer-offline --loglevel=error", {
    cwd: projectDir,
    stdio: "inherit",
  });
  console.log(`[render:${jobId}] npm install done`);

  return projectDir;
}

async function teardownProject(jobId: string, projectDir: string) {
  console.log(`[render:${jobId}] tearing down ${projectDir}`);
  await fs.remove(projectDir);
  console.log(`[render:${jobId}] project removed`);
}

// ─── Main render ──────────────────────────────────────────────────────────────

export async function renderVideo(
  jobId: string,
  jobDir: string,
  clips: ClipInput[],
  renderConfig?: RenderConfig,
  voiceoverPath?: string
): Promise<string> {
  console.log(`\n[render:${jobId}] ═══ START ═══`);
  console.log(`[render:${jobId}] clips=${clips.length}, voiceover=${!!voiceoverPath}`);
  await fs.mkdirp(OUTPUT_DIR);

  // Concat clips if multiple
  let finalVideoPath: string;
  let mergedCaptions: Caption[];
  let tempConcatDir: string | null = null;

  if (clips.length === 1) {
    finalVideoPath = clips[0].videoPath;
    mergedCaptions = clips[0].captions;
    console.log(`[render:${jobId}] single clip: ${path.basename(finalVideoPath)}`);
  } else {
    tempConcatDir = path.join("/tmp", `reel-concat-${jobId}`);
    await fs.mkdirp(tempConcatDir);
    console.log(`[render:${jobId}] concatenating ${clips.length} clips`);
    ({ videoPath: finalVideoPath, captions: mergedCaptions } = await concatenateClips(jobId, clips, tempConcatDir));
    console.log(`[render:${jobId}] concat done, ${mergedCaptions.length} total captions`);
  }

  // Bootstrap fully isolated Remotion project
  const projectDir = await bootstrapProject(jobId, jobDir);
  const publicDir = path.join(projectDir, "public");

  // Drop job files into the project's own public/
  console.log(`[render:${jobId}] writing files to ${publicDir}`);
  await fs.copy(finalVideoPath, path.join(publicDir, "reel.mp4"), { overwrite: true });

  // Voiceover mode: show TTS captions, not original muted audio transcript
  const captionsForRender = (voiceoverPath && renderConfig?.captions?.length)
    ? renderConfig.captions
    : mergedCaptions;
  console.log(`[render:${jobId}] captions → ${captionsForRender.length} words (${voiceoverPath ? "TTS/Rumic" : "original video"})`);
  await fs.writeJson(path.join(publicDir, "reel.json"), captionsForRender, { spaces: 2 });

  // --public-dir CLI flag is ignored in Remotion 4.0.465 — patch the config
  // directly with the absolute path so the bundler always finds reel.mp4.
  await fs.writeFile(
    path.join(projectDir, "remotion.config.ts"),
    `import { Config } from "@remotion/cli/config";
import { enableTailwind } from "@remotion/tailwind-v4";
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.overrideWebpackConfig(enableTailwind);
Config.setPublicDir(${JSON.stringify(publicDir)});
`
  );
  console.log(`[render:${jobId}] patched remotion.config.ts → publicDir=${publicDir}`);

  if (voiceoverPath) {
    await fs.copy(voiceoverPath, path.join(publicDir, "voice.wav"), { overwrite: true });
    console.log(`[render:${jobId}] voiceover copied`);
  }

  const props = {
    src: `/public/reel.mp4`,
    ...(voiceoverPath ? { voiceSrc: `/public/voice.wav` } : {}),
    ...(renderConfig ? {
      style: renderConfig.style,
      events: renderConfig.events,
      musicSrc: renderConfig.musicSrc,
      musicVolume: voiceoverPath ? 0.10 : 0.18,
    } : {}),
  };

  const propsPath = path.join(projectDir, "props.json");
  await fs.writeJson(propsPath, props);
  console.log(`[render:${jobId}] props:`, JSON.stringify(props, null, 2));

  const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
  const renderCmd = `npx remotion render CaptionedVideo "${outputPath}" --props="${propsPath}" --public-dir="${publicDir}" --bundle-cache=false`;

  // Agent runs only on error recovery — style/color/font all come through props.json

  // ── Render with self-healing retry loop (up to 3 attempts) ─────────────────
  const MAX_RENDER_ATTEMPTS = 3;
  let lastError: string | undefined;

  console.log(`[render:${jobId}] running: ${renderCmd}`);
  console.log(`[render:${jobId}] cwd: ${projectDir}`);

  try {
    for (let attempt = 1; attempt <= MAX_RENDER_ATTEMPTS; attempt++) {
      try {
        if (attempt > 1 && renderConfig && lastError) {
          await runCodeAgent(jobId, projectDir, renderConfig, lastError, (msg) => console.log(msg));
        }

        console.log(`[render:${jobId}] render attempt ${attempt}/${MAX_RENDER_ATTEMPTS}`);
        execSync(renderCmd, { cwd: projectDir, stdio: "inherit" });
        console.log(`[render:${jobId}] ✅ render done → ${outputPath}`);
        return outputPath;
      } catch (err: any) {
        lastError = err.stderr?.toString() || err.message || String(err);
        console.error(`[render:${jobId}] ✗ render attempt ${attempt} failed: ${lastError!.slice(0, 300)}`);
        if (attempt === MAX_RENDER_ATTEMPTS) throw err;
      }
    }
  } finally {
    if (tempConcatDir) await fs.remove(tempConcatDir).catch(() => {});
    await teardownProject(jobId, projectDir);
  }

  return outputPath;
}

// ─── ffmpeg helpers ────────────────────────────────────────────────────────────

async function getClipDurationMs(clipPath: string): Promise<number> {
  console.log(`[render] ffprobe: ${path.basename(clipPath)}`);
  const output = execSync(
    `npx remotion ffprobe -v quiet -print_format json -show_streams -show_format "${clipPath}"`,
    { cwd: TEMPLATE_DIR }
  ).toString();
  const data = JSON.parse(output);
  const stream = data.streams?.find((s: any) => s.codec_type === "video") ?? data.streams?.[0];
  let ms = Math.round(parseFloat(stream?.duration) * 1000);
  // Some codecs omit stream duration — fall back to container format duration
  if (!Number.isFinite(ms) || ms <= 0) {
    ms = Math.round(parseFloat(data.format?.duration) * 1000);
  }
  console.log(`[render] duration: ${ms}ms`);
  return ms;
}

async function concatenateClips(
  jobId: string,
  clips: ClipInput[],
  tempDir: string
): Promise<{ videoPath: string; captions: Caption[] }> {
  const concatListPath = path.join(tempDir, "concat.txt");
  const concatLines = clips.map((c) => `file '${c.videoPath}'`).join("\n");
  console.log(`[render:${jobId}] concat list:\n${concatLines}`);
  await fs.writeFile(concatListPath, concatLines);

  const outputPath = path.join(tempDir, "merged.mp4");
  execSync(
    `npx remotion ffmpeg -f concat -safe 0 -i "${concatListPath}" -c copy "${outputPath}" -y`,
    { cwd: TEMPLATE_DIR, stdio: "inherit" }
  );

  let offsetMs = 0;
  const mergedCaptions: Caption[] = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    console.log(`[render:${jobId}] merging clip ${i + 1}: offset=${offsetMs}ms, words=${clip.captions.length}`);
    for (const caption of clip.captions) {
      mergedCaptions.push({
        text: caption.text,
        startMs: caption.startMs + offsetMs,
        endMs: caption.endMs + offsetMs,
      });
    }
    offsetMs += await getClipDurationMs(clip.videoPath);
  }

  return { videoPath: outputPath, captions: mergedCaptions };
}
