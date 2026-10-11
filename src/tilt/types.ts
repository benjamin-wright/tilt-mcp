export interface KubeList<T> {
  metadata?: { resourceVersion?: string };
  items: T[];
}

export interface WatchEvent<T> {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'ERROR';
  object: T;
}

export interface BuildRecord {
  startTime: string;
  finishTime?: string;
  error?: string;
  spanID?: string;
  warnings?: string[];
  isCrashRebuild?: boolean;
}

export interface UIResourceStatus {
  buildHistory?: BuildRecord[];
  currentBuild?: { startTime: string };
  queued?: boolean;
  runtimeStatus?: string;
  updateStatus?: string;
  lastDeployTime?: string;
}

export interface UIResource {
  metadata: {
    name: string;
    creationTimestamp?: string;
  };
  status: UIResourceStatus;
}

export interface UISessionStatus {
  tiltStartTime?: string;
  tiltfileKey?: string;
  fatalError?: string;
  runningTiltBuild?: {
    version: string;
    date?: string;
    dev?: boolean;
  };
  suggestedTiltVersion?: string;
  featureFlags?: Array<{ name: string; value?: boolean }>;
}

export interface UISession {
  metadata: {
    name: string;
    creationTimestamp?: string;
  };
  status: UISessionStatus;
}

export interface LogSegment {
  spanId?: string;
  time?: string;
  text: string;
  level?: string;
}

export interface LogList {
  fromCheckpoint?: number;
  toCheckpoint?: number;
  segments: LogSegment[];
  spans?: Record<string, { manifestName?: string }>;
}

export interface TiltView {
  uiResources: UIResource[];
  uiSession: UISession;
  logList?: LogList;
  tiltStartTime?: string;
  isComplete?: boolean;
}
