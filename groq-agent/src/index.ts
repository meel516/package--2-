import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {Readable} from "stream";
import {pipeline} from "stream/promises";
import ffmpeg from "fluent-ffmpeg";
import {removeBackground as removeBackgroundNode} from "@imgly/background-removal-node";
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
const signedUrlTtlSeconds = parseInt(process.env.SIGNED_URL_TTL_SECONDS || "604800", 10);
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
const bgRemovalEngine = "@imgly/background-removal-node";
const bgRemovalModelSize = (process.env.BG_REMOVAL_MODEL_SIZE || "small").toLowerCase();
const rmbgModelId = "briaai/RMBG-1.4";
const defringeWhitenessFactor = clamp01(
  parseFloat(process.env.DEFRINGE_WHITENESS_FACTOR || "0.85")
);
let rmbgSegmenterPromise: Promise<any> | null = null;
const heavyJobConcurrency = Math.max(
  1,
  parseInt(process.env.HEAVY_JOB_CONCURRENCY || "2", 10) || 2
);
let activeHeavyJobs = 0;
const heavyJobWaiters: Array<() => void> = [];

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

    if (route === "POST /remove-bg-asset") {
      return await withHeavyJobLimit(() => handleRemoveBackgroundAsset(payload));
    }

    if (route === "POST /testing") {
      return await withHeavyJobLimit(() => handleTesting(payload));
    }

    if (route === "POST /add-music") {
      return await withHeavyJobLimit(() => handleAddMusic(payload));
    }

    if (route === "POST /remove-bg") {
      return await withHeavyJobLimit(() => handleRemoveBackground(payload));
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

export async function getS3ToolsInfo(prefixOverride?: string, maxKeys = 100): Promise<{
  bucket: string | undefined;
  region: string;
  s3Prefix: string;
  musicPrefix: string;
  effectivePrefix: string;
  maxKeys: number;
  totalReturned: number;
  files: Array<{key: string; size: number; lastModified: string | null}>;
}> {
  const effectivePrefix = normalizePrefix(prefixOverride || musicPrefix || "");
  const safeMaxKeys = Math.min(Math.max(1, maxKeys), 500);

  if (!bucket) {
    return {
      bucket,
      region: process.env.AWS_REGION || "us-east-1",
      s3Prefix,
      musicPrefix,
      effectivePrefix,
      maxKeys: safeMaxKeys,
      totalReturned: 0,
      files: [],
    };
  }

  const listed = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: effectivePrefix ? `${effectivePrefix}/` : undefined,
      MaxKeys: safeMaxKeys,
    })
  );

  const files = (listed.Contents || [])
    .filter((item): item is {Key: string; Size?: number; LastModified?: Date} => !!item.Key)
    .map((item) => ({
      key: item.Key,
      size: Number(item.Size || 0),
      lastModified: item.LastModified ? item.LastModified.toISOString() : null,
    }));

  return {
    bucket,
    region: process.env.AWS_REGION || "us-east-1",
    s3Prefix,
    musicPrefix,
    effectivePrefix,
    maxKeys: safeMaxKeys,
    totalReturned: files.length,
    files,
  };
}


export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> => {
  const body = parseRequestBody(event);
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

  const uploaded: Array<{key: string; mimeType: string; signedUrl: string}> = [];
  for (const asset of assetsToProcess) {
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

    uploaded.push({
      key,
      mimeType,
      signedUrl,
    });
  }

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
  const buffer = imagePayloadToBuffer(imageInput);

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
    const outputMode = String(source.outputMode || payload?.outputMode || "").toLowerCase();

    if (outputMode === "file" || outputMode === "direct") {
      const outputBuffer = fs.readFileSync(outputPath);
      return binaryResponse("video/mp4", outputBuffer, `output-${tempId}.mp4`);
    }

    const outputKey = `${s3Prefix}/videos/${tempId}.mp4`;

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: outputKey,
        Body: fs.createReadStream(outputPath),
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

  const inputBuffer = imagePayloadToBuffer(imageInput);
  const outputBuffer = await removeBackgroundFromImage(inputBuffer, imageInput.mimeType);
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
    model: bgRemovalEngine,
  });
}

