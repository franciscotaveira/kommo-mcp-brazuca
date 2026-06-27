import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { KommoAPI } from './kommo-api.js';
import { MCP_TOOLS } from './mcp/tool-definitions.js';
import { executeTool } from './mcp/tool-handlers.js';
import { MCP_RESOURCES, isKnownResource, readResource } from './mcp/resources.js';
import { MCP_PROMPTS, isKnownPrompt, getPromptMessages } from './mcp/prompts.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const logLevel = process.env.LOG_LEVEL || 'info';

const logger = {
  info: (message: string, data?: unknown) => {
    if (logLevel === 'info' || logLevel === 'debug') {
      console.log(`[${new Date().toISOString()}] INFO: ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
  },
  debug: (message: string, data?: unknown) => {
    if (logLevel === 'debug') {
      console.log(`[${new Date().toISOString()}] DEBUG: ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
  },
  error: (message: string, error?: unknown) => {
    console.error(`[${new Date().toISOString()}] ERROR: ${message}`, error);
  },
};

// ── Mapa de workspaces a partir das variáveis de ambiente ──
const WORKSPACES: Record<string, { url: string; token: string }> = {
  smart: {
    url: process.env.KOMMO_BASE_URL || 'https://videographerseua.kommo.com',
    token: process.env.KOMMO_ACCESS_TOKEN || '',
  },
  amavi: {
    url: process.env.KOMMO_AMAVI_URL || '',
    token: process.env.KOMMO_AMAVI_TOKEN || '',
  },
  manakadett: {
    url: process.env.KOMMO_MANAKADETT_URL || '',
    token: process.env.KOMMO_MANAKADETT_TOKEN || '',
  },
};

// ── Workspace ativa por sessão ──
const sessionWorkspaces = new Map<string, string>();

function getWorkspaceName(sessionId: string): string {
  return sessionWorkspaces.get(sessionId) || 'smart';
}

function getKommoAPIForSession(sessionId: string): KommoAPI {
  const name = getWorkspaceName(sessionId);
  const ws = WORKSPACES[name] || WORKSPACES['smart'];
  return new KommoAPI({ baseUrl: ws.url, accessToken: ws.token });
}

// ── Tool extra: switch_workspace ──
const SWITCH_WORKSPACE_TOOL = {
  name: 'switch_workspace',
  description: 'Troca a workspace ativa do Kommo. Workspaces disponíveis: smart, amavi, manakadett.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace: {
        type: 'string',
        description: 'Nome da workspace: smart, amavi ou manakadett',
        enum: Object.keys(WORKSPACES),
      },
    },
    required: ['workspace'],
  },
};

app.use(cors());
app.use(express.json());

// ── Health check ──
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '2.2.0',
    mode: 'multi-workspace',
    workspaces: Object.keys(WORKSPACES),
    tools_count: MCP_TOOLS.length + 1,
    resources_count: MCP_RESOURCES.length,
    prompts_count: MCP_PROMPTS.length,
  });
});

const MCP_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05', '2025-11-25'];
const mcpSessions = new Map<string, { initialized: boolean }>();

function getOrCreateSession(sessionId: string | undefined): { id: string; initialized: boolean } {
  const id = sessionId || 'default';
  if (!mcpSessions.has(id)) {
    mcpSessions.set(id, { initialized: false });
  }
  return { id, ...mcpSessions.get(id)! };
}

function sendMcpResponse(res: express.Response, payload: object, req: express.Request): void {
  const accept = (req.headers['accept'] || '').toLowerCase();
  if (accept.includes('application/json') && !accept.includes('text/event-stream')) {
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(payload);
  } else {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, MCP-Protocol-Version, MCP-Session-Id, Authorization, X-API-Key');
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.end();
  }
}

