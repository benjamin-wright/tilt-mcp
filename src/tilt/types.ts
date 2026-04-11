export interface UIResourceStatus {
  buildHistory: BuildRecord[];
  currentBuild: BuildRecord;
  runtimeStatus: string;
  k8sResourceInfo?: K8sResourceInfo;
  localResourceInfo?: LocalResourceInfo;
}

export interface BuildRecord {
  startTime: string;
  finishTime?: string;
  error?: string;
  warnings?: string[];
  isCrashRebuild?: boolean;
}

export interface K8sResourceInfo {
  podName: string;
  podPhase: string;
  podStatus: string;
  podStatusMessage?: string;
}

export interface LocalResourceInfo {
  pid: number;
  isTest: boolean;
}

export interface UIResource {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    creationTimestamp: string;
  };
  status: UIResourceStatus;
}

export interface UIResourceList {
  apiVersion: string;
  kind: string;
  items: UIResource[];
}

export interface UISessionStatus {
  startTime: string;
  tiltfileKey?: string;
  featureFlags: Record<string, boolean>;
  fatalError?: string;
  pid: number;
  runningTiltBuild: {
    version: string;
    commitSHA: string;
    dev: boolean;
  };
}

export interface UISession {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    creationTimestamp: string;
  };
  status: UISessionStatus;
}