async function handleRemoveBackgroundAsset(payload: any): Promise<APIGatewayProxyStructuredResultV2> {
  if (!payload || typeof payload !== "object") {
    return response(400, {error: "Invalid JSON body"});
  }

  const source = payload?.body && typeof payload.body === "object" ? payload.body : payload;
  const imageAssets = extractAssets(source).filter((asset) =>
    String(asset.mimeType || "").toLowerCase().startsWith("image/")
  );
  const singleImage = imageAssets.length === 0 ? extractImagePayload(source) : null;

  if (imageAssets.length === 0 && !singleImage) {
    return response(400, {
      error:
        "No image assets found. Provide assets[]/Gemini inlineData or imageBase64/image/base64Data/data.",
    });
  }

  const outputs: Array<{key: string; signedUrl: string; mimeType: string}> = [];
  const assetsToProcess =
    imageAssets.length > 0
      ? imageAssets.map((asset) => Buffer.from(asset.data, "base64"))
      : [imagePayloadToBuffer(singleImage!)];

  for (const inputBuffer of assetsToProcess) {
    const outputBuffer = await removeBackgroundWithRmbg(inputBuffer);
    const key = `${s3Prefix}/images/${Date.now()}-${crypto.randomBytes(4).toString("hex")}-rmbg.png`;

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: outputBuffer,
        ContentType: "image/png",
      })
    );

    const signedUrl = await getSignedUrl(s3, new GetObjectCommand({Bucket: bucket, Key: key}), {
      expiresIn: signedUrlTtlSeconds,
    });

    outputs.push({
      key,
      signedUrl,
      mimeType: "image/png",
    });
  }

  if (imageAssets.length === 0 && singleImage) {
    return response(200, {
      success: true,
      output: outputs[0],
      model: rmbgModelId,
      engine: "@huggingface/transformers",
    });
  }

  return response(200, {
    success: true,
    count: outputs.length,
    outputs,
    model: rmbgModelId,
    engine: "@huggingface/transformers",
  });
}

async function handleTesting(payload: any): Promise<APIGatewayProxyStructuredResultV2> {
  if (!payload || typeof payload !== "object") {
    return response(400, {error: "Invalid JSON body"});
  }

  const source = payload?.body && typeof payload.body === "object" ? payload.body : payload;
  const imageInput = extractImagePayload(source);
  if (!imageInput) {
    return response(400, {
      error: "Provide imageBase64/image/base64Data/data or assets[].",
    });
  }

  const inputBuffer = imagePayloadToBuffer(imageInput);
  const outputBuffer = await removeBackgroundWithRmbg(inputBuffer);

  return response(200, {
    success: true,
    output: {
      mimeType: "image/png",
      imageBase64: outputBuffer.toString("base64"),
    },
    model: rmbgModelId,
    engine: "@huggingface/transformers",
  });
}

function parseRequestBody(event: APIGatewayProxyEventV2): any {
  if (!event.body) {
    return {};
  }

  const contentType = getHeader(event.headers, "content-type").toLowerCase();
  const rawBuffer = event.isBase64Encoded
    ? Buffer.from(event.body, "base64")
    : Buffer.from(event.body, "utf-8");

  if (contentType.includes("multipart/form-data")) {
    return parseMultipartBody(rawBuffer, contentType);
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(rawBuffer.toString("utf-8")));
  }

  const rawBody = rawBuffer.toString("utf-8");
  if (!rawBody.trim()) {
    return {};
  }

  return JSON.parse(rawBody);
}

function getHeader(headers: APIGatewayProxyEventV2["headers"] | undefined, name: string): string {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === lowerName) {
      return String(value || "");
    }
  }
  return "";
}

function parseMultipartBody(body: Buffer, contentType: string): Record<string, unknown> {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) {
    throw new Error("Missing multipart boundary");
  }

  const payload: Record<string, unknown> = {};
  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = body.indexOf(delimiter);

  while (cursor !== -1) {
    let partStart = cursor + delimiter.length;
    if (body.slice(partStart, partStart + 2).toString("utf-8") === "--") {
      break;
    }
    if (body.slice(partStart, partStart + 2).toString("utf-8") === "\r\n") {
      partStart += 2;
    }

    const next = body.indexOf(delimiter, partStart);
    if (next === -1) {
      break;
    }

    let part = body.slice(partStart, next);
    if (part.slice(-2).toString("utf-8") === "\r\n") {
      part = part.slice(0, -2);
    }

    addMultipartPartToPayload(payload, part);
    cursor = next;
  }

  return payload;
}

