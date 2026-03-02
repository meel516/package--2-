import express from "express";
import {processApiRequest} from "./index";
import type {APIGatewayProxyStructuredResultV2} from "aws-lambda";

const app = express();
const port = parseInt(process.env.PORT || "3003", 10);

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

app.post("/add-music", async (req, res) => {
  const result = await processApiRequest("POST", "/add-music", req.body || {});
  sendResult(res, result);
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
