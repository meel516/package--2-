import express from "express";
import multer from "multer";
import {processApiRequest} from "./index";
import type {APIGatewayProxyStructuredResultV2} from "aws-lambda";

const app = express();
const port = parseInt(process.env.PORT || "3003", 10);
const upload = multer({storage: multer.memoryStorage()});

app.use(express.json({limit: "50mb"}));

app.use(async (req, res, next) => {
  if (req.method !== "OPTIONS") {
    next();
    return;
  }

  const result = await processApiRequest("OPTIONS", req.path, {});
  sendResult(res, result);
});

app.post("/upload-asset", async (req, res) => {
  const result = await processApiRequest("POST", "/upload-asset", req.body || {});
  sendResult(res, result);
});

app.post("/upload-image", upload.any(), async (req, res) => {
  const payload: Record<string, unknown> = {
    ...(req.body || {}),
  };

  const file = firstUploadedFile(req);
  if (file?.buffer?.length) {
    payload.imageBase64 = file.buffer.toString("base64");
    payload.mimeType = file.mimetype || "image/png";
  }

  const result = await processApiRequest("POST", "/upload-image", payload);
  sendResult(res, result);
});

app.post("/remove-bg", upload.any(), async (req, res) => {
  const payload: Record<string, unknown> = {
    ...(req.body || {}),
  };

  const file = firstUploadedFile(req);
  if (file?.buffer?.length) {
    payload.imageBase64 = file.buffer.toString("base64");
    payload.mimeType = file.mimetype || "image/png";
  }

  const result = await processApiRequest("POST", "/remove-bg", payload);
  sendResult(res, result);
});

app.post("/add-music", upload.single("video"), async (req, res) => {
  const payload: Record<string, unknown> = {
    ...(req.body || {}),
  };

  if (req.file?.buffer?.length) {
    payload.videoBase64 = req.file.buffer.toString("base64");
    if (!payload.outputMode) {
      payload.outputMode = "file";
    }
  }

  const result = await processApiRequest("POST", "/add-music", payload);
  sendResult(res, result);
});

app.get("/welcome", (_req, res) => {
  res.status(200).type("html").send("<h1>Welcome to Saleems Blog</h1>");
});

app.get("/tools", (_req, res) => {
  res.status(200).type("html").send(TOOLS_HTML);
});

app.get("/health", (_req, res) => {
  res.status(200).json({ok: true});
});

app.listen(port, () => {
  console.log(`EC2 API server running on port ${port}`);
});

function sendResult(res: express.Response, result: APIGatewayProxyStructuredResultV2) {
  if (result.headers) {
    for (const [key, value] of Object.entries(result.headers)) {
      res.setHeader(key, String(value));
    }
  }

  res.status(result.statusCode ?? 200);

  if (result.body && (result as any).isBase64Encoded) {
    res.send(Buffer.from(result.body, "base64"));
    return;
  }

  if (!result.body) {
    res.end();
    return;
  }

  try {
    res.json(JSON.parse(result.body));
  } catch {
    res.send(result.body);
  }
}

function firstUploadedFile(req: express.Request): Express.Multer.File | null {
  if (req.file) {
    return req.file;
  }

  const files = req.files as Express.Multer.File[] | undefined;
  if (Array.isArray(files) && files.length > 0) {
    return files[0];
  }

  return null;
}

const TOOLS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Image Tools</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 24px; background: #f4f7fb; color: #0f172a; }
    .wrap { max-width: 900px; margin: 0 auto; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; margin-bottom: 18px; }
    h1 { margin: 0 0 16px; font-size: 28px; }
    h2 { margin: 0 0 10px; font-size: 20px; }
    label { display: block; margin: 10px 0 6px; font-weight: 600; }
    input[type="text"], input[type="file"] { width: 100%; padding: 10px; box-sizing: border-box; }
    button { margin-top: 12px; padding: 10px 14px; border: 0; border-radius: 8px; background: #0f172a; color: #fff; cursor: pointer; }
    button:hover { background: #1e293b; }
    .out { margin-top: 12px; padding: 10px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; word-break: break-all; }
    img { max-width: 280px; max-height: 280px; border: 1px solid #cbd5e1; border-radius: 8px; margin-top: 10px; background: #fff; }
    .error { color: #b91c1c; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Image Upload Tools</h1>
    <div class="card">
      <label for="apiBase">API Base URL</label>
      <input id="apiBase" type="text" placeholder="https://your-api-domain.com" />
    </div>

    <div class="card">
      <h2>1) Upload Image And Get URL</h2>
      <input id="normalImage" type="file" accept="image/*" />
      <button id="uploadBtn">Upload Image</button>
      <div id="uploadOut" class="out"></div>
    </div>

    <div class="card">
      <h2>2) Remove Background And Get URL</h2>
      <input id="bgImage" type="file" accept="image/*" />
      <button id="removeBtn">Remove Background</button>
      <div id="removeOut" class="out"></div>
      <img id="preview" alt="Result preview" style="display:none;" />
    </div>
  </div>

  <script>
    const apiBaseInput = document.getElementById('apiBase');
    apiBaseInput.value = window.location.origin;

    function getApiBase() {
      const v = apiBaseInput.value.trim();
      return v || window.location.origin;
    }

    function renderError(el, message) {
      el.innerHTML = '<div class="error">' + message + '</div>';
    }

    document.getElementById('uploadBtn').addEventListener('click', async () => {
      const out = document.getElementById('uploadOut');
      const fileInput = document.getElementById('normalImage');
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        renderError(out, 'Please choose an image file.');
        return;
      }

      out.textContent = 'Uploading...';
      const formData = new FormData();
      formData.append('image', file);

      try {
        const res = await fetch(getApiBase() + '/upload-image', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok || !data.success) {
          renderError(out, data.error || 'Upload failed');
          return;
        }
        out.innerHTML = 'URL: <a target="_blank" href="' + data.output.signedUrl + '">' + data.output.signedUrl + '</a>';
      } catch (err) {
        renderError(out, 'Upload failed: ' + (err.message || String(err)));
      }
    });

    document.getElementById('removeBtn').addEventListener('click', async () => {
      const out = document.getElementById('removeOut');
      const preview = document.getElementById('preview');
      const fileInput = document.getElementById('bgImage');
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        renderError(out, 'Please choose an image file.');
        return;
      }

      out.textContent = 'Removing background... first run may take longer.';
      preview.style.display = 'none';
      const formData = new FormData();
      formData.append('image', file);

      try {
        const res = await fetch(getApiBase() + '/remove-bg', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok || !data.success) {
          renderError(out, data.error || 'Background removal failed');
          return;
        }
        out.innerHTML = 'URL: <a target="_blank" href="' + data.output.signedUrl + '">' + data.output.signedUrl + '</a>';
        preview.src = data.output.signedUrl;
        preview.style.display = 'block';
      } catch (err) {
        renderError(out, 'Background removal failed: ' + (err.message || String(err)));
      }
    });
  </script>
</body>
</html>`;
