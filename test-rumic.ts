import "dotenv/config";
import { generateVoiceover } from "./src/voiceover";

const script = "You have the power to change the world. Every great journey starts with one decision. Stop waiting. Start doing. The time is now.";

console.log("Testing Rumic TTS...");
console.log(`Script: "${script}"`);
console.log(`RUMIC_API_KEY: ${process.env.RUMIC_API_KEY ? "set ✓" : "MISSING ✗"}`);

generateVoiceover(script, "emotional", "high", "/tmp/rumic-test.wav")
  .then((result) => {
    console.log(`\n✅ SUCCESS`);
    console.log(`Audio saved: ${result.audioPath}`);
    console.log(`Captions: ${result.captions.length} words`);
    console.log(`First 5 words:`, result.captions.slice(0, 5));
  })
  .catch((err) => {
    console.error(`\n❌ FAILED: ${err.message}`);
  });