function addMultipartPartToPayload(payload: Record<string, unknown>, part: Buffer): void {
  const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
  if (headerEnd === -1) {
    return;
  }

  const rawHeaders = part.slice(0, headerEnd).toString("utf-8");
  const content = part.slice(headerEnd + 4);
  const headers = parseMultipartHeaders(rawHeaders);
  const disposition = headers["content-disposition"] || "";
  const name = disposition.match(/name="([^"]+)"/i)?.[1];
  const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
  if (!name) {
    return;
  }

  const mimeType = headers["content-type"] || "application/octet-stream";
  if (filename) {
    if (mimeType.toLowerCase().startsWith("image/")) {
      payload.imageBuffer = content;
      payload.mimeType = mimeType;
      return;
    }

    if (mimeType.toLowerCase().startsWith("video/") || name === "video") {
      payload.videoBuffer = content;
      payload.mimeType = mimeType;
      return;
    }

    payload[`${name}Buffer`] = content;
    payload[`${name}MimeType`] = mimeType;
    return;
  }

  payload[name] = parseMaybeJsonField(content.toString("utf-8"));
}

function parseMultipartHeaders(rawHeaders: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of rawHeaders.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[key] = value;
  }
  return headers;
}

function parseMaybeJsonField(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
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
  if (Buffer.isBuffer(payload?.videoBuffer)) {
    fs.writeFileSync(outPath, payload.videoBuffer);
    return;
  }

  const directBase64 =
    payload?.videoBase64 ||
    payload?.video ||
    payload?.base64Data ||
    payload?.binaryData ||
    payload?.data;

  if (typeof directBase64 === "string" && directBase64.length > 0) {
    const base64 = directBase64.includes(",") ? directBase64.split(",").pop()! : directBase64;
    fs.writeFileSync(outPath, base64, {encoding: "base64"});
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

    if (!response.body) {
      throw new Error("Failed to download videoUrl: missing response body");
    }

    await pipeline(Readable.fromWeb(response.body as any), fs.createWriteStream(outPath));
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

  await writeBodyToFile(object.Body, outPath);
}

async function writeBodyToFile(body: any, outPath: string): Promise<void> {
  if (!body) {
    fs.writeFileSync(outPath, Buffer.alloc(0));
    return;
  }

  if (typeof body.pipe === "function") {
    await pipeline(body, fs.createWriteStream(outPath));
    return;
  }

  if (typeof body[Symbol.asyncIterator] === "function") {
    const writable = fs.createWriteStream(outPath);
    try {
      for await (const chunk of body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!writable.write(buffer)) {
          await new Promise<void>((resolve, reject) => {
            writable.once("drain", resolve);
            writable.once("error", reject);
          });
        }
      }
      await new Promise<void>((resolve, reject) => {
        writable.end(() => resolve());
        writable.once("error", reject);
      });
    } catch (error) {
      writable.destroy();
      throw error;
    }
    return;
  }

  const data = await bodyToBuffer(body);
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

async function removeBackgroundFromImage(inputBuffer: Buffer, mimeType: string): Promise<Buffer> {
  const modelCandidates = Array.from(
    new Set([bgRemovalModelSize, "small", "medium"].filter((x) => x === "small" || x === "medium"))
  );
  const errors: string[] = [];
  let blob: Blob | null = null;
  const normalizedMimeType = normalizeImageMimeType(mimeType);
  const preprocessed = await preprocessInputToPngWithAlpha(inputBuffer, normalizedMimeType);
  const sourceBlob = new Blob([new Uint8Array(preprocessed)], {type: "image/png"});

  for (const model of modelCandidates) {
    try {
      blob = (await removeBackgroundNode(sourceBlob, {
        model,
        output: {
          format: "image/png",
          type: "foreground",
          quality: 1,
        },
      } as any)) as Blob;
      break;
    } catch (error: any) {
      errors.push(`${model}: ${error?.message || "unknown error"}`);
    }
  }

  if (!blob) {
    throw new Error(`Background removal failed. ${errors.join(" | ")}`);
  }

  const outputBuffer = Buffer.from(await blob.arrayBuffer());
  return defringeWhiteEdges(outputBuffer, defringeWhitenessFactor);
}

async function removeBackgroundWithRmbg(inputBuffer: Buffer): Promise<Buffer> {
  const tempInput = path.join(os.tmpdir(), `rmbg-input-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`);

  try {
    const preprocessed = await preprocessInputToPngWithAlpha(inputBuffer, "image/png");
    fs.writeFileSync(tempInput, preprocessed);
    const segmenter = await getRmbgSegmenter();
    const segments = await segmenter(tempInput, {threshold: 0.5, mask_threshold: 0.5});

    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error("RMBG returned no mask");
    }

    const mask = segments[0]?.mask;
    if (!mask?.data || !mask?.width || !mask?.height) {
      throw new Error("Invalid RMBG mask output");
    }

    const base = sharp(inputBuffer).ensureAlpha();
    const {data: rgba, info} = await base.raw().toBuffer({resolveWithObject: true});

    let alpha = Buffer.from(mask.data);
    if (mask.width !== info.width || mask.height !== info.height) {
      alpha = await sharp(Buffer.from(mask.data), {
        raw: {
          width: mask.width,
          height: mask.height,
          channels: 1,
        },
      })
        .resize(info.width, info.height, {fit: "fill"})
        .raw()
        .toBuffer();
    }

    for (let i = 0; i < info.width * info.height; i++) {
      rgba[i * 4 + 3] = alpha[i];
    }

    const outputBuffer = await sharp(rgba, {
      raw: {
        width: info.width,
        height: info.height,
        channels: 4,
      },
    })
      .png()
      .toBuffer();

    return defringeWhiteEdges(outputBuffer, defringeWhitenessFactor);
  } finally {
    safeDelete(tempInput);
  }
}

