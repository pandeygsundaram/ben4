import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs-extra";
import path from "path";

const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  },
});

const BUCKET = process.env.R2_BUCKET_NAME ?? "simple-storage";

export async function uploadReelToR2(filePath: string, jobId: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const key = `reels/${jobId}.mp4`;

  await r2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: "video/mp4",
  }));

  console.log(`[r2] uploaded ${key} (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)`);

  // Signed URL valid for 24 hours
  const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 86400 });
  return url;
}
