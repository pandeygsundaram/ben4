import { execSync } from "child_process";
import path from "path";
import fs from "fs-extra";
import { Caption } from "./transcribe";
import { RenderConfig } from "./engine";

// Starter template — never modified, stays pristine
const TEMPLATE_DIR = path.join(__dirname, "../../template");
const OUTPUT_DIR = "/home/sundaram/data/reel-server/output";

export type ClipInput = {
  videoPath: string;
  captions: Caption[];
};

// ─── Per-job project setup ─────────────────────────────────────────────────────

async function createJobProject(jobId: string, jobDir: string): Promise<string> {
  const projectDir = path.join(jobDir, "remotion");

  // Copy template excluding node_modules and any prior output
  await fs.copy(TEMPLATE_DIR, projectDir, {
    overwrite: true,
    filter: (src) => {
      const rel = path.relative(TEMPLATE_DIR, src);
      return !rel.startsWith("node_modules") && !rel.startsWith(".git");
    },
  });

  // Symlink node_modules from the template — no npm install per job
  await fs.symlink(
    path.join(TEMPLATE_DIR, "node_modules"),
    path.join(projectDir, "node_modules")
  );

  return projectDir;
}

async function cleanupJobProject(projectDir: string) {
  // Remove symlink first so rm -rf doesn't follow it into the template
  const nodeModulesLink = path.join(projectDir, "node_modules");
  if (await fs.pathExists(nodeModulesLink)) {
    await fs.remove(nodeModulesLink);
  }
  await fs.remove(projectDir);
}

// ─── Main render function ──────────────────────────────────────────────────────

export async function renderVideo(
  jobId: string,
  jobDir: string,
  clips: ClipInput[],
  renderConfig?: RenderConfig,
  voiceoverPath?: string
): Promise<string> {
  await fs.mkdirp(OUTPUT_DIR);

  let finalVideoPath: string;
  let mergedCaptions: Caption[];
  let tempConcatDir: string | null = null;

  if (clips.length === 1) {
    finalVideoPath = clips[0].videoPath;
    mergedCaptions = clips[0].captions;
  } else {
    tempConcatDir = path.join("/tmp", `reel-concat-${jobId}`);
    await fs.mkdirp(tempConcatDir);
    ({ videoPath: finalVideoPath, captions: mergedCaptions } = await concatenateClips(clips, tempConcatDir));
  }

  // Set up a per-job Remotion project copied from the starter template
  const projectDir = await createJobProject(jobId, jobDir);
  const publicDir = path.join(projectDir, "public");

  const videoName = "reel.mp4";
  const captionsName = "reel.json";
  const voiceName = "voice.wav";
  const propsPath = path.join("/tmp", `props-${jobId}.json`);

  await fs.copy(finalVideoPath, path.join(publicDir, videoName), { overwrite: true });
  await fs.writeJson(path.join(publicDir, captionsName), mergedCaptions, { spaces: 2 });

  if (voiceoverPath) {
    await fs.copy(voiceoverPath, path.join(publicDir, voiceName), { overwrite: true });
  }

  const props = {
    src: `/${videoName}`,
    ...(voiceoverPath ? { voiceSrc: `/${voiceName}` } : {}),
    ...(renderConfig ? {
      style: renderConfig.style,
      events: renderConfig.events,
      musicSrc: renderConfig.musicSrc,
      musicVolume: voiceoverPath ? 0.10 : 0.18,
    } : {}),
  };
  await fs.writeJson(propsPath, props);

  const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);

  try {
    execSync(
      `npx remotion render CaptionedVideo "${outputPath}" --props="${propsPath}"`,
      { cwd: projectDir, stdio: "inherit" }
    );
  } finally {
    await fs.remove(propsPath).catch(() => {});
    if (tempConcatDir) await fs.remove(tempConcatDir).catch(() => {});
    // Clean up per-job Remotion project (unlinks node_modules symlink first, then rm -rf)
    await cleanupJobProject(projectDir).catch((e) =>
      console.warn(`[render] cleanup warning for ${projectDir}:`, e.message)
    );
  }

  return outputPath;
}

// ─── ffmpeg helpers ────────────────────────────────────────────────────────────

async function getClipDurationMs(clipPath: string): Promise<number> {
  const output = execSync(
    `npx remotion ffprobe -v quiet -print_format json -show_streams "${clipPath}"`,
    { cwd: TEMPLATE_DIR }
  ).toString();
  const data = JSON.parse(output);
  const stream = data.streams?.find((s: any) => s.codec_type === "video") ?? data.streams?.[0];
  return Math.round(parseFloat(stream.duration) * 1000);
}

async function concatenateClips(
  clips: ClipInput[],
  tempDir: string
): Promise<{ videoPath: string; captions: Caption[] }> {
  const concatListPath = path.join(tempDir, "concat.txt");
  const concatLines = clips.map((c) => `file '${c.videoPath}'`).join("\n");
  await fs.writeFile(concatListPath, concatLines);

  const outputPath = path.join(tempDir, "merged.mp4");
  execSync(
    `npx remotion ffmpeg -f concat -safe 0 -i "${concatListPath}" -c copy "${outputPath}" -y`,
    { cwd: TEMPLATE_DIR, stdio: "inherit" }
  );

  let offsetMs = 0;
  const mergedCaptions: Caption[] = [];

  for (const clip of clips) {
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
