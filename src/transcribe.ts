import Groq from "groq-sdk";
import fs from "fs";
import path from "path";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export type Caption = {
  text: string;
  startMs: number;
  endMs: number;
};

export async function transcribeVideo(videoPath: string): Promise<Caption[]> {
  const sizeMB = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(2);
  console.log(`[transcribe] → Groq whisper-large-v3`);
  console.log(`[transcribe] file: ${path.basename(videoPath)} (${sizeMB} MB)`);

  const transcription = await groq.audio.transcriptions.create({
    file: fs.createReadStream(videoPath),
    model: "whisper-large-v3",
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
  });

  const words = (transcription as any).words ?? [];
  console.log(`[transcribe] ✓ got ${words.length} words from Groq`);

  return words.map((w: any) => ({
    text: w.word,
    startMs: Math.round(w.start * 1000),
    endMs: Math.round(w.end * 1000),
  }));
}
