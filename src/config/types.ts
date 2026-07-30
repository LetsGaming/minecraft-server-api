/**
 * Resolved configuration shapes. These describe how this process is set up,
 * not what it answers with — the bot-facing response types live in
 * contracts/wire.ts.
 */

export interface InstanceConfig {
  id: string;
  serverPath: string;
  linuxUser: string;
  useRcon: boolean;
  rconHost: string;
  rconPort: number;
  rconPassword: string;
  backupsPath: string;
  /** Directory containing start.sh, shutdown.sh, etc. */
  scriptsDir: string;
}

export interface AppConfig {
  PORT: number;
  API_KEY: string;
  instances: Record<string, InstanceConfig>;
}
