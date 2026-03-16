import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, "tmp");
mkdirSync(TMP_DIR, { recursive: true });

const FFMPEG = "/opt/homebrew/bin/ffmpeg";

// Load Groq key from config if available
let groqApiKey = null;
try {
  const config = JSON.parse(readFileSync(join(__dirname, "..", "config.json"), "utf-8"));
  groqApiKey = config.groqApiKey || null;
} catch {}

let voiceLang = "ru";

export function getVoiceLang() { return voiceLang; }
export function setVoiceLang(lang) { voiceLang = lang; }

export async function transcribeVoice(fileId, botToken) {
  // 1. Download from Telegram
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
  const data = await res.json();
  if (!data.ok) throw new Error("Failed to get file info");

  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`;
  const oggPath = join(TMP_DIR, `${fileId}.ogg`);

  const fileRes = await fetch(fileUrl);
  writeFileSync(oggPath, Buffer.from(await fileRes.arrayBuffer()));

  try {
    // 2. Try Groq API first (Whisper large-v3, fast, free)
    if (groqApiKey) {
      return await transcribeGroq(oggPath);
    }
    // 3. Fallback: local Whisper
    return await transcribeLocal(oggPath);
  } finally {
    try { unlinkSync(oggPath); } catch {}
  }
}

async function transcribeGroq(oggPath) {
  const { FormData, File } = globalThis;
  const fileBuffer = readFileSync(oggPath);
  const form = new FormData();
  form.append("file", new File([fileBuffer], "audio.ogg", { type: "audio/ogg" }));
  form.append("model", "whisper-large-v3");
  if (voiceLang !== "auto") form.append("language", voiceLang);

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${groqApiKey}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.text?.trim() || "";
}

async function transcribeLocal(oggPath) {
  const wavPath = oggPath.replace(".ogg", ".wav");

  // Convert ogg → wav
  await new Promise((resolve, reject) => {
    execFile(FFMPEG, ["-i", oggPath, "-ar", "16000", "-ac", "1", "-y", wavPath], {
      timeout: 30000,
    }, (err) => err ? reject(err) : resolve());
  });

  try {
    const text = await new Promise((resolve, reject) => {
      execFile("python3", ["-c", `
import whisper
model = whisper.load_model("small")
lang = "${voiceLang}" if "${voiceLang}" != "auto" else None
result = model.transcribe("${wavPath}", language=lang)
print(result["text"])
`], { timeout: 120000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
    return text;
  } finally {
    try { unlinkSync(wavPath); } catch {}
  }
}