app.post('/mcp', async (req, res) => {
  logger.info('Requisição MCP Kommo Multi-Workspace v2.2.0');

  const authToken = process.env.MCP_AUTH_TOKEN;
  if (authToken) {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const apiKey = req.headers['x-api-key'];
    if ((bearer || apiKey) !== authToken) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' } });
      return;
    }
  }

  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request' } });
      return;
    }

    const { method, params, id } = body;
    const sessionId = (req.headers['mcp-session-id'] as string) || 'default';

    if (method !== 'initialize') {
      const protocolVersion = req.headers['mcp-protocol-version'] as string | undefined;
      if (!protocolVersion || !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Missing or unsupported MCP-Protocol-Version header' },
        });
        return;
      }
    }

    if (id === undefined && method !== undefined) {
      if (method === 'notifications/initialized') {
        const session = getOrCreateSession(sessionId);
        mcpSessions.set(session.id, { initialized: true });
      }
      res.status(202).end();
      return;
    }

    if (method === 'initialize') {
      const newSessionId = crypto.randomUUID();
      mcpSessions.set(newSessionId, { initialized: false });
      sessionWorkspaces.set(newSessionId, 'smart'); // padrão: GRUPO SMART
      const initResponse = {
        jsonrpc: '2.0' as const,
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: {
            name: 'kommo-mcp-server',
            version: '2.2.0',
            description: 'MCP Multi-Workspace Kommo — Grupo Brazucas. Use switch_workspace para trocar de cliente.',
          },
        },
      };
      res.setHeader('MCP-Session-Id', newSessionId);
      sendMcpResponse(res, initResponse, req);
      return;
    }

    if (method === 'notifications/initialized') {
      mcpSessions.set(sessionId, { initialized: true });
      res.status(202).end();
      return;
    }

    if (method === 'tools/list') {
      const allTools = [...MCP_TOOLS, SWITCH_WORKSPACE_TOOL];
      sendMcpResponse(res, { jsonrpc: '2.0', id, result: { tools: allTools } }, req);
      return;
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;

      // ── Tool especial: switch_workspace ──
      if (name === 'switch_workspace') {
        const wsName = args?.workspace as string;
        if (!WORKSPACES[wsName]) {
          sendMcpResponse(res, {
            jsonrpc: '2.0', id,
            result: {
              content: [{ type: 'text', text: `Workspace "${wsName}" não encontrada. Disponíveis: ${Object.keys(WORKSPACES).join(', ')}` }],
              isError: true,
            },
          }, req);
          return;
        }
        sessionWorkspaces.set(sessionId, wsName);
        const ws = WORKSPACES[wsName];
        sendMcpResponse(res, {
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text: `✅ Workspace trocada para "${wsName}" (${ws.url})` }],
          },
        }, req);
        return;
      }

      // ── Demais tools — usa workspace da sessão ──
      const kommoAPI = getKommoAPIForSession(sessionId);
      try {
        const result = await executeTool(kommoAPI, name, args);
        sendMcpResponse(res, { jsonrpc: '2.0', id, result }, req);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal error';
        if (message.startsWith('Unknown tool:')) {
          sendMcpResponse(res, { jsonrpc: '2.0', id, error: { code: -32601, message } }, req);
        } else {
          sendMcpResponse(res, {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text' as const, text: message }], isError: true },
          }, req);
        }
      }
      return;
    }

    if (method === 'resources/list') {
      sendMcpResponse(res, { jsonrpc: '2.0', id, result: { resources: MCP_RESOURCES } }, req);
      return;
    }

    if (method === 'resources/read') {
      const uri = params?.uri as string | undefined;
      if (!uri || !isKnownResource(uri)) {
        sendMcpResponse(res, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown resource URI' } }, req);
        return;
      }
      try {
        const kommoAPI = getKommoAPIForSession(sessionId);
        const text = await readResource(kommoAPI, uri);
        sendMcpResponse(res, { jsonrpc: '2.0', id, result: { contents: [{ uri, mimeType: 'application/json', text }] } }, req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to read resource';
        sendMcpResponse(res, { jsonrpc: '2.0', id, result: { content: [{ type: 'text' as const, text: msg }], isError: true } }, req);
      }
      return;
    }

    if (method === 'prompts/list') {
      sendMcpResponse(res, { jsonrpc: '2.0', id, result: { prompts: MCP_PROMPTS } }, req);
      return;
    }

    if (method === 'prompts/get') {
      const promptName = params?.name as string | undefined;
      if (!promptName || !isKnownPrompt(promptName)) {
        sendMcpResponse(res, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown prompt name' } }, req);
        return;
      }
      sendMcpResponse(res, { jsonrpc: '2.0', id, result: { messages: getPromptMessages(promptName) } }, req);
      return;
    }

    sendMcpResponse(res, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }, req);
  } catch (error) {
    logger.error('Erro no endpoint MCP', error);
    res.status(500).json({ jsonrpc: '2.0', id: req.body?.id || 1, error: { code: -32603, message: 'Internal error' } });
  }
});

app.options('/mcp', (_req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, MCP-Protocol-Version, MCP-Session-Id, Authorization, X-API-Key');
  res.sendStatus(200);
});

// ✅ 0.0.0.0 para funcionar no Render
const HOST = process.env.MCP_HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  logger.info(`Servidor MCP Kommo v2.2.0 Multi-Workspace rodando em http://${HOST}:${PORT}`, {
    workspaces: Object.keys(WORKSPACES),
    tools: MCP_TOOLS.length + 1,
    resources: MCP_RESOURCES.length,
    prompts: MCP_PROMPTS.length,
  });
});