async function preprocessInputToPngWithAlpha(inputBuffer: Buffer, mimeType: string): Promise<Buffer> {
  if (mimeType === "image/png") {
    return sharp(inputBuffer).ensureAlpha().png().toBuffer();
  }

  return sharp(inputBuffer)
    .ensureAlpha()
    .png()
    .toBuffer();
}

async function defringeWhiteEdges(inputBuffer: Buffer, whitenessFactor: number): Promise<Buffer> {
  if (whitenessFactor <= 0) {
    return inputBuffer;
  }

  const {data: rgba, info} = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({resolveWithObject: true});

  const width = info.width;
  const height = info.height;
  const total = width * height;

  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    const a = rgba[idx + 3];
    if (a <= 0 || a >= 255) {
      continue;
    }

    const r = rgba[idx];
    const g = rgba[idx + 1];
    const b = rgba[idx + 2];
    const whiteness = Math.min(r, g, b) / 255;

    if (whiteness < whitenessFactor) {
      continue;
    }

    const alpha = a / 255;
    const invAlpha = 1 / alpha;
    const newR = clamp255((r - 255 * (1 - alpha)) * invAlpha);
    const newG = clamp255((g - 255 * (1 - alpha)) * invAlpha);
    const newB = clamp255((b - 255 * (1 - alpha)) * invAlpha);

    rgba[idx] = newR;
    rgba[idx + 1] = newG;
    rgba[idx + 2] = newB;
  }

  return sharp(rgba, {
    raw: {
      width,
      height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

async function getRmbgSegmenter(): Promise<any> {
  if (!rmbgSegmenterPromise) {
    rmbgSegmenterPromise = (async () => {
      const transformers = await import("@huggingface/transformers");
      transformers.env.allowLocalModels = false;
      transformers.env.cacheDir = "/tmp/hf-cache";
      return transformers.pipeline("image-segmentation", rmbgModelId);
    })();
  }

  return rmbgSegmenterPromise;
}

function extractImagePayload(payload: any): {mimeType: string; base64?: string; buffer?: Buffer} | null {
  if (Buffer.isBuffer(payload?.imageBuffer)) {
    return {
      mimeType: normalizeImageMimeType(payload?.mimeType || "image/png"),
      buffer: payload.imageBuffer,
    };
  }

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

function imagePayloadToBuffer(input: {mimeType: string; base64?: string; buffer?: Buffer}): Buffer {
  if (input.buffer) {
    return input.buffer;
  }
  return Buffer.from(input.base64 || "", "base64");
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
    mimeType: normalizeImageMimeType(fallbackMimeType),
    base64: trimmed,
  };
}

function normalizeImageMimeType(mimeType: string): string {
  const normalized = String(mimeType || "").split(";")[0].trim().toLowerCase();
  if (normalized === "image/jpg") {
    return "image/jpeg";
  }

  if (normalized === "image/jpeg" || normalized === "image/png" || normalized === "image/webp") {
    return normalized;
  }

  return "application/octet-stream";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function clamp255(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
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

async function withHeavyJobLimit<T>(work: () => Promise<T>): Promise<T> {
  await acquireHeavyJobSlot();
  try {
    return await work();
  } finally {
    releaseHeavyJobSlot();
  }
}

async function acquireHeavyJobSlot(): Promise<void> {
  if (activeHeavyJobs < heavyJobConcurrency) {
    activeHeavyJobs += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    heavyJobWaiters.push(() => {
      activeHeavyJobs += 1;
      resolve();
    });
  });
}

function releaseHeavyJobSlot(): void {
  activeHeavyJobs = Math.max(0, activeHeavyJobs - 1);
  const next = heavyJobWaiters.shift();
  if (next) {
    next();
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
