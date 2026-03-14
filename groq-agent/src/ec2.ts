import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import {getS3ToolsInfo, processApiRequest} from "./index";
import type {APIGatewayProxyStructuredResultV2} from "aws-lambda";

const app = express();
const port = parseInt(process.env.PORT || "3003", 10);
const upload = multer({storage: multer.memoryStorage()});
const fileRoot = path.resolve(process.env.FILE_MANAGER_ROOT || process.cwd());
const assetsDirName = "assets";
const musicDirName = "music";

void ensureDefaultRepoDirs();

app.use(express.json({limit: "50mb"}));
app.use("/assets", express.static(path.join(fileRoot, assetsDirName)));
app.use("/music", express.static(path.join(fileRoot, musicDirName)));

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
    payload.imageBuffer = file.buffer;
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
    payload.imageBuffer = file.buffer;
    payload.mimeType = file.mimetype || "image/png";
  }

  const result = await processApiRequest("POST", "/remove-bg", payload);
  sendResult(res, result);
});

app.post("/remove-bg-asset", upload.any(), async (req, res) => {
  const payload: Record<string, unknown> = {
    ...(req.body || {}),
  };

  const file = firstUploadedFile(req);
  if (file?.buffer?.length) {
    payload.imageBuffer = file.buffer;
    payload.mimeType = file.mimetype || "image/png";
  }

  const result = await processApiRequest("POST", "/remove-bg-asset", payload);
  sendResult(res, result);
});

app.post("/testing", async (req, res) => {
  const result = await processApiRequest("POST", "/testing", req.body || {});
  sendResult(res, result);
});

