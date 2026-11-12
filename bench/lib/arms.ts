import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PayPal } from './paypal.js';

export type ArmName = 'official' | 'mcpal';

export const OFFICIAL_PKG = '@paypal/mcp@1.8.1';
const BENCH_DIR = new URL('..', import.meta.url).pathname;
const ROOT = new URL('../..', import.meta.url).pathname;

export interface ArmConn {
  client: Client;
  tools: { name: string; description?: string; inputSchema: any }[];
  close: () => Promise<void>;
  meta: Record<string, string>;
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'NODE_EXTRA_CA_CERTS', 'npm_config_cache']) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

export async function connectArm(arm: ArmName, pp: PayPal, dataDirIn?: string, extraEnv: Record<string, string> = {}): Promise<ArmConn> {
  let transport: StdioClientTransport;
  const meta: Record<string, string> = {};
  if (arm === 'official') {
    const token = await pp.accessToken();
    const env: Record<string, string> = { ...baseEnv(), PAYPAL_ACCESS_TOKEN: token, PAYPAL_ENVIRONMENT: 'SANDBOX' };
    if (process.env.PAYPAL_API_BASE) {
      // mock mode: redirect the toolkit's axios calls to the mock PayPal server
      env.NODE_OPTIONS = `--require ${join(BENCH_DIR, 'lib', 'axios-redirect.cjs')}`;
      env.PAYPAL_API_BASE = process.env.PAYPAL_API_BASE;
    }
    transport = new StdioClientTransport({ command: 'npx', args: ['-y', OFFICIAL_PKG, '--tools=all'], env, stderr: 'ignore' });
    meta.server = `npx -y ${OFFICIAL_PKG} --tools=all`;
  } else {
    // Fresh ledger dir per task run so runs do not share state.
    const dataDir = dataDirIn ?? mkdtempSync(join(tmpdir(), 'mcpal-bench-'));
    mkdirSync(dataDir, { recursive: true });
    const env: Record<string, string> = {
      ...baseEnv(),
      PAYPAL_CLIENT_ID: pp.creds.clientId,
      PAYPAL_CLIENT_SECRET: pp.creds.clientSecret,
      PAYPAL_ENVIRONMENT: 'sandbox',
      PAYPAL_ENV: 'sandbox',
      MCPAL_DATA_DIR: dataDir,
      MCPAL_DB_PATH: join(dataDir, 'mcpal.sqlite'),
      MCPAL_LEDGER_PATH: join(dataDir, 'ledger.sqlite'),
      MCPAL_DECISION_LOG: join(dataDir, 'decisions.jsonl'),
    };
    if (process.env.PAYPAL_API_BASE) env.PAYPAL_BASE_URL = process.env.PAYPAL_API_BASE;
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith('MCPAL_') && v) env[k] = v;
    Object.assign(env, extraEnv);
    const cmd = process.env.MCPAL_CMD ?? join(ROOT, 'node_modules', '.bin', 'tsx');
    const args = process.env.MCPAL_ARGS ? JSON.parse(process.env.MCPAL_ARGS) : [join(ROOT, 'src', 'server.ts')];
    transport = new StdioClientTransport({ command: cmd, args, env, cwd: ROOT, stderr: 'ignore' });
    meta.server = `${cmd} ${args.join(' ')}`;
    meta.dataDir = dataDir;
  }
  const client = new Client({ name: 'mcpal-bench', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, tools: tools as ArmConn['tools'], close: () => client.close(), meta };
}
