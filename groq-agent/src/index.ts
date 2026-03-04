import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import sharp from "sharp";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {getSignedUrl} from "@aws-sdk/s3-request-presigner";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const ffprobeInstaller = require("@ffprobe-installer/ffprobe");

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

const s3 = new S3Client({region: process.env.AWS_REGION || "us-east-1"});
const bucket = process.env.S3_BUCKET;
const s3Prefix = normalizePrefix(process.env.S3_PREFIX || "ai-generated-assets");
const musicPrefix = normalizePrefix(process.env.MUSIC_PREFIX || "music");
const signedUrlTtlSeconds = parseInt(process.env.SIGNED_URL_TTL_SECONDS || "3600", 10);
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
const bgRemovalModel = process.env.BG_REMOVAL_MODEL || "Xenova/modnet";

let bgSegmenterPromise: Promise<any> | null = null;

type UploadAsset = {
  mimeType: string;
  data: string;
};

export async function processApiRequest(
  method: string,
  rawPath: string,
  payload: any
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!bucket) {
    return response(500, {
      error: "Missing required environment variable S3_BUCKET",
    });
  }

  const route = `${method} ${rawPath}`;

  if (method === "OPTIONS") {
    return response(200, {ok: true});
  }

  try {
    if (route === "POST /upload-asset") {
      return await handleUploadAsset(payload);
    }

    if (route === "POST /upload-image") {
      return await handleUploadImage(payload);
    }

    if (route === "POST /add-music") {
      return await handleAddMusic(payload);
    }

    if (route === "POST /remove-bg") {
      return await handleRemoveBackground(payload);
    }

    return response(404, {error: `Route not found: ${route}`});
  } catch (error: any) {
    console.error("Unhandled error", error);
    return response(500, {
      error: "Processing failed",
      details: error?.message || "Unknown error",
    });
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> => {
  const body = parseJsonBody(event);
  return processApiRequest(event.requestContext.http.method, event.rawPath, body);
};

async function handleUploadAsset(payload: any): Promise<APIGatewayProxyStructuredResultV2> {
  const source = payload?.body && typeof payload.body === "object" ? payload.body : payload;
  const assetsToProcess = extractAssets(source);

  if (assetsToProcess.length === 0) {
    return response(400, {
      error:
        "No valid assets found. Provide assets[] or Gemini/Imagen payload with base64 data.",
    });
  }

  const uploaded = await Promise.all(
    assetsToProcess.map(async (asset) => {
      const originalMime = asset.mimeType;
      const rawBuffer = Buffer.from(asset.data, "base64");

      const {buffer, mimeType} = await maybeConvertPcmToMp3(rawBuffer, originalMime);
      const key = buildS3Key(mimeType);

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ContentType: mimeType,
        })
      );

      const signedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({Bucket: bucket, Key: key}),
        {expiresIn: signedUrlTtlSeconds}
      );

      return {
        key,
        mimeType,
        signedUrl,
      };
    })
  );

  return response(200, {
    success: true,
    count: uploaded.length,
    assets: uploaded,
  });
}

async function handleUploadImage(payload: any): Promise<APIGatewayProxyStructuredResultV2> {
  if (!payload || typeof payload !== "object") {
    return response(400, {error: "Invalid JSON body"});
  }

  const source = payload?.body && typeof payload.body === "object" ? payload.body : payload;
  const imageInput = extractImagePayload(source);

  if (!imageInput) {
    return response(400, {
      error: "Provide one image using imageBase64/image/base64Data/data or assets[].",
    });
  }

  const mimeType = (imageInput.mimeType || "image/png").split(";")[0].toLowerCase();
  if (!mimeType.startsWith("image/")) {
    return response(400, {error: `Unsupported mimeType: ${mimeType}`});
  }

  const key = `${s3Prefix}/images/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${extensionFromMimeType(
    mimeType
  )}`;
  const buffer = Buffer.from(imageInput.base64, "base64");

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    })
  );

  const signedUrl = await getSignedUrl(s3, new GetObjectCommand({Bucket: bucket, Key: key}), {
    expiresIn: signedUrlTtlSeconds,
  });

  return response(200, {
    success: true,
    output: {
      key,
      s3Uri: `s3://${bucket}/${key}`,
      signedUrl,
      mimeType,
    },
  });
}