app.post("/add-music", upload.single("video"), async (req, res) => {
  const payload: Record<string, unknown> = {
    ...(req.body || {}),
  };

  if (req.file?.buffer?.length) {
    payload.videoBuffer = req.file.buffer;
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

app.get("/s3-files", async (req, res) => {
  try {
    const prefix = String(req.query.prefix || "").trim();
    const limit = parseInt(String(req.query.limit || "100"), 10);
    const info = await getS3ToolsInfo(prefix || undefined, Number.isFinite(limit) ? limit : 100);
    res.status(200).json({success: true, ...info});
  } catch (error: any) {
    res.status(400).json({success: false, error: error?.message || "Failed to list S3 files"});
  }
});

app.get("/files", async (req, res) => {
  try {
    const relativePath = String(req.query.path || ".");
    const absolutePath = resolveSafePath(relativePath);
    const entries = await fs.readdir(absolutePath, {withFileTypes: true});
    const payload = await Promise.all(
      entries
        .filter((entry) => entry.name !== "." && entry.name !== "..")
        .map(async (entry) => {
          const fullPath = path.join(absolutePath, entry.name);
          const stats = await fs.stat(fullPath);
          return {
            name: entry.name,
            path: normalizeRelativePath(path.relative(fileRoot, fullPath)),
            type: entry.isDirectory() ? "dir" : "file",
            size: stats.size,
            modifiedAt: stats.mtime.toISOString(),
          };
        })
    );

    payload.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "dir" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    res.status(200).json({
      success: true,
      root: fileRoot,
      currentPath: normalizeRelativePath(path.relative(fileRoot, absolutePath)),
      entries: payload,
    });
  } catch (error: any) {
    res.status(400).json({success: false, error: error?.message || "Failed to list files"});
  }
});

app.get("/file-content", async (req, res) => {
  try {
    const relativePath = String(req.query.path || "");
    if (!relativePath) {
      res.status(400).json({success: false, error: "Missing file path"});
      return;
    }

    const absolutePath = resolveSafePath(relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    res.status(200).json({
      success: true,
      path: normalizeRelativePath(path.relative(fileRoot, absolutePath)),
      content,
    });
  } catch (error: any) {
    res.status(400).json({success: false, error: error?.message || "Failed to read file"});
  }
});

app.post("/files/mkdir", async (req, res) => {
  try {
    const relativePath = String(req.body?.path || "");
    if (!relativePath) {
      res.status(400).json({success: false, error: "Missing folder path"});
      return;
    }

    const absolutePath = resolveSafePath(relativePath);
    await fs.mkdir(absolutePath, {recursive: true});
    res.status(200).json({success: true});
  } catch (error: any) {
    res.status(400).json({success: false, error: error?.message || "Failed to create folder"});
  }
});

app.post("/files/write", async (req, res) => {
  try {
    const relativePath = String(req.body?.path || "");
    if (!relativePath) {
      res.status(400).json({success: false, error: "Missing file path"});
      return;
    }

    const absolutePath = resolveSafePath(relativePath);
    await fs.mkdir(path.dirname(absolutePath), {recursive: true});
    await fs.writeFile(absolutePath, String(req.body?.content || ""), "utf8");
    res.status(200).json({success: true});
  } catch (error: any) {
    res.status(400).json({success: false, error: error?.message || "Failed to write file"});
  }
});

app.post("/files/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) {
      res.status(400).json({success: false, error: "Missing file upload"});
      return;
    }

    const directoryPath = String(req.body?.path || ".");
    const name = String(req.body?.name || req.file.originalname || "upload.bin");
    const absoluteDir = resolveSafePath(directoryPath);
    await fs.mkdir(absoluteDir, {recursive: true});

    const absolutePath = resolveSafePath(path.join(directoryPath, name));
    await fs.writeFile(absolutePath, req.file.buffer);
    res.status(200).json({
      success: true,
      path: normalizeRelativePath(path.relative(fileRoot, absolutePath)),
    });
  } catch (error: any) {
    res.status(400).json({success: false, error: error?.message || "Failed to upload file"});
  }
});

app.delete("/files", async (req, res) => {
  try {
    const relativePath = String(req.body?.path || "");
    if (!relativePath) {
      res.status(400).json({success: false, error: "Missing path"});
      return;
    }

    const absolutePath = resolveSafePath(relativePath);
    const stats = await fs.stat(absolutePath);

    if (stats.isDirectory()) {
      await fs.rm(absolutePath, {recursive: true, force: true});
    } else {
      await fs.unlink(absolutePath);
    }

    res.status(200).json({success: true});
  } catch (error: any) {
    res.status(400).json({success: false, error: error?.message || "Failed to delete path"});
  }
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

function resolveSafePath(relativePath: string): string {
  const requested = relativePath && relativePath !== "." ? relativePath : ".";
  const resolved = path.resolve(fileRoot, requested);

  if (resolved !== fileRoot && !resolved.startsWith(`${fileRoot}${path.sep}`)) {
    throw new Error("Path is outside allowed root");
  }

  return resolved;
}

function normalizeRelativePath(p: string): string {
  if (!p || p === ".") {
    return ".";
  }
  return p.split(path.sep).join("/");
}

async function ensureDefaultRepoDirs(): Promise<void> {
  try {
    await fs.mkdir(path.join(fileRoot, assetsDirName), {recursive: true});
    await fs.mkdir(path.join(fileRoot, musicDirName), {recursive: true});
  } catch (error) {
    console.warn("Failed to create default repo directories", error);
  }
}

const TOOLS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tools</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 24px; background: #f4f7fb; color: #0f172a; }
    .wrap { max-width: 1100px; margin: 0 auto; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; margin-bottom: 18px; }
    h1 { margin: 0 0 16px; font-size: 28px; }
    h2 { margin: 0 0 10px; font-size: 20px; }
    h3 { margin: 10px 0; font-size: 16px; }
    label { display: block; margin: 10px 0 6px; font-weight: 600; }
    input[type="text"], input[type="file"], textarea { width: 100%; padding: 10px; box-sizing: border-box; }
    textarea { min-height: 240px; font-family: Consolas, monospace; }
    button { margin-top: 8px; margin-right: 8px; padding: 9px 13px; border: 0; border-radius: 8px; background: #0f172a; color: #fff; cursor: pointer; }
    button:hover { background: #1e293b; }
    .btn-danger { background: #b91c1c; }
    .btn-danger:hover { background: #991b1b; }
    .out { margin-top: 12px; padding: 10px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; word-break: break-all; }
    img { max-width: 280px; max-height: 280px; border: 1px solid #cbd5e1; border-radius: 8px; margin-top: 10px; background: #fff; }
    .error { color: #b91c1c; }
    .grid { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
    .mono { font-family: Consolas, monospace; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border-bottom: 1px solid #e2e8f0; padding: 8px; text-align: left; font-size: 13px; }
    .clickable { color: #1d4ed8; cursor: pointer; text-decoration: underline; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>API Tools</h1>
    <div class="card">
      <label for="apiBase">API Base URL</label>
      <input id="apiBase" type="text" placeholder="https://your-api-domain.com" />
    </div>

    <div class="card">
      <h2>Image Upload</h2>
      <div class="grid">
        <div>
          <h3>Upload Image And Get URL</h3>
          <input id="normalImage" type="file" accept="image/*" />
          <button id="uploadBtn">Upload Image</button>
          <div id="uploadOut" class="out"></div>
        </div>
        <div>
          <h3>Remove Background And Get URL</h3>
          <input id="bgImage" type="file" accept="image/*" />
          <button id="removeBtn">Remove Background</button>
          <div id="removeOut" class="out"></div>
          <img id="preview" alt="Result preview" style="display:none;" />
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Testing (Base64)</h2>
      <div class="grid">
        <div>
          <label for="testingImage">Choose Image</label>
          <input id="testingImage" type="file" accept="image/*" />
          <button id="testingBtn">Run /testing</button>
        </div>
        <div>
          <div id="testingOut" class="out"></div>
          <img id="testingPreview" alt="Testing preview" style="display:none;" />
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Repo File Manager</h2>
      <div class="mono">Current path: <span id="currentPath">.</span></div>
      <button id="upBtn">Go Up</button>
      <button id="refreshBtn">Refresh</button>
      <button id="assetsBtn">Open /assets</button>
      <button id="musicBtn">Open /music</button>
      <table>
        <thead>
          <tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th><th>Action</th></tr>
        </thead>
        <tbody id="fileRows"></tbody>
      </table>
      <div id="fileOut" class="out"></div>
    </div>

    <div class="card">
      <h2>S3 Bucket Browser</h2>
      <div class="grid">
        <div>
          <label for="s3PrefixInput">S3 Prefix</label>
          <input id="s3PrefixInput" type="text" placeholder="example: music" />
          <label for="s3LimitInput">Max Files</label>
          <input id="s3LimitInput" type="text" value="100" />
          <button id="s3RefreshBtn">Refresh S3 Files</button>
          <div id="s3InfoOut" class="out"></div>
        </div>
        <div>
          <table>
            <thead>
              <tr><th>Key</th><th>Size</th><th>Modified</th></tr>
            </thead>
            <tbody id="s3Rows"></tbody>
          </table>
          <div id="s3Out" class="out"></div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Create Or Upload</h2>
      <div class="grid">
        <div>
          <label for="newFolderPath">New Folder Path</label>
          <input id="newFolderPath" type="text" placeholder="example: src/new-folder" />
          <button id="mkdirBtn">Create Folder</button>

          <label for="uploadFile">Upload File</label>
          <input id="uploadFile" type="file" />
          <label for="uploadDir">Upload Target Folder</label>
          <input id="uploadDir" type="text" placeholder="example: assets or music" value="assets" />
          <button id="uploadFileBtn">Upload File To Repo</button>
        </div>
        <div>
          <label for="editPath">File Path</label>
          <input id="editPath" type="text" placeholder="example: src/example.txt" />
          <label for="editContent">File Content</label>
          <textarea id="editContent"></textarea>
          <button id="readFileBtn">Load File</button>
          <button id="saveFileBtn">Save File</button>
          <button id="deletePathBtn" class="btn-danger">Delete Path</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    const apiBaseInput = document.getElementById('apiBase');
    apiBaseInput.value = window.location.origin;
    let activePath = '.';

    function getApiBase() {
      const v = apiBaseInput.value.trim();
      return v || window.location.origin;
    }

    function renderError(el, message) {
      el.innerHTML = '<div class="error">' + message + '</div>';
    }

    function buildPublicFileUrl(relativePath) {
      const cleaned = String(relativePath || '').replace(/^\\/+/, '');
      const encoded = cleaned.split('/').map(encodeURIComponent).join('/');
      return getApiBase() + '/' + encoded;
    }

    function showMessage(message, isError = false) {
      const out = document.getElementById('fileOut');
      out.innerHTML = isError ? '<div class="error">' + message + '</div>' : message;
    }

    async function listS3Files() {
      const prefixInput = document.getElementById('s3PrefixInput');
      const limitInput = document.getElementById('s3LimitInput');
      const infoOut = document.getElementById('s3InfoOut');
      const out = document.getElementById('s3Out');
      const rows = document.getElementById('s3Rows');
      const prefix = prefixInput.value.trim();
      const limit = limitInput.value.trim() || '100';
      rows.innerHTML = '';
      out.textContent = 'Loading S3 files...';

      try {
        const query = '?prefix=' + encodeURIComponent(prefix) + '&limit=' + encodeURIComponent(limit);
        const res = await fetch(getApiBase() + '/s3-files' + query);
        const data = await res.json();
        if (!res.ok || !data.success) {
          infoOut.innerHTML = '<div class="error">' + (data.error || 'Failed to list S3 files') + '</div>';
          out.innerHTML = '';
          return;
        }

        const bucketInfo =
          'Bucket: <b>' + String(data.bucket || '(missing S3_BUCKET)') + '</b><br>' +
          'Region: <b>' + String(data.region || '') + '</b><br>' +
          'MUSIC_PREFIX: <b>' + String(data.musicPrefix || '') + '</b><br>' +
          'S3_PREFIX: <b>' + String(data.s3Prefix || '') + '</b><br>' +
          'Used Prefix: <b>' + String(data.effectivePrefix || '(root)') + '</b>';
        infoOut.innerHTML = bucketInfo;

        for (const item of data.files || []) {
          const tr = document.createElement('tr');
          const keyCell = document.createElement('td');
          keyCell.textContent = String(item.key || '');
          const sizeCell = document.createElement('td');
          sizeCell.textContent = String(item.size || 0);
          const modCell = document.createElement('td');
          modCell.textContent = String(item.lastModified || '');
          tr.appendChild(keyCell);
          tr.appendChild(sizeCell);
          tr.appendChild(modCell);
          rows.appendChild(tr);
        }

        out.textContent = 'Listed ' + String(data.totalReturned || 0) + ' S3 files.';
      } catch (err) {
        infoOut.innerHTML = '<div class="error">Failed to list S3 files: ' + (err.message || String(err)) + '</div>';
        out.textContent = '';
      }
    }

    async function listFiles(pathValue) {
      try {
        const res = await fetch(getApiBase() + '/files?path=' + encodeURIComponent(pathValue || '.'));
        const data = await res.json();
        if (!res.ok || !data.success) {
          showMessage(data.error || 'Failed to list files', true);
          return;
        }

        activePath = data.currentPath || '.';
        document.getElementById('currentPath').textContent = activePath;
        const rows = document.getElementById('fileRows');
        rows.innerHTML = '';

        for (const item of data.entries) {
          const tr = document.createElement('tr');
          const nameCell = document.createElement('td');
          if (item.type === 'dir') {
            nameCell.innerHTML = '<span class="clickable">' + item.name + '</span>';
            nameCell.firstChild.addEventListener('click', () => listFiles(item.path));
          } else {
            nameCell.textContent = item.name;
          }

          const typeCell = document.createElement('td');
          typeCell.textContent = item.type;
          const sizeCell = document.createElement('td');
          sizeCell.textContent = String(item.size);
          const modCell = document.createElement('td');
          modCell.textContent = item.modifiedAt;
          const actionCell = document.createElement('td');

          const openBtn = document.createElement('button');
          openBtn.textContent = item.type === 'dir' ? 'Open' : 'Edit';
          openBtn.addEventListener('click', async () => {
            if (item.type === 'dir') {
              await listFiles(item.path);
              return;
            }
            document.getElementById('editPath').value = item.path;
            await loadFile(item.path);
          });

          const delBtn = document.createElement('button');
          delBtn.textContent = 'Delete';
          delBtn.className = 'btn-danger';
          delBtn.addEventListener('click', async () => {
            if (!confirm('Delete ' + item.path + '?')) return;
            await deletePath(item.path);
            await listFiles(activePath);
          });

          actionCell.appendChild(openBtn);
          if (item.type === 'file' && (item.path.startsWith('assets/') || item.path.startsWith('music/'))) {
            const linkBtn = document.createElement('button');
            linkBtn.textContent = 'Link';
            linkBtn.addEventListener('click', () => {
              const link = buildPublicFileUrl(item.path);
              showMessage('Link: <a target="_blank" href="' + link + '">' + link + '</a>');
            });
            actionCell.appendChild(linkBtn);
          }
          actionCell.appendChild(delBtn);

          tr.appendChild(nameCell);
          tr.appendChild(typeCell);
          tr.appendChild(sizeCell);
          tr.appendChild(modCell);
          tr.appendChild(actionCell);
          rows.appendChild(tr);
        }

        showMessage('Listed ' + data.entries.length + ' items.');
      } catch (err) {
        showMessage('Failed to list files: ' + (err.message || String(err)), true);
      }
    }

    async function loadFile(filePath) {
      try {
        const res = await fetch(getApiBase() + '/file-content?path=' + encodeURIComponent(filePath));
        const data = await res.json();
        if (!res.ok || !data.success) {
          showMessage(data.error || 'Failed to read file', true);
          return;
        }
        document.getElementById('editPath').value = data.path;
        document.getElementById('editContent').value = data.content;
        showMessage('Loaded ' + data.path);
      } catch (err) {
        showMessage('Failed to read file: ' + (err.message || String(err)), true);
      }
    }

    async function saveFile() {
      const filePath = document.getElementById('editPath').value.trim();
      const content = document.getElementById('editContent').value;
      if (!filePath) {
        showMessage('File path is required', true);
        return;
      }

      const res = await fetch(getApiBase() + '/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showMessage(data.error || 'Failed to save file', true);
        return;
      }
      showMessage('Saved ' + filePath);
      await listFiles(activePath);
    }

    async function deletePath(targetPath) {
      const res = await fetch(getApiBase() + '/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: targetPath })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showMessage(data.error || 'Failed to delete path', true);
        return;
      }
      showMessage('Deleted ' + targetPath);
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

    document.getElementById('testingBtn').addEventListener('click', async () => {
      const out = document.getElementById('testingOut');
      const preview = document.getElementById('testingPreview');
      const fileInput = document.getElementById('testingImage');
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        renderError(out, 'Please choose an image file.');
        return;
      }

      out.textContent = 'Running testing endpoint...';
      preview.style.display = 'none';
      try {
        const b64 = await fileToBase64(file);
        const res = await fetch(getApiBase() + '/testing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: b64, mimeType: file.type || 'image/png' })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          renderError(out, data.error || 'Testing failed');
          return;
        }

        const dataUrl = 'data:image/png;base64,' + data.output.imageBase64;
        out.innerHTML = 'Success. Base64 length: ' + data.output.imageBase64.length;
        preview.src = dataUrl;
        preview.style.display = 'block';
      } catch (err) {
        renderError(out, 'Testing failed: ' + (err.message || String(err)));
      }
    });

    document.getElementById('refreshBtn').addEventListener('click', () => listFiles(activePath));
    document.getElementById('upBtn').addEventListener('click', () => {
      if (activePath === '.') return listFiles('.');
      const parts = activePath.split('/');
      parts.pop();
      listFiles(parts.length ? parts.join('/') : '.');
    });
    document.getElementById('assetsBtn').addEventListener('click', () => listFiles('assets'));
    document.getElementById('musicBtn').addEventListener('click', () => listFiles('music'));
    document.getElementById('s3RefreshBtn').addEventListener('click', listS3Files);

    document.getElementById('mkdirBtn').addEventListener('click', async () => {
      const folderPath = document.getElementById('newFolderPath').value.trim();
      if (!folderPath) {
        showMessage('Folder path is required', true);
        return;
      }
      const res = await fetch(getApiBase() + '/files/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folderPath })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showMessage(data.error || 'Failed to create folder', true);
        return;
      }
      showMessage('Created folder ' + folderPath);
      await listFiles(activePath);
    });

    document.getElementById('uploadFileBtn').addEventListener('click', async () => {
      const fileInput = document.getElementById('uploadFile');
      const targetDir = document.getElementById('uploadDir').value.trim() || activePath;
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        showMessage('Choose a file to upload', true);
        return;
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('path', targetDir);
      formData.append('name', file.name);

      const res = await fetch(getApiBase() + '/files/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showMessage(data.error || 'Failed to upload file', true);
        return;
      }
      showMessage('Uploaded to ' + data.path);
      await listFiles(activePath);
    });

    document.getElementById('readFileBtn').addEventListener('click', async () => {
      const filePath = document.getElementById('editPath').value.trim();
      if (!filePath) {
        showMessage('File path is required', true);
        return;
      }
      await loadFile(filePath);
    });

    document.getElementById('saveFileBtn').addEventListener('click', saveFile);

    document.getElementById('deletePathBtn').addEventListener('click', async () => {
      const targetPath = document.getElementById('editPath').value.trim();
      if (!targetPath) {
        showMessage('Path is required', true);
        return;
      }
      if (!confirm('Delete ' + targetPath + '?')) return;
      await deletePath(targetPath);
      await listFiles(activePath);
    });

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const raw = String(reader.result || '');
          const value = raw.includes(',') ? raw.split(',').pop() : raw;
          resolve(value);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    listFiles('.');
    listS3Files();
  </script>
</body>
</html>`;
