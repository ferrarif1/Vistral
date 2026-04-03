import { createServer } from 'node:http';

interface RuntimeRequest {
  framework?: 'paddleocr' | 'doctr' | 'yolo';
  model_id?: string;
  model_version_id?: string;
  input_attachment_id?: string;
  filename?: string;
  task_type?: 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb';
}

const host = process.env.RUNTIME_MOCK_HOST ?? '127.0.0.1';
const port = Number(process.env.RUNTIME_MOCK_PORT ?? 9393);

const json = (statusCode: number, payload: unknown, res: import('node:http').ServerResponse): void => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

const readBody = async (req: import('node:http').IncomingMessage): Promise<RuntimeRequest> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw) as RuntimeRequest;
};

const buildPayload = (body: RuntimeRequest) => {
  const framework = body.framework ?? 'yolo';
  const taskType = body.task_type ?? 'classification';
  const filename = body.filename ?? 'runtime-input.jpg';

  const base = {
    framework,
    image: {
      filename,
      width: 1280,
      height: 720
    }
  } as Record<string, unknown>;

  if (taskType === 'ocr') {
    return {
      ...base,
      lines: [
        { text: `${framework.toUpperCase()} runtime line #1`, confidence: 0.95 },
        { text: `${framework.toUpperCase()} runtime line #2`, confidence: 0.92 }
      ],
      words: [
        { text: 'runtime', confidence: 0.96 },
        { text: 'ocr', confidence: 0.93 }
      ]
    };
  }

  if (taskType === 'detection') {
    return {
      ...base,
      boxes: [
        { x: 180, y: 210, width: 170, height: 110, label: 'defect', score: 0.91 },
        { x: 540, y: 360, width: 200, height: 120, label: 'scratch', score: 0.87 }
      ]
    };
  }

  if (taskType === 'segmentation') {
    return {
      ...base,
      polygons: [
        {
          label: 'region',
          score: 0.86,
          points: [
            { x: 140, y: 100 },
            { x: 320, y: 150 },
            { x: 280, y: 340 },
            { x: 120, y: 300 }
          ]
        }
      ],
      masks: [{ label: 'region', score: 0.86, encoding: 'runtime-rle' }]
    };
  }

  if (taskType === 'obb') {
    return {
      ...base,
      rotated_boxes: [
        {
          cx: 340,
          cy: 250,
          width: 220,
          height: 100,
          angle: 18,
          label: 'rotated-target',
          score: 0.9
        }
      ]
    };
  }

  return {
    ...base,
    labels: [
      { label: 'normal', score: 0.79 },
      { label: 'abnormal', score: 0.21 }
    ]
  };
};

const server = createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) {
      return json(404, { error: 'not_found' }, res);
    }

    if (req.url === '/health' && req.method === 'GET') {
      return json(200, { status: 'ok' }, res);
    }

    if (req.url === '/predict' && req.method === 'POST') {
      const body = await readBody(req);
      return json(200, buildPayload(body), res);
    }

    return json(404, { error: 'not_found' }, res);
  } catch (error) {
    return json(500, { error: (error as Error).message }, res);
  }
});

server.listen(port, host, () => {
  console.log(`[runtime-mock] listening on http://${host}:${port}`);
});