async function handleAddMusic(payload: any): Promise<APIGatewayProxyStructuredResultV2> {
  const tmpDir = os.tmpdir();
  const tempId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const inputPath = path.join(tmpDir, `input-${tempId}.mp4`);
  const musicPath = path.join(tmpDir, `music-${tempId}.mp3`);
  const outputPath = path.join(tmpDir, `output-${tempId}.mp4`);

  try {
    if (!payload || typeof payload !== "object") {
      return response(400, {error: "Invalid JSON body"});
    }

    const source = payload?.body && typeof payload.body === "object" ? payload.body : payload;
    await materializeVideoInput(source, inputPath);

    const selectedMusicKey = source.musicKey || (await pickRandomMusicKey());
    if (!selectedMusicKey) {
      return response(400, {
        error: "No background music found. Upload MP3 files under MUSIC_PREFIX in S3.",
      });
    }

    await downloadS3ObjectToFile(selectedMusicKey, musicPath);

    const metadata = await getVideoMetadata(inputPath);
    await runAddMusicFfmpeg({
      inputPath,
      musicPath,
      outputPath,
      hasAudio: metadata.hasAudio,
    });
    const outputBuffer = fs.readFileSync(outputPath);
    const outputMode = String(source.outputMode || payload?.outputMode || "").toLowerCase();

    if (outputMode === "file" || outputMode === "direct") {
      return binaryResponse("video/mp4", outputBuffer, `output-${tempId}.mp4`);
    }

    const outputKey = `${s3Prefix}/videos/${tempId}.mp4`;

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: outputKey,
        Body: outputBuffer,
        ContentType: "video/mp4",
      })
    );

    const signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({Bucket: bucket, Key: outputKey}),
      {expiresIn: signedUrlTtlSeconds}
    );

    return response(200, {
      success: true,
      output: {
        key: outputKey,
        signedUrl,
      },
      musicKey: selectedMusicKey,
      videoDurationSeconds: metadata.duration,
    });
  } finally {
    safeDelete(inputPath);
    safeDelete(musicPath);
    safeDelete(outputPath);
  }
}

async function handleRemoveBackground(payload: any): Promise<APIGatewayProxyStructuredResultV2> {
  if (!payload || typeof payload !== "object") {
    return response(400, {error: "Invalid JSON body"});
  }

  const source = payload?.body && typeof payload.body === "object" ? payload.body : payload;
  const imageInput = extractImagePayload(source);

  if (!imageInput) {
    return response(400, {
      error: "Provide one image using imageBase64/image/base64Data/data or assets[].",
    });
  }

  const inputBuffer = Buffer.from(imageInput.base64, "base64");
  const outputBuffer = await removeBackgroundFromImage(inputBuffer);
  const outputKey = `${s3Prefix}/images/${Date.now()}-${crypto.randomBytes(4).toString("hex")}-nobg.png`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: outputKey,
      Body: outputBuffer,
      ContentType: "image/png",
    })
  );

  const signedUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({Bucket: bucket, Key: outputKey}),
    {expiresIn: signedUrlTtlSeconds}
  );

  return response(200, {
    success: true,
    output: {
      key: outputKey,
      signedUrl,
      mimeType: "image/png",
    },
    model: bgRemovalModel,
  });
}

function parseJsonBody(event: APIGatewayProxyEventV2): any {
  if (!event.body) {
    return {};
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf-8")
    : event.body;

  return JSON.parse(rawBody);
}

function extractAssets(payload: any): UploadAsset[] {
  const assets: UploadAsset[] = [];

  if (Array.isArray(payload?.assets)) {
    for (const item of payload.assets) {
      if (item?.mimeType && (item?.data || item?.base64Data)) {
        assets.push({mimeType: item.mimeType, data: item.data || item.base64Data});
      }
    }
  }

  if (Array.isArray(payload?.candidates)) {
    for (const candidate of payload.candidates) {
      const parts = candidate?.content?.parts || [];
      for (const part of parts) {
        if (part?.inlineData?.mimeType && part?.inlineData?.data) {
          assets.push({
            mimeType: part.inlineData.mimeType,
            data: part.inlineData.data,
          });
        }
      }
    }
  }

  if (Array.isArray(payload?.predictions)) {
    for (const prediction of payload.predictions) {
      if (prediction?.bytesBase64Encoded) {
        assets.push({
          mimeType: prediction.mimeType || "image/png",
          data: prediction.bytesBase64Encoded,
        });
      }
    }
  }

  return assets;
}

async function maybeConvertPcmToMp3(
  buffer: Buffer,
  mimeType: string
): Promise<{buffer: Buffer; mimeType: string}> {
  if (!mimeType.startsWith("audio") || (!mimeType.includes("L16") && !mimeType.includes("pcm"))) {
    return {buffer, mimeType: mimeType.split(";")[0] || mimeType};
  }

  const params: Record<string, string> = {};
  for (const part of mimeType.split(";")) {
    const [key, value] = part.trim().split("=");
    if (key && value) {
      params[key] = value;
    }
  }

  const rate = params.rate || "24000";
  const channels = params.channels || "1";

  const tempInput = path.join(os.tmpdir(), `raw-input-${Date.now()}.pcm`);
  const tempOutput = path.join(os.tmpdir(), `output-${Date.now()}.mp3`);

  fs.writeFileSync(tempInput, buffer);

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(tempInput)
        .inputFormat("s16le")
        .inputOptions([`-ar ${rate}`])
        .audioChannels(parseInt(channels, 10))
        .audioCodec("libmp3lame")
        .save(tempOutput)
        .on("end", () => resolve())
        .on("error", (error) => reject(error));
    });

    return {
      buffer: fs.readFileSync(tempOutput),
      mimeType: "audio/mpeg",
    };
  } finally {
    safeDelete(tempInput);
    safeDelete(tempOutput);
  }
}

