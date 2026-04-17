import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_HOST = 'localhost';

export interface TiltApiConfig {
  server: string;
  certHost: string;
  ca: Buffer;
  token: string;
}

interface KubeConfigFile {
  clusters?: Array<{
    cluster?: {
      server?: string;
      'certificate-authority-data'?: string;
    };
  }>;
  users?: Array<{
    user?: {
      token?: string;
    };
  }>;
}

export function loadTiltApiConfig(): TiltApiConfig {
  const configPath =
    process.env['TILT_DEV_CONFIG'] ?? join(homedir(), '.tilt-dev', 'config');

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read Tilt API config at ${configPath}. Is Tilt running? (${String(err)})`
    );
  }

  const kube = parse(raw) as KubeConfigFile;
  const server = kube.clusters?.[0]?.cluster?.server;
  const caData = kube.clusters?.[0]?.cluster?.['certificate-authority-data'];
  const token = kube.users?.[0]?.user?.token;

  if (!server || !caData || !token) {
    throw new Error(
      `Tilt API config at ${configPath} is missing required fields (server, certificate-authority-data, or token)`
    );
  }

  // Replace the hostname from the kubeconfig with TILT_HOST so the Docker
  // container can reach the host machine via host.docker.internal.
  // Preserve the original hostname as certHost for TLS servername verification,
  // since the cert SANs are issued against localhost/127.0.0.1, not the Docker host.
  const host = process.env['TILT_HOST'] ?? DEFAULT_HOST;
  const serverUrl = new URL(server);
  const certHost = serverUrl.hostname;
  serverUrl.hostname = host;

  return {
    server: serverUrl.toString().replace(/\/$/, ''),
    certHost,
    ca: Buffer.from(caData, 'base64'),
    token,
  };
}
