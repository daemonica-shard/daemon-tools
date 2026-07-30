import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import {
  getRemoteConfig,
  type RemoteConfig,
  type RemoteConfigTemplate,
  type Version,
} from "firebase-admin/remote-config";

export interface FirebaseProjectConfig {
  projectId: string;
  serviceAccountPath: string;
}

// firebase-admin apps are process-global and keyed by name; one server hosts several
// projects (WordGame, Sway, ...), so each project gets its own named app.
function getApp(config: FirebaseProjectConfig): App {
  const existing = getApps().find((a) => a.name === config.projectId);
  if (existing) return existing;
  return initializeApp(
    {
      credential: cert(config.serviceAccountPath),
      projectId: config.projectId,
    },
    config.projectId,
  );
}

export class RemoteConfigClient {
  private readonly rc: RemoteConfig;

  constructor(config: FirebaseProjectConfig) {
    this.rc = getRemoteConfig(getApp(config));
  }

  async getTemplate(versionNumber?: string): Promise<RemoteConfigTemplate> {
    return versionNumber
      ? this.rc.getTemplateAtVersion(versionNumber)
      : this.rc.getTemplate();
  }

  async listVersions(pageSize = 50): Promise<Version[]> {
    const result = await this.rc.listVersions({ pageSize });
    return result.versions ?? [];
  }
}