async function getVideoMetadata(filePath: string): Promise<{duration: number; hasAudio: boolean}> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (error, metadata) => {
      if (error) {
        reject(error);
        return;
      }

      const duration = metadata.format.duration || 0;
      const hasAudio = (metadata.streams || []).some((stream) => stream.codec_type === "audio");
      resolve({duration, hasAudio});
    });
  });
}

async function runAddMusicFfmpeg(options: {
  inputPath: string;
  musicPath: string;
  outputPath: string;
  hasAudio: boolean;
}): Promise<void> {
  const command = ffmpeg(options.inputPath).input(options.musicPath);

  if (options.hasAudio) {
    const filterComplex = [
      "[0:a]aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp[video_audio]",
      "[1:a]aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp,volume=0.5[bg_music]",
      "[video_audio][bg_music]amix=inputs=2:duration=first:dropout_transition=2[aout]",
    ];

    command
      .complexFilter(filterComplex)
      .outputOptions([
        "-map 0:v:0",
        "-map [aout]",
        "-c:v copy",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ]);
  } else {
    command.outputOptions([
      "-map 0:v:0",
      "-map 1:a:0",
      "-c:v copy",
      "-c:a aac",
      "-shortest",
    ]);
  }

  await new Promise<void>((resolve, reject) => {
    command
      .save(options.outputPath)
      .on("end", () => resolve())
      .on("error", (error) => reject(error));
  });
}

async function materializeVideoInput(payload: any, outPath: string): Promise<void> {
  const directBase64 =
    payload?.videoBase64 ||
    payload?.video ||
    payload?.base64Data ||
    payload?.binaryData ||
    payload?.data;

  if (typeof directBase64 === "string" && directBase64.length > 0) {
    const base64 = directBase64.includes(",") ? directBase64.split(",").pop()! : directBase64;
    fs.writeFileSync(outPath, Buffer.from(base64, "base64"));
    return;
  }

  if (typeof payload.videoUrl === "string" && payload.videoUrl.startsWith("s3://")) {
    const {sourceBucket, key} = parseS3Uri(payload.videoUrl);
    await downloadS3ObjectToFile(key, outPath, sourceBucket);
    return;
  }

  if (typeof payload.videoUrl === "string" && /^https?:\/\//.test(payload.videoUrl)) {
    const response = await fetch(payload.videoUrl);
    if (!response.ok) {
      throw new Error(`Failed to download videoUrl: ${response.status} ${response.statusText}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outPath, data);
    return;
  }

  if (typeof payload.videoKey === "string" && payload.videoKey.length > 0) {
    await downloadS3ObjectToFile(payload.videoKey, outPath);
    return;
  }

  throw new Error(
    "Provide one of: videoBase64/video/base64Data/binaryData/data, videoUrl, or videoKey"
  );
}

async function pickRandomMusicKey(): Promise<string | null> {
  const listed = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${musicPrefix}/`,
      MaxKeys: 1000,
    })
  );

  const candidates = (listed.Contents || [])
    .map((item) => item.Key)
    .filter((key): key is string => !!key && key.toLowerCase().endsWith(".mp3"));

  if (candidates.length === 0) {
    return null;
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function downloadS3ObjectToFile(
  key: string,
  outPath: string,
  sourceBucket = bucket!
): Promise<void> {
  const object = await s3.send(
    new GetObjectCommand({
      Bucket: sourceBucket,
      Key: key,
    })
  );

  const data = await bodyToBuffer(object.Body);
  fs.writeFileSync(outPath, data);
}

async function bodyToBuffer(body: any): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (typeof body.transformToByteArray === "function") {
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }

  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new Error("Unsupported S3 body stream type");
}

async function removeBackgroundFromImage(inputBuffer: Buffer): Promise<Buffer> {
  const tempInput = path.join(os.tmpdir(), `remove-bg-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`);

  try {
    fs.writeFileSync(tempInput, inputBuffer);

    const segmenter = await getBgSegmenter();
    const segments = await segmenter(tempInput, {
      threshold: 0.5,
      mask_threshold: 0.5,
    });

    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error("Segmentation returned no masks");
    }

    const {alpha, width: maskWidth, height: maskHeight} = mergeSegmentationMasks(segments);
    const prepared = sharp(inputBuffer).ensureAlpha();
    const {data: rgba, info} = await prepared.raw().toBuffer({resolveWithObject: true});

    let resizedAlpha: Buffer = Buffer.from(alpha);
    if (maskWidth !== info.width || maskHeight !== info.height) {
      resizedAlpha = await sharp(Buffer.from(alpha), {
        raw: {
          width: maskWidth,
          height: maskHeight,
          channels: 1,
        },
      })
        .resize(info.width, info.height, {fit: "fill"})
        .raw()
        .toBuffer();
    }

    for (let i = 0; i < info.width * info.height; i++) {
      rgba[i * 4 + 3] = resizedAlpha[i];
    }

    return sharp(rgba, {
      raw: {
        width: info.width,
        height: info.height,
        channels: 4,
      },
    })
      .png()
      .toBuffer();
  } finally {
    safeDelete(tempInput);
  }
}

async function getBgSegmenter(): Promise<any> {
  if (!bgSegmenterPromise) {
    bgSegmenterPromise = (async () => {
      const transformers = await import("@xenova/transformers");
      transformers.env.allowLocalModels = false;
      return transformers.pipeline("image-segmentation", bgRemovalModel);
    })();
  }

  return bgSegmenterPromise;
}

function mergeSegmentationMasks(segments: any[]): {alpha: Uint8Array; width: number; height: number} {
  const nonBackground = segments.filter((segment) => {
    const label = String(segment?.label || "").toLowerCase();
    return !label.includes("background") && label !== "bg";
  });

  const selected = nonBackground.length > 0 ? nonBackground : segments;
  const firstMask = selected[0]?.mask;
  if (!firstMask?.data || !firstMask?.width || !firstMask?.height) {
    throw new Error("Invalid segmentation mask output");
  }

  const width = firstMask.width;
  const height = firstMask.height;
  const alpha = new Uint8Array(width * height);

  for (const segment of selected) {
    const mask = segment?.mask;
    if (!mask?.data || mask.width !== width || mask.height !== height) {
      continue;
    }

    const channels = mask.channels || 1;
    for (let i = 0; i < width * height; i++) {
      const value = channels === 1 ? mask.data[i] : mask.data[i * channels];
      if (value > alpha[i]) {
        alpha[i] = value;
      }
    }
  }

  return {alpha, width, height};
}

function extractImagePayload(payload: any): {mimeType: string; base64: string} | null {
  const direct = payload?.imageBase64 || payload?.image || payload?.base64Data || payload?.data;
  if (typeof direct === "string" && direct.length > 0) {
    return parseBase64Data(direct, payload?.mimeType || "image/png");
  }

  if (Array.isArray(payload?.assets)) {
    const firstImage = payload.assets.find((asset: any) => {
      const mimeType = String(asset?.mimeType || "").toLowerCase();
      return mimeType.startsWith("image/") && (asset?.data || asset?.base64Data);
    });

    if (firstImage) {
      return parseBase64Data(firstImage.data || firstImage.base64Data, firstImage.mimeType);
    }
  }

  return null;
}

function parseBase64Data(raw: string, fallbackMimeType: string): {mimeType: string; base64: string} {
  const trimmed = raw.trim();
  const dataUrlMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    return {
      mimeType: dataUrlMatch[1],
      base64: dataUrlMatch[2],
    };
  }

  return {
    mimeType: fallbackMimeType,
    base64: trimmed,
  };
}

function buildS3Key(mimeType: string): string {
  const extension = extensionFromMimeType(mimeType);
  const fileName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${extension}`;
  return `${s3Prefix}/${fileName}`;
}

function extensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0].toLowerCase();

  if (normalized.includes("png")) return "png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("mp4")) return "mp4";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("ogg")) return "ogg";

  return "bin";
}

function parseS3Uri(uri: string): {sourceBucket: string; key: string} {
  const withoutProtocol = uri.replace("s3://", "");
  const firstSlash = withoutProtocol.indexOf("/");

  if (firstSlash === -1) {
    throw new Error(`Invalid S3 URI: ${uri}`);
  }

  return {
    sourceBucket: withoutProtocol.slice(0, firstSlash),
    key: withoutProtocol.slice(firstSlash + 1),
  };
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function safeDelete(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.warn(`Failed to delete temp file ${filePath}`, error);
  }
}

function response(statusCode: number, body: Record<string, unknown>): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "OPTIONS,POST",
    },
    body: JSON.stringify(body),
  };
}

function binaryResponse(
  contentType: string,
  buffer: Buffer,
  fileName: string
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 200,
    isBase64Encoded: true,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename=\"${fileName}\"`,
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "OPTIONS,POST",
    },
    body: buffer.toString("base64"),
  };
}
